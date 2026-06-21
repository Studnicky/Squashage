# Squashage dagonizer migration — phased plan (post-merge)

State as of the merge of PR #45 (`feat(dagonizer-port): migrate to native @studnicky/dagonizer@0.25`)
into `develop` (`6588802`). This plan covers what remains, structured for agentic dispatch.

## Overall objective

A fully dagonizer-native Squashage that consumes Ripperoni's typed JSON, classifies each record,
and projects the **entire** corpus to clean RDF — SHACL-valid, expected triple counts, zero
*unexpected* quarantine — and is publish-ready on GitHub Packages.

## Done (merged to develop)

- **Native engine** — `@studnicky/dagonizer@^0.25.0` (published, GitHub Packages). Every node a
  `ScalarNode` with `executeOne` + `outputSchema`; typed state; 0.25 dispatcher/observer hooks.
- **Authored DAG documents** — 7 committed `src/dag/*.dag.jsonld` loaded via `DAGDocument.load`;
  `build:assets` mirrors documents + schemas into `dist/`.
- **Native composition** — `dispatcher.registerBundle(DispatcherBundleType)`; native `scatter { dag }`
  fan-out (metadata-seeded `record-init`, services-sink collect); hand-dispatch nodes deleted.
- **json-tology published** — `@studnicky/json-tology@^0.26.0` replaces the file link;
  `legacy-peer-deps=true` pins the eyereasoner/@rdfjs peer mismatch consistently for local + CI.
- **CI green** — all 7 checks pass (lockfile, changelog, license, security, macOS/Ubuntu × node 22/24).
- **Lenient projection (#7)** — landed in `JsonTologyOntology.ts` (+ tests). *Effect on the corpus
  quarantine rate is not yet re-measured — see Phase 1.*
- **Port mechanics validated (#6)** — 75-record parse corpus → 8,061 quads; scatter/seed/sink/finalize
  proven. Full-corpus clean run still pending.

## Known remaining work

- **Wave 5** — config single-run model (collapse the `targets` map; manifest §3.6).
- **Full-corpus validation** — project all 13,945 records; SHACL-clean, expected counts, quarantine audit.
- **Docs** — rewrite `dagonizer-native-northstar.md` present-tense (drop dead API names
  `.fanOut`/`.parallel`/`PredicateGateNode`/`DecisionNode`/`-executor-node`; correct 6→7 DAGs,
  2→3 dispatch sites, 10→12 classifiers); reconcile/retire `dagonizer-migration-manifest.md`;
  keep `dagonizer-0.25-port-cookbook.md` as reference.

## Discovered work (tracked)

- **json-tology #126** — transient `$ref` denormalization workaround in `JsonTologyOntology.ts`;
  remove when upstream ships the ABox `$ref` fix.
- **eyereasoner peer mismatch** — `legacy-peer-deps` masks eyereasoner's `@rdfjs/types@^1` peer vs
  the project's `^2`; track an eyereasoner update to drop the workaround.
- **Concurrency static-in-document delta** — the run DAG bakes a default concurrency into
  `squashage-run.dag.jsonld`; per-run config concurrency is applied at build time via `RunDag.build`.
  Resolve cleanly in the config wave.
- **Stale docstrings** — `recordInitNode` says `.phase` but is wired as a `.node` entrypoint;
  `bootstrapDag.ts`/`recordInduceDag.ts` carry dangling JSDoc references to the deleted registrars.
- **`as unknown` serialization casts (~77)** — sanctioned `snapshotData`/`restoreData` JSON casts;
  optionally tighten with typed `toJSON`/`fromJSON` serializers.
- **Compiled-CLI end-to-end** — `copy-dag-assets` now mirrors `.schema.json`; confirm a full
  projection runs from `dist/` (not just `tsx`).

## Phases (agentic dispatch)

### Phase 1 — Validate leniency + full corpus  *(closes #6/#7)*
Confirm the lenient-projection work actually drops the quarantine rate, then prove the full corpus.
- Re-run the 75-record smoke; expect quarantine ≈ 0 (was 26/75 pre-leniency).
- Run the full 13,945-record corpus (`/Users/studs/Workspace/ripper/output/aonprd:crawl/aonprd:page`
  or the canonical parse corpus); audit SHACL validity, triple/graph counts, and every quarantine.
- **Dispatch:** one agent runs the projection + classifies remaining quarantines (real-data vs
  schema-strictness vs port); coordinator reviews the artifacts directly.
- **Gate:** zero *unexpected* quarantine; expected per-class triple counts; SHACL clean.

### Phase 2 — Config single-run model  *(wave 5)*
- Replace `SquashageConfig { input, targets: Record<…> }` with one validated single-run state
  (`input, output, graphs, ontology, classification, enrichment, quarantine, concurrency, subjectIri`).
- CLI: drop the `--target` indirection — one run = one state file + one orchestration document.
- `SquashageRun.forTarget` → `forRun`; fold concurrency into the state model (resolve the document delta).
- Update the example + smoke configs.
- **Dispatch:** wave 2a (config schema + state types, one agent) → wave 2b (CLI + run composition,
  one agent); coordinator reviews at the boundary.
- **Gate:** `npm run check` green + a real projection identical to Phase 1 output.

### Phase 3 — Docs, hygiene, release prep
- Rewrite the northstar present-tense; reconcile the manifest; fix the stale docstrings.
- Confirm the compiled CLI runs a full projection from `dist/`.
- File issues for the transient workarounds (json-tology #126, eyereasoner peer).
- CHANGELOG finalize; cut a release (`develop` → `master`, tag) via the release flow if desired.
- **Dispatch:** parallel doc agents over disjoint files; coordinator reviews.

### Phase 4 — (optional) tighten serialization casts
- Replace the sanctioned `as unknown as JsonValueType` snapshot casts with typed serializers.

## Sequencing

Phase 1 first (validate the green baseline before further change). Phase 2 is largely independent
but should follow Phase 1 so the config refactor is checked against a known-clean projection.
Phase 3 after 1+2. Phase 4 any time.
