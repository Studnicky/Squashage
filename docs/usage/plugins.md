---
layout: doc
title: Plugins
description: Squashage plugin authoring — TaskRegistry.register and registerHook, plugin discovery via config glob patterns, load-time failure semantics, and the per-record quarantine contract.
---

# Plugins

A squashage plugin is a module that calls `TaskRegistry.register` or `TaskRegistry.registerHook` at module load time. The orchestrator loads the module; the registration fires as a side effect, and the task or hook is available under its name.

**Plugin discovery**: Config lists plugin paths (glob patterns, absolute, or relative to the config file). The orchestrator loads each plugin module; the registration call happens as the module evaluates. If a plugin throws during load, the orchestrator exits with code `2` before any record is processed. If a plugin throws during per-record execution, that record is quarantined under `quarantine/projection/` and the build continues (exit code stays `0`).

For the full coordination protocol that plugins participate in, see [Context silo](../context-silo).

---

## Silo plugin protocol

Every plugin that participates in the silo architecture follows this pattern:

```ts
import { TaskRegistry } from 'squashage/registry/TaskRegistry';

// 1. Register a lifecycle hook (optional — for startup validation / pre-compilation)
TaskRegistry.registerHook('myproject:squash', 'onRunStart', async (ctx) => {
  // Read your config namespace
  const rawConfig = ctx.config['myproject'] as unknown;
  if (rawConfig === undefined) return; // absent namespace is a no-op

  // Validate via the run-wide shared AJV instance
  const validate = ctx.ajv.compile(myConfigSchema);
  if (!validate(rawConfig)) {
    throw new OutputConfigError(
      `myproject:squash: invalid config: ${ctx.ajv.errorsText(validate.errors)}`
    );
  }
  const config = rawConfig as MyConfigInterface;

  // Compile startup state and cache it, keyed by ctx.target for concurrent-run isolation
  moduleCache.set(ctx.target, compileStartupState(config));
}, { proposesClass: false });

// 2. Register the per-record task
TaskRegistry.register('myproject:squash', async (next, state) => {
  const ctx = state.context;
  if (ctx === undefined) { await next(); return; }

  // Read from the cache populated by onRunStart
  const compiled = moduleCache.get(ctx.target);
  if (compiled === undefined) {
    throw new Error('myproject:squash: cache miss — onRunStart did not run');
  }

  // ... emit quads or do work ...

  await next();
}, { proposesClass: false });
```

### `proposesClass: true`

If your plugin proposes classification classes onto `state.classifications`, declare it in the manifest:

```ts
TaskRegistry.register('classify:myplugin', task, { proposesClass: true });
TaskRegistry.registerHook('classify:myplugin', 'onRunStart', hook, { proposesClass: true });
```

The orchestrator counts all registered tasks with `proposesClass: true` and asserts that `classify:conflict` is also registered when the count is two or more.

### Reading config from `ctx.config[<namespace>]`

Each plugin reads its own namespace from `ctx.config`. The namespace key matches the top-level key you document for users to set in their target config:

```ts
const raw = ctx.config['myproject'] as unknown;
```

There is no wrapper block. The full target config object is `ctx.config`.

### Validating config via `ctx.ajv`

Use the run-wide shared AJV instance. Do not create a private AJV inside your plugin:

```ts
const validate = ctx.ajv.compile(myConfigSchema);
if (!validate(raw)) {
  throw new OutputConfigError(`...${ctx.ajv.errorsText(validate.errors)}`);
}
```

### Lifecycle silo keys

Your plugin can read and write the following well-known silo keys:

**Run-wide (`ctx`):**

| Key | Type | Notes |
|-----|------|-------|
| `ctx.target` | string | Target identifier; never mutates. Use as cache key. |
| `ctx.outDir` | string | Run output base directory. |
| `ctx.config` | frozen Record | Full target config; read your namespace from here. |
| `ctx.output` | OutputConfigInterface | Resolved output config (post-CLI-merge). |
| `ctx.logger` | LoggerFactoryInterface | `ctx.logger.forComponent('MyPlugin')` |
| `ctx.ajv` | Ajv | Shared AJV instance; use for config validation. |
| `ctx.factory` | DataFactory | RDF/JS data factory. |
| `ctx.dataset` | DatasetCore | Canonical dataset; add quads here. |
| `ctx.builder` | GraphBuilder | Quad-emission helper with prefix conventions. |
| `ctx.iri` | NamespaceBuilder | Proxy; `ctx.iri.MyClass` returns a `NamedNode`. |
| `ctx.prefixes` | PrefixResolutionInterface | `instances`, `graphs`, `vocabulary` bases. |
| `ctx.graphs` | frozen Record | Named-graph IRIs by lane key. |
| `ctx.jt` | JsonTologyOntology (optional) | Present only when `ontology.engine === 'json-tology'`. Consumers MUST no-op when absent. |
| `ctx.runStartTime` | ISO 8601 string (optional) | Frozen once per run; populated by `context:run-time`. |

**Per-record (`state`):**

| Key | Type | Notes |
|-----|------|-------|
| `state.input` | frozen Record | Parsed JSON record. |
| `state.source` | InputSourceInterface | `_source` metadata block. |
| `state.classifications` | ReadonlyArray | Append proposals here (proposer plugins). |
| `state.classification` | ClassificationEvidenceInterface or null | Written by `classify:conflict`; null until then. |
| `state.output` | Record or null | Per-record projection report; written by squash plugins. |
| `state.context` | PipelineContextInterface | The run-wide silo. |

