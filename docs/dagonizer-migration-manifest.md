# Squashage → native dagonizer: task manifest

Companion to `docs/dagonizer-native-northstar.md`. The northstar fixes the *direction*; this
manifest fixes the *execution* — corrected against the live `@studnicky/dagonizer@0.24.0` API
and the verified Ripperoni v3.0.0 reference at `/Users/studs/Workspace/ripper`. Where this
manifest and the northstar disagree on an API name or a count, **this manifest is authoritative**
(it was validated against the installed `.d.ts` and the shipped reference repo).

## 0. Corrected API surface (use these names, not the northstar's)

The engine resolves at `node_modules/@noocodex/dagonizer` (package name `@studnicky/dagonizer`,
v0.24.0). Verified exports:

- **`DAGBuilder(name, version)`** — methods: `.entrypoint(node)`, `.node(name, node, routes)`,
  `.scatter(name, source, body, outputs, options)`, `.embeddedDAG(name, dag, outputs, options?)`,
  `.terminal(name, options?)`, `.phase(name, 'pre'|'post', node)`, `.build()`.
  - **There is no `.fanOut()` and no `.parallel()`.** Fan-out = `.scatter()`. The classifier
    "parallel" fan-out is also `.scatter()` (or N `.node()` placements + a reducer).
  - `.scatter` body accepts `NodeInterface | { dag: string } | { dagFrom: string }`.
  - `.scatter` `options`: `{ inputs?: Record<childKey, parentPath>, gather: GatherConfigType, itemKey?, container? }`.
  - `.embeddedDAG` `options`: `{ inputs?: Record<childKey, parentPath>, outputs?: Record<parentPath, childKey>, container? }`.
- **`ScatterNodeType` / `EmbeddedDAGNodeType`** are wire-shape *types*, produced by the builder —
  not classes you `new`.
- **`GatherConfigType`** strategies: `append | collect | custom | discard | map | partition`
  (`map` needs `mapping`, `append`/`collect` need `target`/`field`, `partition` needs `partitions`,
  `custom` needs `customNode`).
- **`DAGDocument`** (static): `serialize(dag): string`, `serializeCompact(dag): string`,
  `load(json: string): DAGType`, `ofValue(value: unknown): DAGType`. **`load` takes a JSON string,
  not a path** — the runner reads the file then `DAGDocument.load(text)`.
- **`ScalarNode<TState, TOutput, TServices = undefined>`** — abstract; implement
  `protected executeOne(state, context): Promise<NodeOutputType<TOutput>>`. Read services via
  `context.services` (typed `TServices`). Export an instance.
