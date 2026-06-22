---
layout: doc
title: DAG
description: Squashage's run-scope and per-record DAGs, built on @studnicky/dagonizer. Authored .dag.jsonld documents, native scatter per-record fan-out, native fold gather, PROV-O observation, memory checkpoint resume.
---

# DAG

Squashage runs on `@studnicky/dagonizer`. The topology is authored as JSON-LD documents under `src/dag/*.dag.jsonld`, loaded via `DAGDocument.load` and registered on the dispatcher with `dispatcher.registerBundle`. Two DAGs drive a run:

- **`squashage:run`** — the run-scope DAG. Walks input, scatters every record through the record DAG, enriches, finalizes, emits the catalog.
- **`squashage:record`** — the per-record DAG. Reads one record, classifies it, projects it to RDF, writes provenance.

The run DAG fans out over records with a native `scatter` node (`process-all-records`). Each record runs the `squashage:record` DAG as the scatter body; the clones fold back through the native gather strategy `squashage:record-fold`, with concurrency lifted from the config root `concurrency` knob.

## State

Two state classes, both extending `NodeStateBase`:

```ts
class SquashageRunState extends NodeStateBase {
  locators:     RecordLocator[];        // produced by walk-input
  results:      RecordSummary[];        // folded in by squashage:record-fold
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

Every dispatcher-scoped dependency rides on the typed `SquashageServices` bag. The bag is eagerly built once at `SquashageRun.forRun(...)` time — no post-construction mutation, no global state.

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
  readonly targetConfig: SquashageRunConfig;
}
```

Nodes read whichever fields they need via `context.services.<x>`.

## Run-scope DAG

```mermaid
flowchart TB
  walk[walk-input]
  scatter{{process-all-records\nscatter dag=squashage:record\ngather=squashage:record-fold}}
  enrich[enrich-entity-link]
  ont[ontology-emit]
  finalize[rdfjs-finalize]
  catalog[catalog-emit]
  END([run-end])

  walk -->|walked|     scatter
  walk -->|empty|      finalize
  scatter -->|all-success| enrich
  scatter -->|partial|     enrich
  scatter -->|all-error|   finalize
  scatter -->|empty|       finalize
  enrich -->|enriched| ont
  enrich -->|skipped|  ont
  ont -->|emitted| finalize
  ont -->|skipped| finalize
  ont -->|error|   finalize
  finalize -->|written| catalog
  finalize -->|empty|   END
  catalog --> END
```

`process-all-records` is a native `ScatterNode`. It reads `locators` from `SquashageRunState`, runs `squashage:record` once per locator as the scatter body (`itemKey: currentLocator`), and gathers the record clones back through the `squashage:record-fold` strategy. Concurrency comes from the config root `concurrency` knob.

## Per-record DAG

```mermaid
flowchart TB
  init[record-init]
  read[json-read]
  disc[classify:discriminator]
  src[classify:source]
  url[classify:url-pattern]
  struct[classify:structural]
  rules[classify:rules]
  schema[classify:schema]
  shacl[classify:shacl-shape]
  fp[classify:property-fingerprint]
  nlp[classify:winknlp-entities]
  ontc[classify:ontology]
  narrow[classify:taxonomic-narrowing]
  gate[record-health-gate]
  conflict[classify-conflict]
  squash[squash]
  prov[output-provenance]
  q[record-quarantine]
  END([end])

  init -->|done|        read
  read -->|loaded|      disc
  read -->|quarantined| q
  disc --> src --> url --> struct --> rules --> schema --> shacl --> fp --> nlp --> ontc --> narrow --> gate
  gate -->|has-proposals|    conflict
  gate -->|generic-fallback| squash
  gate -->|errors|           q
  conflict -->|resolved| squash
  conflict -->|tie|      q
  conflict -->|unknown|  q
  squash -->|squashed|    prov
  squash -->|quarantined| q
  prov -->|written| END
  prov -->|skipped| END
  q --> END
```

The record DAG entrypoint is `record-init`, which routes to `json-read`. The classifier nodes run in chain order. Each classifier writes its proposal to `state.proposals[<classifier-name>]` — a named slot, so writes never collide. The two ontology-aware classifiers run last because they read the other classifiers' proposals:

- `classify:ontology` — validates other classifiers' votes against the configured class map; emits `__validation__` sentinels for unknown class names.
- `classify:taxonomic-narrowing` — drops supertype proposals when a more-specific subtype is also present, via OWL `subClassOf` transitive closure.

`record-health-gate` routes records with at least one proposal to `classify-conflict`, records that match no classifier to `squash` under the Generic fallback class, and records carrying errors to `record-quarantine`. `classify-conflict` reduces every non-sentinel proposal into a single winning `state.classification`.

## Quarantine

Quarantine is a real DAG path. Every failure route lands on `record-quarantine`, which calls `services.quarantine.write(...)` to dump the record's input + accumulated errors into `<outDir>/<run>/quarantine/<bucket>/<id>.json`. The buckets are:

- `unknown` — no classifier produced a proposal and no fallback applied.
- `conflicts` — two or more classes tied at the top priority and the policy is `quarantine`.
- `projection` — `json-read` couldn't parse the record, or `squash` collected an error.
- `output` — `rdfjs-finalize` rejected the dataset (SHACL validation failure).

## Three output files

`rdfjs-finalize` splits the run's dataset into three on-disk artifacts:

| File | Contents |
|---|---|
| `<output.path>` | The success graph. Every quad NOT in the PROV graph. |
| `<output.path-stem>.prov.<ext>` | The PROV-O graph — one `prov:Activity` per node execution, written by the dispatcher's lifecycle hooks into `urn:squashage:prov:<runStartTime>`. |
| `<outDir>/<run>/quarantine/<bucket>/<id>.json` | One file per failed record, grouped by bucket. |

## Execution

```ts
import { SquashageRun } from '@studnicky/squashage/SquashageRun';

const run = await SquashageRun.forRun({
  target:      'aonprd',
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
import { Checkpoint, MemoryCheckpointStore } from '@studnicky/dagonizer/checkpoint';

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

`SquashageDagonizer` extends `Dagonizer` and overrides every lifecycle hook (`onFlowStart`, `onFlowEnd`, `onNodeStart`, `onNodeEnd`, `onError`) to write PROV-O directly. Each node execution emits one `prov:Activity` into the dedicated PROV graph — `services.dataset` in dataset mode, `services.provSink` in stream mode. See [Provenance](./provenance) for the full PROV-O shape.

## See also

- [Configuration](./configuration) — every config knob the DAG reads.
- [Classifier cascade](./classifier-cascade) — what each classifier produces and how the conflict resolver picks a winner.
- [Plugins](./plugins) — how to ship a run-specific squash node.
- [Architecture](../architecture) — module map + class lineage.
