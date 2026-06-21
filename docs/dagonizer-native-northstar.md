# Squashage → native dagonizer: the northstar (and what to clear out)

This is the reference for migrating Squashage to a fully native `@studnicky/dagonizer@0.24`
build, modelled on Ripperoni — which just shipped this exact migration (v3.0.0), validated
by a full live rip of 13,892 records with zero failures. It records (1) how Ripperoni works
as the northstar, (2) the native build pattern, and (3) the specific reinventions Squashage
must clear, each mapped to how Ripperoni handled it.

## 0. Where Squashage sits (the layering — don't blur it)

**Ripperoni emits typed JSON records** (one per source page). **Squashage consumes them,
classifies each, and projects to an RDF graph** (TBox / SHACL / ABox). Squashage owns
`classification`, `ontology`, `shacl`, `rdf`, `induction`, `quarantine`, `observer`. Do not
push RDF/classification concerns up into Ripperoni, and do not re-parse source HTML in
Squashage. The two are one pipeline across two repos; the seam is Ripperoni's JSON output.

## 1. Northstar — how Ripperoni works

- **A run is two authored documents**: one orchestration `<name>.dag.jsonld` (a single
  dagonizer DAG) + a `<name>.state.json` (run params, schema-validated). Executed by one
  command: `ripperoni run <dag.jsonld> --state <state.json>`.
- **DAGs are authored JSON-LD documents**, not built at dispatch. A DAG is composed with
  `DAGBuilder` once, serialized via `DAGDocument.serialize`, committed as `*.dag.jsonld`, and
  loaded at runtime with `DAGDocument.load`. Plugins ship their DAGs as documents too.
- **Composition is native.** An orchestration imports a child DAG via `EmbeddedDAGNode { dag }`
  (one invocation) or `ScatterNode { body: { dag } }` (fan-out, one child run per item). **No
  node ever calls `dispatcher.execute(childDag)` by hand.** The engine forks children on the
  one dispatcher; `stateMapping` moves keys parent↔child.
- **Nodes are `ScalarNode` instances** implementing `executeOne(state, context)`. They read
  config from typed `services` (seeded from the validated state) — never from an untyped
  `cfg` bag or `as unknown` cast.
- **Isolation is an edge primitive.** Parallel/worker execution is `container: "worker"` on a
  scatter placement + a `DagContainerInterface` backend (`WorkerThreadContainer` from
  `@studnicky/dagonizer-executor-node`) bound via `new Dagonizer({ containers })`. No custom
  worker pool. An unbound role is inert (runs in-process), so declaring it is always safe.
- **The runner is a thin composition root**: load the document, build domain services from
  state, register builtin + plugin nodes and DAGs, dispatch. No runtime pipeline→DAG compiler,
  no multi-DAG bundle file, no hand-rolled topological sort.
- **Build copies assets.** `tsc` emits only `.js`; a `build:assets` step mirrors authored
  `*.dag.jsonld` under `src/` into `dist/` so the compiled CLI finds DAGs it loads by path.

Reference: `~/.claude/plans/ripper-dag-native-setup.md` and Ripperoni's
`docs/guide/` / `docs/diagrams.md`.

## 2. The native build pattern (generalized)

1. Author each DAG with `DAGBuilder` → serialize to a committed `.dag.jsonld`.
2. Implement nodes as `ScalarNode` subclasses; export instances; register them on the
   dispatcher (builtins directly, plugin nodes via a `register(dispatcher)` entry).
3. Compose DAGs only through `EmbeddedDAGNode`/`ScatterNode{dag}` placements in the document.
4. Bind containers for isolation at the placement edge, not in a node.
5. A thin runner loads the document(s), builds typed services from a validated state file,
   registers, and `dispatcher.execute(rootName, state)`.
6. Copy `.dag.jsonld` assets into `dist` at build.

## 3. What Squashage must clear out

Squashage's file-linked `@noocodex/dagonizer` already resolves to `@studnicky/dagonizer@0.24.0`
(`node_modules/@noocodex/dagonizer/package.json` → name `@studnicky/dagonizer`, version `0.24.0`),
so the engine binaries are current. The cruft is in the wiring, not the engine version.