- **`Dagonizer<TState, TServices>({ services?, containers?, accessor?, channels?, registryVersion?, validateOutputs? })`** —
  subclass and override `onFlowStart/onFlowEnd/onNodeStart/onNodeEnd/onError/onPhaseEnter/onPhaseExit`
  for the observer (mirrors Ripperoni's `RipperDagonizer`). `containers: Record<string, DagContainerInterface>`.
  `.execute(dagName, state, options?)` returns an `Execution` (awaitable + async-iterable).
- **`DagContainerInterface`** exists; **`WorkerThreadContainer` and `@studnicky/dagonizer-executor-node`
  do NOT exist.** Worker isolation = extend `DagContainerBase<TWorker>` (`@studnicky/dagonizer/container`).
  Containers are **out of scope** for waves 1–5 (an unbound role runs in-process; no need yet).
- **`PredicateGateNode` and `DecisionNode` do NOT exist.** Keep the bespoke SHACL ready-gate and the
  classifiers as `ScalarNode`s routing among named output ports. (§4 of the northstar's "map to a
  native primitive" suggestion for these two is void.)

Subpath exports in use: bare `@studnicky/dagonizer`, `/builder`, `/entities`, `/types`,
`/container`, `/contracts`, `/core`, `/dag`, `/viz`.

## 1. Verified inventory (what actually exists)

- **60 `.ts` files** import `@noocodex/dagonizer` (57 src + 2 test + 1 script), across 5 subpaths
  (bare, `/builder`, `/entities`, `/types`, `/viz`).
- **No `.npmrc`** at repo root — create one.
- **7 DAGs** authored in code, not 6: `recordDag`, `recordInduceDag`, `induceDag`, `refineDag`,
  `refineOneDag`, `bootstrapDag` (in `src/dag/*.ts`) **plus `squashage:run`** built inline in
  `SquashageRun.forTarget` (`SquashageRun.ts:263-288`).
- **3 hand-dispatch nodes**: `recordDispatch` (`src/nodes/run/recordDispatch.ts:56`),
  `draftDispatch` (`src/nodes/run/draftDispatch.ts:55`), and `record-dispatch-induce` (a second
  `createRecordDispatchNode` registration, `SquashageRun.ts:243`). All call `dispatcher.execute(...)`
  inside a node.
- **`stub()`** is a per-file local in 5 of the dag builders; `bootstrapDag.ts` uses raw throwing
  object literals instead.
- **~25 object-literal nodes** implementing `NodeInterface` directly (full list in wave 4).
- **12 classifier nodes** (not 10): the named 10 + `TaxonomicNarrowingClassifierNode` +
  `NoOpClassifierNode`. The classifier classes already extend `ScalarNode`/implement `NodeInterface`
  as classes and are **kept**. `ClassifyConflictNode` lives in `src/nodes/record/classifyConflict.ts`.
- **114 `as unknown` casts**: ~51 dispatcher/node-registration generic coercions, ~33 state
  (de)serialization, ~9 state-mutation, ~8 module-interop, ~13 other.
- **2 undisclosed freestanding `verbNoun()`**: `ontologyGraphIri` (`src/nodes/run/ontologyEmit.ts:36`),
  `buildDagonizerCli` (`src/cli/dagonizerCli.ts:57`).
- `TargetConfigInterface` knobs: `input, output, graphs?, ontology?, classification?, enrichment?,
  quarantine?, concurrency?, subjectIri?`.

## 2. Data contracts (write/confirm before waves edit shared surfaces)

- **`SquashageServices`** (`src/services/SquashageServices.ts`) — the typed services bag every
  `ScalarNode` reads via `context.services`. All node config must come from here, seeded from the
  validated state. No `cfg` bag, no `as unknown`.
- **The `*State` classes** (`src/state/*.ts`) — `SquashageRunState`, `SquashageRecordState`,
  `SquashageInduceRunState`, `SquashageRefineState`, `SquashageRefineRunState`,
  `SquashageBootstrapState`. Each must expose typed fields/mutators for everything a node writes
  (e.g. `squashedQuads`) so wave 4 can delete the state-mutation casts.
- **`SquashageDagonizer`** (`src/dispatcher/SquashageDagonizer.ts`) — the `Dagonizer` subclass /
  observer forwarder. Confirm it extends the engine `Dagonizer` and forwards `ProvObserver`.
- **The 7 `.dag.jsonld` documents** (wave 2) — the stable surface waves 3/5 edit. Node names in a
  document resolve to registered instances; the `stub()` indirection disappears.
- **Single-run state schema** (wave 5) — replaces the `targets` map. Fields: `input, output, graphs,
  ontology, classification, enrichment, quarantine, concurrency, subjectIri`, AJV-validated.

## 3. Waves (sprout-then-swap; gate each on `npm run check`)

### Wave 1 — Dep swap + import rewrite (northstar 3.1) — mechanical, reversible
**Owns:** `package.json`, new `.npmrc`, all 60 `@noocodex/dagonizer` importers, lockfile.
- `package.json`: drop `"@noocodex/dagonizer": "file:.."`; add `"@studnicky/dagonizer": "^0.24.0"`.
  (No `-executor-node` — workers are out of scope.)
- Create `.npmrc`: `@studnicky:registry=https://npm.pkg.github.com` (+ `@noocodec:` if any
  `@noocodec/*` deps need it; mirror Ripperoni's `.npmrc`).
- Rewrite every import specifier `@noocodex/dagonizer*` → `@studnicky/dagonizer*` across all 5
  subpaths in all 60 files.
- `npm install`, then `npm run check` green.
**Gate:** compiles + lints + unit tests pass against published 0.24. Single agent (repo-wide rename).

### Wave 2 — Author DAGs as documents + `build:assets` (northstar 3.3) — sprout
**Owns:** new `src/dag/*.dag.jsonld` (×7), an authoring script, `scripts/copy-dag-assets.mjs`,
`package.json` build wiring, the runner's load path. **Keeps the inline-build path alive** until
documents load and dispatch identically.
- Author each of the 7 DAGs with `DAGBuilder` → `DAGDocument.serialize` (a one-shot
  `scripts/author-dags.ts` mirroring how Ripperoni produced its committed documents), commit the
  `.dag.jsonld` output. The documents reference node *names*; do **not** yet convert the record
  fan-out to `{dag}` (that's wave 3) — keep referencing the dispatch nodes by name so behavior is
  identical.
- Add `scripts/copy-dag-assets.mjs` (port Ripperoni's) mirroring `src/**/*.dag.jsonld` → `dist/`;
  wire `"build:assets"` into `build` after `tsc`.
- Add a runner load path: read file → `DAGDocument.load(text)` → register. Run side-by-side with the
  inline path; assert the loaded DAG dispatches identically, then swap the runner to the documents.
- Delete the inline `DAGBuilder` calls + `stub()` locals only after the swap is green.
**Gate:** `npm run check` + a built CLI (`npm run build`) that loads DAGs from `dist` without ENOENT.

### Wave 3 — Native record/draft/induce fan-out (northstar 3.2) — swap
**Owns:** the `squashage:run` and `induce` `.dag.jsonld`, the refine document, deletion of
`src/nodes/run/recordDispatch.ts` + `src/nodes/run/draftDispatch.ts`, `SquashageRun.ts` registration.
- Replace all **3** hand-dispatch placements with `.scatter(name, source, { dag: 'squashage:record' },
  outputs, { inputs, gather })` (and `{ dag: 'squashage:refine-one' }` for drafts). `inputs` seeds
  each child state from the locator; `gather` (`collect`/`append` into a summaries target) gathers
  `RecordSummary` back.
- Delete `recordDispatch.ts`, `draftDispatch.ts`, `createRecordDispatchNode`,
  `createDraftDispatchNode`, and the dispatcher references they hold.
**Gate:** `npm run check` + a small real projection (subset of the corpus) producing identical
triple counts to pre-swap.

### Wave 4 — ScalarNode classes, drop factories, typed state (northstar 3.4/3.5/3.7) — largest
Partition by file ownership (disjoint node directories run in parallel; shared state/registration
is one sequential agent):
- **4a (parallel):** convert ~25 object-literal nodes → `class XxxNode extends ScalarNode<TState,
  TOutput, SquashageServices>` exporting an instance, work in `executeOne`. Split by dir:
  `nodes/record/*`, `nodes/run/*`, `nodes/refine/*`, plus `buildReadyGateNode`.
- **4b (sequential, shared):** add typed fields/mutators to the `*State` classes; delete the ~9
  state-mutation casts (`squashedQuads`, `state.input`, `result.state`). Fix the ~51 registration
  casts by typing `SquashageDagonizer` registration properly (a typed `register(dispatcher)` per
  node group) rather than `as unknown as NodeInterface<NodeStateInterface,…>`. Address the ~33
  state-serialization casts via typed `toJSON`/`fromJSON` on the state classes.
- **4c:** drop surviving `verbNoun()` — `ontologyGraphIri` → static on the ontology-emit node class;
  `buildDagonizerCli` → static factory on a CLI class or inline `new Command()` at the call site.
**Gate:** `npm run check`; zero `as unknown` in `src/` except justified module-interop (documented);
zero freestanding `verbNoun()`.

### Wave 5 — Config → single-run state model (northstar 3.6) — swap
**Owns:** `src/config/SquashageConfig.ts`, `src/cli/dagonizerCli.ts` (4 `cfg.targets[...]` sites),
`SquashageRun.ts` (`forTarget` → single-run entry).
- Replace `{ input, targets: Record<name, TargetConfigInterface> }` with one validated single-run
  state: `input, output, graphs, ontology, classification, enrichment, quarantine, concurrency,
  subjectIri`. **Decide explicitly** whether `enrichment`/`concurrency` survive (default: keep both —
  they are genuine knobs).
- CLI: drop the `--target` indirection; one run = one state file + the orchestration document.
- `SquashageRun.forTarget` → `SquashageRun.forRun` (single corpus → single graph).
**Gate:** `npm run check` + full corpus projection (wave 6).

### Wave 6 — Real-projection validation (corpus available)
Run a full Ripperoni output corpus (path from user when reached) through Squashage → RDF: SHACL
clean, expected triple counts, zero unexpected quarantine. Gate the merge on this, not unit tests
alone.

## 4. Northstar corrections to fold back

Once waves land, the northstar doc itself should be rewritten present-tense to drop the dead API
names (`.fanOut`/`.parallel`/`PredicateGateNode`/`DecisionNode`/`-executor-node`) and the
6-DAG / 2-dispatch / 10-classifier undercounts. (Defer until execution confirms the corrected shape.)
