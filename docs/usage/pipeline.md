---
layout: doc
title: Pipeline
---

# Pipeline

The pipeline is an ordered async middleware queue. Each task receives `(next, state)` and calls `next()` to hand off to the next task. That's the whole mechanism.

```ts
type TaskFnInterface<TState> = (next: () => Promise<void>, state: TState) => Promise<void>
```

`TState` extends `Record<string, unknown>`. Tasks mutate state directly — the same object reference flows through the entire chain.

## Pipeline vs ConcurrentPipeline

Two classes:

- `Pipeline` — runs one record at a time, in order.
- `ConcurrentPipeline` — runs batches of records concurrently, bounded by `concurrency` from the target config.

The orchestrator picks which one based on `targets[].concurrency`. Default is `1`, which gives sequential `Pipeline` behavior.

**Why batching matters**: A single `Pipeline` executes the full task chain once per record. When `concurrency > 1`, `ConcurrentPipeline` fans the record list across multiple concurrent `pipeline.execute()` calls sharing the same task queue, using a semaphore to cap live executions. This keeps memory footprint bounded while parallelizing I/O-heavy tasks (schema validation, file reads, external lookups). Set `concurrency: 4` to run 4 records through the same pipeline at once; set it to `1` for sequential behavior identical to looping.

**Shared state across concurrent runs**: The underlying `Pipeline` instance is read-only during execution — each concurrent `execute()` call gets its own state closure. However, if you wire a shared HTTP cache, logger, or materialized schema into `context`, all concurrent records see the same instance. This is intentional: caches need to be shared to deduplicate work. Your config responsibility is ensuring any shared resource is thread-safe.

## TaskRegistry

Tasks are registered by name and resolved at pipeline build time. Two modes:

**Static (global default)** — call `TaskRegistry.register('name', fn)` at module load time. The orchestrator picks them up automatically.

**Instance (per-run isolation)** — `new TaskRegistry()` gives an isolated map. Pass it to `new Pipeline(config, registry)`. Tasks registered on the instance don't bleed into other concurrent runs.

```ts
import { TaskRegistry } from 'squashage/registry/TaskRegistry';

// Global registration — plugins self-register at import time
TaskRegistry.register('aonprd:squash', async (next, state) => {
  // ... emit quads ...
  await next();
});
```

Plugin files are loaded dynamically via `TaskRegistry.load('./path/to/plugin.js')`. The plugin module's top-level side effect (the `TaskRegistry.register` call) fires on import.

## state.context

`state.context` is `PipelineContextInterface` — populated by the orchestrator before tasks run. It carries everything a task needs to emit quads:

```ts
interface PipelineContextInterface {
  target:   string;           // target name from config
  outDir:   string;           // base output directory
  config:   Record<string, unknown>;  // the full target config object
  factory:  DataFactory;      // RDF/JS term factory (namedNode, literal, quad, ...)
  dataset:  DatasetCore;      // canonical dataset — every plugin writes quads here
  builder:  GraphBuilder;     // convenience quad-builder with prefix/IRI helpers
  graphs:   Record<string, NamedNode>;  // named-graph IRIs by lane key
  iri:      NamespaceBuilder; // Proxy — ctx.iri.MyClass → NamedNode for vocabulary IRI
  output:   OutputConfigInterface;  // resolved output config
  prefixes: PrefixResolutionInterface;  // instances/graphs/vocabulary base IRIs
}
```

### `state.context.prefixes`

`PrefixResolver` derives instance, graph, and vocabulary base IRIs from `_source.url`. You don't hardcode a domain — the pipeline computes it:

```ts
{
  instances:  { prefix: 'sq-i:', base: 'https://squashage.dev/instance/aonprd/' },
  graphs:     { prefix: 'sq-g:', base: 'https://squashage.dev/graph/aonprd/' },
  vocabulary: { prefix: 'sq-v:', base: 'https://squashage.dev/vocabulary/aonprd#' }
}
```

**Resolution flow**: Given `_source.url = 'https://2e.aonprd.com/Feats.aspx?ID=750'`, the resolver applies a priority cascade: (1) check user override in `targets[].ontology.prefixes`; (2) derive from the URL hostname (here, `2e.aonprd.com` becomes the instances base and target name is slugified into `aonprd`); (3) fall back to synthetic `https://squashage.dev/` bases if derivation fails. The same `(_source.url, config)` pair always produces the same prefix resolution — deterministic and reproducible across runs.