### 3.1 Dead dependency name — `@noocodex/dagonizer` → `@studnicky/dagonizer@0.24`

`package.json` declares `"@noocodex/dagonizer": "file:../Dagonizer/packages/dagonizer"` and the
code imports `from '@noocodex/dagonizer'`. Migrate to the published package, exactly as Ripperoni
did:
- `package.json`: `"@studnicky/dagonizer": "^0.24.0"` (+ `"@studnicky/dagonizer-executor-node": "^0.24.0"` if you adopt worker containers); add an `.npmrc` routing the `@studnicky` scope to GitHub Packages.
- Rewrite every `from '@noocodex/dagonizer...'` import to `'@studnicky/dagonizer...'`.

### 3.2 Manual sub-dispatch nodes → native scatter `{ dag }`  **(the big one)**

`src/nodes/run/recordDispatch.ts:56` does, inside a node's `execute`:
```ts
const result = await dispatcher.execute(dagName, recordState);
```
and `createDraftDispatchNode` does the same for drafts. The run DAG wires them as the fan-out
body: `.fanOut('process-all-records', recordDispatch, 'locators', …)`. **This is precisely the
nested-sub-dispatch anti-pattern Ripperoni deleted** (its `LinkLister`/`CrawlListTargetsNode`
spun a child run by hand). A node holding the dispatcher and running a child DAG per item is
"working against the framework."

Replace with a **dag-body fan-out** — the engine forks the child DAG itself:
```ts
.fanOut('process-all-records', { dag: 'squashage:record' }, 'locators', { gather… }, { stateMapping… })
```
Delete `recordDispatch.ts` / `createDraftDispatchNode` and the dispatcher reference they hold.
Use `stateMapping` to seed each child `SquashageRecordState` from the locator and gather the
record summary back. (Ripperoni's `aonprd:crawl` orchestration scatters `aonprd:page` exactly
this way; its `crawl:discover` is embedded via `EmbeddedDAGNode` with output mapping.)

### 3.3 Runtime DAG building with `stub()` placeholders → authored `.dag.jsonld` documents

`src/dag/*.ts` (`recordDag`, `recordInduceDag`, `induceDag`, `refineDag`, `refineOneDag`,
`bootstrapDag`) build DAGs inline at startup inside `SquashageRun.forTarget`, using `stub()`
placeholder nodes that throw:
```ts
.node('classify:source', stub('classify:source', ['proposed', 'no-match'] as const), {…})
```
with the real classifier nodes registered separately and matched by name. There are **no
committed `.dag.jsonld` documents** — the opposite of the northstar.