---

## Squasher plugin (full example)

Projects one input class into quads per record:

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

  // Derive subject IRI from source URL path
  const urlPath = new URL(state.input['url'] as string).pathname.slice(1);
  const subject  = factory.namedNode(`${prefixes.instances.base}${urlPath}`);

  // Named graph for this class
  const graph = factory.namedNode(`${prefixes.graphs.base}${state.classification.type}`);

  // rdf:type
  const RDF_TYPE = factory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
  const classIri = factory.namedNode(`${prefixes.vocabulary.base}${state.classification.type}`);
  dataset.add(factory.quad(subject, RDF_TYPE, classIri, graph));

  // A string property
  if (typeof state.input['name'] === 'string') {
    dataset.add(factory.quad(
      subject,
      factory.namedNode(`${prefixes.vocabulary.base}name`),
      factory.literal(state.input['name']),
      graph,
    ));
  }

  // A numeric property with datatype
  if (typeof state.input['level'] === 'number') {
    dataset.add(factory.quad(
      subject,
      factory.namedNode(`${prefixes.vocabulary.base}level`),
      factory.literal(String(state.input['level']), factory.namedNode('http://www.w3.org/2001/XMLSchema#integer')),
      graph,
    ));
  }

  await next();
});
```

Save to `plugins/myproject/squash.ts`, build with your tsconfig, and declare the compiled path in your config's `plugins[]` array.

---

## Classifier plugin

A classifier plugin registers under a `classify:*` name and emits `ClassificationProposalInterface` objects onto `state.classifications`. Include an `onRunStart` hook for config validation and startup compilation:

```ts
import { TaskRegistry } from 'squashage/registry/TaskRegistry';
import { OutputConfigError } from 'squashage/errors/OutputConfigError';

// Module-private cache: keyed by ctx.target for concurrent-run isolation
const cache = new Map<string, { lookup: Set<string>; priority: number }>();

// onRunStart: validate config and compile startup state
TaskRegistry.registerHook('classify:myproject', 'onRunStart', async (ctx) => {
  const raw = ctx.config['myproject'] as unknown;
  if (raw === undefined) return; // no-op when namespace absent

  const validate = ctx.ajv.compile(myConfigSchema);
  if (!validate(raw)) {
    throw new OutputConfigError(
      `classify:myproject: ${ctx.ajv.errorsText(validate.errors)}`
    );
  }
  const config = raw as { values: string[]; priority: number };
  cache.set(ctx.target, {
    lookup: new Set(config.values),
    priority: config.priority ?? 25,
  });
}, { proposesClass: true });

// per-record task: read from cache, emit proposals
TaskRegistry.register('classify:myproject', async (next, state) => {
  const ctx = state.context;
  if (ctx === undefined) { await next(); return; }

  const compiled = cache.get(ctx.target);
  if (compiled === undefined) { await next(); return; }

  const value = state.input['myfield'];
  if (typeof value === 'string' && compiled.lookup.has(value)) {
    state.classifications = [
      ...state.classifications,
      {
        source:     'classify:myproject',
        className:  value,
        priority:   compiled.priority,
        confidence: 1,
        reasons:    [`myfield=${value}`],
      },
    ];
  }

  await next();
}, { proposesClass: true });
```

List `classify:myproject` in the pipeline after input tasks and before `classify:conflict`. Provide a `myproject` namespace in your target config.

---

## Using GraphBuilder

`GraphBuilder` wraps the factory with helpers for common patterns. Prefer it over raw `factory.quad(...)` for prefix-aware IRI construction:

```ts
const { builder, prefixes } = ctx;
// builder.triple(s, p, o); adds to default graph
// builder.quad(s, p, o, g); adds to named graph
// builder.literal(value, datatype?); literal with optional datatype IRI
```

## Using NamespaceBuilder

`ctx.iri` is a Proxy. Property access returns a `NamedNode` for the vocabulary IRI:

```ts
const featClass = ctx.iri.Feat;           // NamedNode('https://squashage.dev/vocabulary/aonprd#Feat')
const namePred  = ctx.iri['aonprd-name']; // NamedNode('https://squashage.dev/vocabulary/aonprd#aonprd-name')
```

**Why a Proxy**: Prevents typos and invalid IRIs. Direct string concatenation lets you construct `https://example.com/MyClass` and `https://example.com/my-class` as distinct IRIs; the Proxy forces consistent casing and structure.

## Using PrefixResolver

`ctx.prefixes` gives you the three base IRIs derived from `_source.url`:

```ts
prefixes.instances.base  // 'https://squashage.dev/instance/aonprd/'
prefixes.graphs.base     // 'https://squashage.dev/graph/aonprd/'
prefixes.vocabulary.base // 'https://squashage.dev/vocabulary/aonprd#'
```

## Guards

Check both `ctx` and `state.classification` before using them. `ctx` is set by the orchestrator but not by unit tests that run tasks in isolation. `state.classification` is `null` until `classify:conflict` runs; your squasher task runs after it, but defensive checks are cheaper than debugging a null dereference.

---

## Related

- [Pipeline](./pipeline); how tasks are registered and run
- [Configuration](./configuration); declaring plugins in the config
- [Classifier cascade](./classifier-cascade); built-in classify:* tasks and the proposal shape
- [Context silo](../context-silo); the full plugin coordination contract
