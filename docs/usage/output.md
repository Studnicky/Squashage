---
layout: doc
title: Output
---

# Output

The build produces one file per target. That's the contract. Pick a format, give it a path, run the build. The file appears on disk.

Source of truth for the full schema: `src/schemas/output.schema.json`.

## Formats

Five formats ship now:

| Format | Extension | Notes |
|--------|-----------|-------|
| `turtle` | `.ttl` | Triple-only. Named-graph quads are collapsed to a single graph (set `output.graph` or lose the graph info). |
| `trig` | `.trig` | Quad format. Named graphs preserved. Good default when you have multiple classes in separate graphs. |
| `ntriples` | `.nt` | Triple-only. Like Turtle but no prefixes, no compact syntax. |
| `nquads` | `.nq` | Quad format. Like TriG but no prefixes. Canonical form for RDFC-1.0. |
| `jsonld` | `.jsonld` | JSON-LD, compacted with a `@context`. The context is auto-built from the quad set unless you supply one. |

RDF/XML and N3 output are deferred. No maintained streaming serializer for either format exists on npm, and Squashage is not going to be the one to write one.

Format defaults from the file extension. Explicit `format:` overrides.

**Format selection rationale**: Turtle is human-readable and compact for graph inspection. TriG is readable and preserves named graphs for multi-class organization. N-Quads is the canonical form for content-addressed storage and bit-for-bit reproducibility. JSON-LD is linked-data-friendly when your downstream consumer expects it. All formats serialize the same RDF/JS dataset; the difference is syntax and verbosity, not semantic content.

---

## mode: dataset vs stream

**`dataset`** (default) buffers the full graph in memory, runs any post-processing (canonicalization, SHACL), then writes the file in one shot. Works for any size dataset your machine can hold in RAM. Enables `canonicalize` and `validate`.

**`stream`** writes quads as they arrive from the `squash:*` task, before `rdfjs:finalize` has the full dataset. Lower memory footprint, but `canonicalize` and `validate` are disabled; you can't canonicalize a partial graph. The AJV schema rejects `stream + canonicalize: true` at config load.

---

## canonicalize: true

RDFC-1.0 canonicalization (from `rdf-canonize`). Normalizes blank node labels and sorts the quad set. The result is byte-identical across runs and machines; same JSON in, same quads out, same bytes on disk.

Use this when:
- You want reproducible output for CI comparison (`git diff` on the file is meaningful).
- You're feeding the output into a content-addressed store.
- You want to sign or hash the graph.

Costs: `dataset` mode only (buffers everything first), extra CPU for the canonicalization pass. Not worth it if you're just doing a one-off export.

**Canonicalization purpose**: Blank nodes are nondeterministic (each run generates new labels). Without canonicalization, two runs produce semantically identical graphs with different byte sequences. Canonicalization deterministically relabels blank nodes and sorts all quads so the output is invariant. This enables CI tests that compare output files bit-for-bit and detect unintended changes.

---

## validate.shapes

Pre-write SHACL gate. When configured, `src/shacl/ShaclGate.ts` validates the canonical dataset against the shapes graph before writing the output file.

```json
"validate": {
  "shapes": "./schemas/aonprd.shapes.ttl"
}
```

`shapes` is a path to any RDF format file that contains SHACL shapes. It's loaded via `src/rdf/Parser.ts` at run startup.

On non-conformance:
- The output file is **not** written.
- A text report lands at `graphs/<target>/quarantine/output/validation.report.txt`.
- A machine-readable report lands at `graphs/<target>/quarantine/output/validation.report.ttl`.

The build exit code stays `0`; SHACL failure is a quarantine event, not a crash. Your CI can check for the `.report.ttl` file existence to detect shape violations.

Incompatible with `stream` mode.

---

## dryRun

```json
"dryRun": true
```

Runs the full pipeline; reads records, classifies, projects quads, runs canonicalization and SHACL validation if configured; but skips writing the output file. Useful for smoke-testing config and plugins against real data without producing output.

Quarantine artifacts still land on disk (quarantine is a graceful path, not a dry run concern).

**dryRun semantics**: Skips the atomic-write step after SHACL validation passes. The dataset is fully populated and validated; the only step omitted is the file write. This lets you test whether a config change will break SHACL validation without clobbering your production output file. Exit code stays `0` if the pipeline completes cleanly; SHACL failures still exit with `1` (same as a normal run would).

---

## output.graph (triple-only format + named graphs)

If your target emits named-graph quads and you're writing to a triple-only format (Turtle, N-Triples), you need to tell the serializer what to do with the graph IRIs. Set `output.graph` to collapse all quads into one named graph:

```json
"output": {
  "kind": "file",
  "path": "./graphs/aonprd.ttl",
  "graph": "https://squashage.dev/graph/aonprd"
}
```

Omitting `output.graph` when you have named-graph quads and a triple-only format is a runtime error; the serializer can't silently drop graph information.

---

## jsonldContext

By default, squashage builds a `@context` automatically from the produced quad set plus `ctx.prefixes`. The auto-built context:
- Maps every prefix in `ctx.prefixes` to its base IRI.
- Sets `@type: @id` for predicates whose objects are all named nodes.
- Sets `@container: @set` for predicates whose objects form arrays.
- Sets `@type: xsd:integer` etc. for predicates whose objects are typed literals.

If you're hoping for `@type` to come from somewhere, here's where: `_source.url`. The host gets pattern-matched to a vocabulary base, and any IRI under that base gets compacted in the JSON-LD context.

To override: supply a path string (resolved relative to config file) or an inline object:

```json
"jsonldContext": "./context/aonprd.context.jsonld"
```

```json
"jsonldContext": {
  "@context": {
    "aonprd": "https://squashage.dev/vocabulary/aonprd#"
  }
}
```

`jsonldContext` is cross-validated against `format`; rejected at config load when format is not `jsonld`.

---

## Failure artifacts

When output fails, squashage writes artifacts instead of silently exiting:

| Scenario | Artifact |
|----------|---------|
| SHACL failure | `graphs/<target>/quarantine/output/validation.report.{txt,ttl}` |
| Atomic write failure | `<output.path>.partial` alongside the destination + `output.report.json` |

Exit codes:
- `0`: every record projected cleanly or landed in quarantine gracefully.
- `1`: a task threw, or `rdfjs:finalize` threw.
- `2`: config/schema/startup error before any record processed.

---

## Related

- [Configuration](./configuration); full output config schema
- [Pipeline](./pipeline); where rdfjs:finalize sits in the queue
- [Classifier cascade](./classifier-cascade); how quarantine works at the classification layer
