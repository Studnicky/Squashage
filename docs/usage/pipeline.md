---
layout: doc
title: DAG
description: Squashage's run-scope and per-record DAGs, built on @noocodex/dagonizer. Lifecycle FSM, async-iterable execution, bounded fan-out, PROV-O observation, memory checkpoint resume.
---

# DAG

Squashage runs on `@noocodex/dagonizer`. One `SquashageDagonizer` per target invocation; two DAGs registered on it:

- **`squashage:run`** — the run-scope DAG. Walks input, processes every record, finalizes, emits the catalog.
- **`squashage:record`** — the per-record deep-DAG. Reads one record, classifies it, projects it to RDF, writes provenance.

The run DAG invokes the record DAG once per `RecordLocator` via the `process-all-records` node, which dispatches each record through the same `SquashageDagonizer` instance with a bounded concurrency lifted from `targets[].concurrency`.

## State

Two state classes, both extending `NodeStateBase`:

```ts
class SquashageRunState extends NodeStateBase {
  locators:     RecordLocator[];        // produced by walk-input
  results:      RecordSummary[];        // appended by process-all-records
  target:       string;
  runStartTime: string;
}

class SquashageRecordState extends NodeStateBase {
  source:           InputSource;
  input:            Readonly<Record<string, unknown>>;  // populated by json-read
  proposals:        Record<string, ClassificationProposal>; // keyed by classifier name
  classification:   ClassificationEvidence | null;
  squashedQuads:    readonly Quad[];     // populated by squash
  quarantineBucket: 'unknown' | 'conflicts' | 'projection' | 'output' | null;
  recordPath:       string;
  recordLine:       number;
}
```

Both implement `snapshotData()` / `restoreData()` so a checkpoint round-trips through `Checkpoint.toJson` / `Checkpoint.restore` cleanly.

## Services

Every dispatcher-scoped dependency rides on the typed `SquashageServices` bag. The bag is eagerly built once at `SquashageRun.forTarget(...)` time — no post-construction mutation, no global state.

```ts
interface SquashageServices {
  readonly logger:       LoggerFactory;
  readonly ajv:          Ajv;
  readonly factory:      DataFactory;
  readonly dataset:      DatasetCore;
  readonly builder:      GraphBuilder;
  readonly prefixes:     PrefixResolution;
  readonly graphs:       Readonly<Record<string, NamedNode>>;
  readonly iri:          NamespaceBuilder;
  readonly ontology:     JsonTologyOntology | null;
  readonly quarantine:   QuarantineWriter;
  readonly output:       OutputConfig;
  readonly target:       string;
  readonly outDir:       string;
  readonly schemasBase:  string;
  readonly runStartTime: string;
  readonly targetConfig: TargetConfig;
}
```

Nodes read whichever fields they need via `context.services.<x>`.

## Run-scope DAG

```mermaid
flowchart TB
  walk[walk-input]
  process{{process-all-records\nfan-out concurrency=N}}
  enrich[enrich-entity-link]
  finalize[rdfjs-finalize]
  catalog[catalog-emit]
  END([end])

  walk -->|walked|     process
  walk -->|empty|      finalize
  process -->|all-success| enrich
  process -->|partial|     enrich
  process -->|all-error|   finalize
  process -->|empty|       finalize
  enrich --> finalize
  finalize -->|written| catalog
  finalize -->|empty|   END
  catalog --> END
```

`process-all-records` is the node that internally drives the per-record deep-DAG. It owns a reference to the dispatcher (captured at construction) and calls `dispatcher.execute('squashage:record', recordState)` for each locator with `Promise.all` capped at `targetConfig.concurrency`.

## Per-record DAG (deep-DAG)

```mermaid
flowchart TB
  read[json-read]
  parallel{{classify-all\nparallel collect}}
  ont[classify:ontology]
  narrow[classify:taxonomic-narrowing]
  gate[record-health-gate]
  conflict[classify-conflict]
  squash[squash]
  prov[output-provenance]
  q[record-quarantine]
  END([end])

  read -->|loaded|      parallel
  read -->|quarantined| q
  parallel -->|success| ont
  parallel -->|error|   ont
  ont      --> narrow
  narrow   --> gate
  gate -->|has-proposals| conflict
  gate -->|none|          q
  gate -->|errors|        q
  conflict -->|resolved| squash
  conflict -->|tie|      q
  conflict -->|unknown|  q
  squash -->|squashed|    prov
  squash -->|quarantined| q
  prov -->|written| END
  prov -->|skipped| END
  q --> END
```