### `state.context.builder`

`GraphBuilder` wraps the factory and dataset with helpers for common quad patterns. Use it instead of raw `factory.quad(...)` calls when you want prefix-aware IRI construction. It validates IRIs at emit time and raises on malformed quads before they land in the dataset.

**Rationale**: Mismatched named nodes, invalid literal datatypes, or malformed IRIs are caught immediately at the call site, not silently accepted then discovered during serialization. Factory methods are low-level and permissive; builders enforce correctness.

### `state.context.iri`

`NamespaceBuilder` is a Proxy. Accessing `ctx.iri.MyClass` returns a `NamedNode` for `<vocabulary-base>MyClass`. Accessing `ctx.iri['my-predicate']` returns `<vocabulary-base>my-predicate`. No string concatenation at call sites.

**Why**: Direct IRI construction via string concatenation is error-prone (missing slash, typos in predicate names, inconsistent casing). The Proxy ensures all vocabulary IRIs are minted from the same base, validated at construction time. This prevents invalid IRIs from being emitted.

## PipelineStateInterface

The full state shape:

```ts
interface PipelineStateInterface extends Record<string, unknown> {
  readonly targetId:       string;           // target name
  readonly source:         InputSourceInterface;     // _source metadata
  readonly input:          Record<string, unknown>;  // parsed JSON record
  classification:          ClassificationEvidenceInterface | null;  // set by classify:conflict
  classifications:         ClassificationProposalInterface[];       // accumulates across classify:* tasks
  output:                  Record<string, unknown> | null;          // set by squash:* tasks
  context?:                PipelineContextInterface;                // set by orchestrator
}
```

Tasks can attach extra keys — the `Record<string, unknown>` index signature allows it. Use this for inter-task communication that doesn't belong on the canonical fields.

## Built-in tasks

| Name | What it does |
|------|-------------|
| `json:read` | Reads one JSON file, populates `state.input` and `state.source`. |
| `classify:source` | Emits `__source__` marker proposal from `_source`. |
| `classify:structural` | Runs closed-vocab predicate rules, emits class proposals. |
| `classify:rules` | Runs decision-table rules, emits class proposals. |
| `classify:schema` | Runs per-class AJV validators, emits class proposals. |
| `classify:ontology` | Validates proposals against ontology class map. |
| `classify:conflict` | Picks winning class; quarantines ties and unknowns. |
| `rdfjs:finalize` | Serializes dataset to file; runs canonicalization and SHACL validation. |

## Custom task — minimal example

Registers a squasher plugin that emits one quad per record:

```ts
import { TaskRegistry } from 'squashage/registry/TaskRegistry';
import type { PipelineStateInterface } from 'squashage/types/PipelineState';

TaskRegistry.register('myproject:squash', async (next, state: PipelineStateInterface) => {
  const ctx = state.context;
  if (ctx === undefined || state.classification === null) {
    await next();
    return;
  }

  const { factory, dataset, prefixes } = ctx;

  // Build subject IRI from source URL
  const urlPath = new URL(state.input['url'] as string).pathname.slice(1);
  const subject  = factory.namedNode(`${prefixes.instances.base}${urlPath}`);
  const graph    = factory.namedNode(`${prefixes.graphs.base}${state.classification.type}`);
  const RDF_TYPE = factory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
  const classIri = factory.namedNode(`${prefixes.vocabulary.base}${state.classification.type}`);

  // Emit rdf:type quad
  dataset.add(factory.quad(subject, RDF_TYPE, classIri, graph));

  await next();
});
```

Put this in a file that your config references under `plugins[]`. It self-registers when the orchestrator loads the module.

## Ordering constraints

The pipeline array must be consistent with which tasks exist:

- `json:read` goes first — everything else reads `state.input`.
- `classify:conflict` must come after all class-proposing tasks (`classify:structural`, `classify:rules`, `classify:schema`).
- `rdfjs:finalize` goes last — it writes the file.
- Your `squash:*` task goes after `classify:conflict` and before `rdfjs:finalize`.

The config loader cross-validates this at startup and rejects invalid orderings.

## Related

- [Configuration](./configuration) — how to declare a pipeline in config
- [Classifier cascade](./classifier-cascade) — what the classify:* tasks do
- [Plugins](./plugins) — how to write a squasher plugin