Author each DAG once (`DAGBuilder` → `DAGDocument.serialize`) into a committed
`src/dag/*.dag.jsonld`, register the real `ScalarNode` instances, and load the documents via
`DAGDocument.load` at runtime. The document references node names; the `stub()` indirection
disappears (the names resolve to the registered instances). Add a `build:assets` step copying
`src/**/*.dag.jsonld` into `dist/` (Ripperoni's `scripts/copy-dag-assets.mjs`) — without it a
built CLI that loads a DAG by path crashes `ENOENT`.

> Note: the *classifier* fan-out (`classify-all` via `.parallel()`/`.fanOut()` over the 10
> classifiers, with `ClassifyConflictNode` as the reducer) is legitimate native composition —
> keep it. The reinvention is only the **record-level** fan-out that hand-dispatches a child
> DAG (3.2), and authoring the DAGs in code instead of as documents (this section).

### 3.4 Freestanding verb-noun node factories

`createRecordDispatchNode`, `createDraftDispatchNode`, `buildReadyGateNode` are freestanding
`verbNoun()` functions — forbidden by the shared CLAUDE.md (`⊥ makeX/buildX/createX`). Most
vanish with 3.2/3.3; for any survivor, hang it off a class (a static factory on the node type)
or export a node instance.

### 3.5 `as unknown` state-mutation casts

~115 `as unknown` casts, the worst being state mutation, e.g.
`(state as unknown as { squashedQuads: Quad[] }).squashedQuads = [quad]` (`squashNode.ts`). Add
typed mutators/fields to the `*State` classes and drop the casts (CLAUDE.md `⊥ as unknown`).
Ripperoni removed its `target.cfg` `as unknown` bag the same way — typed services off validated
state.

### 3.6 The `targets` config tree

`SquashageConfig` requires `{ input, targets: Record<name, TargetConfigInterface> }` — a
multi-target map (`required: ['input', 'targets']`). Ripperoni removed its analogous
`targets`/`output` config tree: **one run = one orchestration document + one state file.** Align
Squashage: a run projects one input corpus → one graph, configured by a single state document
(keep the genuine knobs — `input`, `output`, `graphs`, `ontology`, `classification`,
`quarantine`, `subjectIri` — validated by a schema). Drop the `targets` indirection; the
orchestration `.dag.jsonld` + the state name the run. (If multi-target batching is wanted, it's
N runs, or a scatter over inputs — not a config map the runner unrolls.)

### 3.7 Object-literal nodes → `ScalarNode` classes

`export const defaultSquashNode = { name, outputs, execute }` and peers are object literals
implementing `NodeInterface` directly. For consistency with the batch contract and the rest of
the migration, prefer `class XxxNode extends ScalarNode<TState, TOutput, SquashageServices>`
exporting an instance, with the per-item work in `executeOne`.

## 4. What Squashage keeps (the genuine domain — do not touch)

None of these are framework reinvention; they are Squashage's reason to exist. Keep them; only
the orchestration/dispatch wiring above changes.

- **`classification/`** — the predicate DSL (`Predicate`, `PrefixResolver`) and the 10 classifier
  nodes (`Source/UrlPattern/Structural/Rules/Schema/ShaclShape/PropertyFingerprint/WinknlpEntities/Ontology/Discriminator`) + `ClassifyConflictNode`.
- **`induction/`** — `SchemaInducer`, `ShapeObservation`, `SubjectIriPolicy`, `RefinementApplier`,
  `TaxonomicInheritanceEnricher`, `VocabEnricher`.
- **`ontology/`** — `JsonTologyOntology` (TBox/SHACL/ABox via `json-tology`).
- **`rdf/`** — `DataFactory`, `Dataset`, `GraphBuilder`, `Serializer`, `Parser`, `Canonicalize`,
  `RdfStar`, etc. (rdfjs + n3; no custom triple store — good).
- **`shacl/`** — `ShaclGate` (rdf-validate-shacl).
- **`quarantine/`** — `QuarantineWriter`.
- **`observer/`** — `ProvObserver` (PROV-O). Keep it as a thin `Dagonizer` subclass hook
  forwarder, exactly like Ripperoni's `RipperDagonizer`.

Where dagonizer 0.24 ships a primitive that matches a hand-rolled piece, prefer the native one:
the SHACL ready-gate maps to `PredicateGateNode`; a classifier that picks among options maps to
`DecisionNode`/structured output; per-record fan-out is `ScatterNode`. Verify before reaching for
a bespoke version.

## 5. Migration order (sprout-then-swap, gated like Ripperoni)

1. **Dep swap + imports** (3.1) — compile green against published 0.24.
2. **Author the DAGs as documents** + `build:assets` (3.3) — keep the runtime path working in
   parallel until the documents load and dispatch identically.
3. **Native record/draft fan-out** (3.2) — delete the hand-dispatch nodes; scatter `{ dag }`.
4. **`ScalarNode` classes, drop factories, typed state** (3.4, 3.5, 3.7).
5. **Config → single-run state model** (3.6).
6. **Validate with a real projection** — run a full Ripperoni output corpus through Squashage to
   an RDF graph and check it (SHACL clean, expected triple counts, zero unexpected quarantine),
   the way Ripperoni's full rip validated the native model. Gate every wave on
   `npm run check` + a real projection; never trust unit tests alone for the wiring.

## 6. Northstar in one line

Squashage is a dagonizer-native projection pipeline: it consumes Ripperoni's typed JSON,
classifies each record, and emits RDF. Its DAGs are authored documents; composition is native
embedded-dag/scatter; nodes are `ScalarNode` instances reading typed services; no node
hand-dispatches a child DAG; the RDF/classification domain stays. Mirror Ripperoni's
`run` + document model — not a bespoke runner.