Parallel members of the `classify-all` placement:

- `classify:source`
- `classify:url-pattern`
- `classify:structural`
- `classify:rules`
- `classify:schema`
- `classify:shacl-shape`
- `classify:property-fingerprint`
- `classify:winknlp-entities`

Sequential post-parallel classifiers (they read other classifiers' proposals, so they cannot run in parallel):

- `classify:ontology` — validates other classifiers' votes against the configured class map; emits `__validation__` sentinels for unknown class names.
- `classify:taxonomic-narrowing` — drops supertype proposals when a more-specific subtype is also present, via OWL `subClassOf` transitive closure.

Each classifier writes its proposal to `state.proposals[<classifier-name>]` — a named slot, so parallel writes are race-free. The downstream `classify-conflict` node reduces every non-sentinel proposal into a single winning `state.classification`.

## Quarantine

Quarantine is a real DAG path. Every failure route lands on `record-quarantine`, which calls `services.quarantine.write(...)` to dump the record's input + accumulated errors into `<outDir>/<target>/quarantine/<bucket>/<id>.json`. The buckets are:

- `unknown` — no classifier produced a proposal.
- `conflicts` — two or more classes tied at the top priority and the policy is `quarantine`.
- `projection` — `json-read` couldn't parse the record, or `squash` collected an error.
- `output` — `rdfjs-finalize` rejected the dataset (SHACL validation failure).

## Three output files

`rdfjs-finalize` splits the run's dataset into three on-disk artifacts:

| File | Contents |
|---|---|
| `<output.path>` | The success graph. Every quad NOT in the PROV graph. |
| `<output.path-stem>.prov.<ext>` | The PROV-O graph — one `prov:Activity` per node execution, written by `ProvObserver` into `urn:squashage:prov:<runStartTime>`. |
| `<outDir>/<target>/quarantine/<bucket>/<id>.json` | One file per failed record, grouped by bucket. |

## Execution

```ts
import { SquashageRun } from '@studnicky/squashage/SquashageRun';

const run = await SquashageRun.forTarget({
  target: 'aonprd',
  targetConfig,
  output:      targetConfig.output,
  outDir:      './graphs',
  schemasBase: './configs',
});

// Sync-style: await the final summary.
const result = await run.execute();
for (const summary of (result.state as SquashageRunState).results) {
  console.log(summary.recordPath, summary.outcome, summary.className);
}

// Streaming-style: observe each node as it completes.
for await (const nodeResult of run.execute()) {
  if (nodeResult.nodeName === 'rdfjs-finalize') {
    // success graph just landed on disk
  }
}
```

`run.execute()` returns a dagonizer `Execution<TState>` — both `PromiseLike` and `AsyncIterable`. One generator body runs exactly once regardless of which consumption mode you pick.

## Cancellation + resume

Pass `signal` and/or `deadlineMs` to halt the run early. The dispatcher composes both into a single `AbortSignal` and propagates it through every node via `context.signal`.

When execution stops with a non-null `result.cursor`, the run is resumable. Squashage uses the dagonizer `MemoryCheckpointStore` only — production deployers implement `CheckpointStore` against their own persistence.

```ts
import { Checkpoint, MemoryCheckpointStore } from '@noocodex/dagonizer/checkpoint';

const result = await run.execute();
if (result.cursor !== null) {
  const store = new MemoryCheckpointStore();
  await Checkpoint.persist(store, 'ckpt:aonprd', Checkpoint.from('squashage:run', result));
  // ... later
  const recalled = await Checkpoint.recall(store, 'ckpt:aonprd', (snap) => SquashageRunState.restore(snap));
  await run.dispatcher.resume(recalled!.dagName, recalled!.state, recalled!.cursor);
}
```

## Provenance

`SquashageDagonizer` extends `Dagonizer` and forwards every lifecycle hook (`onFlowStart`, `onFlowEnd`, `onNodeStart`, `onNodeEnd`, `onError`) to an injected `ProvObserver`. The default observer writes one `prov:Activity` per node into the dedicated PROV graph in `services.dataset`. Swap it for `NullObserver` in tests.

```ts
const run = await SquashageRun.forTargetWithNullObserver({ ... });   // tests
```

## See also

- [Configuration](./configuration) — every config slot the new DAG reads.
- [Classifier cascade](./classifier-cascade) — what each classifier produces and how the conflict resolver picks a winner.
- [Plugins](./plugins) — how to ship a target-specific squash node.
- [Architecture](../architecture) — module map + class lineage.
