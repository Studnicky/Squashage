# Squashage Architecture

Squashage is a graph reconstitution pipeline. It starts with structured JSON
records and ends with a single serialized RDF file produced by the build run.

```text
Squashage
  JSON record -> classify -> normalize -> RDF/JS quads -> serialized file
                                                          (turtle | trig | nquads | ntriples | jsonld
                                                           rdfxml + n3: deferred; no maintained streaming serializer on npm)
```

RDF/JS is the **internal canonical product** of the build — the shape every
plugin emits into and the serializer reads from. It is not the output. The
output is the file. To load the file into a graph store, hand it to
downstream graph-store loaders separately; Squashage does not load stores.

**Why this ordering**: The pipeline isolates failure modes by stage. Classify-and-fail (unknown class, SHACL violation, schema mismatch) produces quarantine artifacts without corrupting the dataset. Normalize failures are contained to that record and later stages skip it cleanly. Project failures write the bad record to quarantine and don't emit partial quads. This ordering means a config mistake doesn't corrupt valid data that's already been emitted.

## Package Boundaries

Squashage *uses* a thin `src/rdf/*` and `src/shacl/*` wrapper layer over
permissive open-source RDF libraries (`@rdfjs/data-model`, `@rdfjs/dataset`,
`@rdfjs/namespace`, `n3`, `jsonld`, `rdf-canonize`, `rdf-validate-shacl`)
for every RDF/JS implementation detail. It does not vendor those
implementations directly into application code, and it does not own
graph-store loading. The boundary is the `src/rdf/*` / `src/shacl/*` wrapper, not a specific underlying package.

| Package | Owns | Does Not Own |
|---------|------|--------------|
| Squashage | classification, normalization, projection of records into RDF/JS, pipeline + task registry, single-file output and quarantine reports | RDF/JS implementations (factory, dataset), parser/serializer code, graph-store loading, format → format translation |
| Semantics | RDF/JS factories and datasets, parse/serialize for all supported formats, store adapters (in-memory, embedded, remote), canonicalization, validation, vocabulary, IRI utilities, reasoning, format and store CLIs | source extraction, source-specific classification |
| aonprd plugin | ontology conventions and runtime graph usage that consumes squashage output | source extraction, generic classification framework |

## Core Concepts

### Input Record

An input record is a single JSON object. It should include optional `_source`
metadata to make classification reproducible and attribution tractable:

```json
{
  "_type": "feat",
  "name": "Power Attack",
  "level": 1,
  "rarity": "common",
  "traits": ["flourish"],
  "_source": {
    "target": "aonprd",
    "path": "feat-power-attack.json",
    "url": "https://2e.aonprd.com/Feats.aspx?ID=750",
    "plugin": "aonprd:parse"
  }
}
```

**Determinism contract**: The entire classification and projection pipeline is deterministic. No `Math.random`, no `Date.now()` inside the build path, no network calls, no filesystem reads after config load. Same record and same config produce byte-identical quads and exit codes across runs and machines. This is what lets you compare output bit-for-bit in CI.

### Classification

Classification identifies the ontology class or projection lane for an input
record. It is not just a label; it is a decision with evidence.

```json
{
  "type": "feat",
  "confidence": 1,
  "engine": "schema+rules",
  "reasons": [
    "_type=feat",
    "level present",
    "schema:feat matched"
  ]
}
```

**Per-record state machine**: Each record flows through: (1) input (parsed JSON + source); (2) classify (zero or more proposals accumulated); (3) conflict resolution (one winner picked, or quarantine); (4) project (emit quads using the winning class) or skip (unknown + onUnknown: skip); (5) output (final dataset serialized) or quarantine (SHACL failure). A single state.classification value at step (3) controls whether projection happens.

### RDF/JS As Internal Canonical Product

Plugins emit RDF/JS terms and quads into a shared dataset. The canonical
factory and dataset come from `src/rdf/DataFactory.ts` and
`src/rdf/Dataset.ts` (v0.x backed by `@rdfjs/data-model` and
`@rdfjs/dataset`); convenience builders come from `src/rdf/GraphBuilder.ts`
(vendored from semantics/rdf-builder). Plugins do not write Turtle,
JSON-LD, or any other format directly — they emit quads, and the finalize
step serializes the canonical dataset to the configured output file via
`src/rdf/Serializer.ts`.

**Why RDF/JS**: RDF/JS is a standard interface contract, not a concrete implementation. This lets you test plugins in isolation by passing a mock dataset that collects what was added, then swap to the real factory/dataset at run time. Serializers and validators also accept any RDF/JS-compliant dataset, so output format becomes a plugin detail, not a structural constraint. If a future plugin needs to emit into both Turtle and JSON-LD, it writes to RDF/JS once and the serializer picks the format.

`PipelineStateInterface` and `PipelineContextInterface` keep their existing
names from `src/types/PipelineState.ts`; their fields adapt to the
graph-reconstitution domain. The full type definitions live in
`src/types/PipelineState.ts` and are documented inline; plan 13 carries
the rationale and the `ClassificationProposalInterface` /
`ClassificationEvidenceInterface` shapes the cascade populates.

### File Output

The output is a single serialized RDF file in one of the formats
squashage's `src/rdf/Serializer.ts` supports. Turtle, TriG, N-Triples, N-Quads, JSON-LD are supported now. RDF/XML and N3 output are deferred — no maintained streaming serializer exists on npm and that is not Squashage's problem to solve. Format defaults from the file extension via
`src/rdf/Formats.ts`.

A target must declare an `output` block. To produce more than one file,
re-run the build with a different `--out`. To translate between formats
or load into a graph store, use any RDF format converter or graph-store
loader of your choice on the produced file — neither is squashage's
job. See
`src/schemas/output.schema.json` and `src/rdf/Serializer.ts` define the output interface and configuration.

Programmatic callers can also consume the in-process dataset directly
through the build API; that is not an output, just the API return value.

## Pipeline Phases

1. `json:read`: load one JSON object and attach source metadata.
2. `classify:*`: determine candidate and final class with evidence.
3. `normalize:*`: canonicalize labels, slugs, numbers, dates, and IDs.
4. `squash:*`: project the record into RDF/JS quads using
   `src/rdf/GraphBuilder.ts` against the canonical dataset.
5. `rdfjs:finalize`: serialize the canonical dataset to the configured
   output file via `src/rdf/Serializer.ts`, run any configured
   canonicalization (`src/rdf/Canonicalize.ts`) and SHACL validation
   (`src/shacl/ShaclGate.ts`), and write the output report.

## Failure Policy

Failures land as explicit artifacts on disk:

- Unknown class: `./graphs/<target>/quarantine/unknown/<id>.json`.
- Classification conflict: `./graphs/<target>/quarantine/conflicts/<id>.json`
  with the tied candidates preserved.
- Projection failure (parse error in `json:read`, throw in a `squash:*`
  task): `./graphs/<target>/quarantine/projection/<id>.json`.
- Pre-write SHACL failure: `./graphs/<target>/quarantine/output/validation.report.{txt,ttl}`.
  The destination output file is not written.
- Atomic-write failure: a `<output.path>.partial` artifact alongside the
  intended destination, plus the run's `output.report.json`.

Quarantine is a *graceful* path. `json:read` and the classifier tasks
short-circuit with a quarantine write rather than throwing, so the
per-record pipeline registers no failure and the build exit code stays
`0`. Quarantine artifacts on disk are how the caller learns which
records were rejected. Exit codes:

- `0` — every record either projected cleanly or landed in quarantine
  gracefully.
- `1` — a per-record task threw, or `rdfjs:finalize` threw (output,
  validation, atomic-write).
- `2` — config / schema / startup error before any record processed.

## Implementation History

The scraper layer (HtmlScraper, MediaWikiScraper, LinkLister,
ScrapeOrchestrator, the cache, the rate limiter, the retry executor)
was deleted during the initial bootstrap. `PipelineStateInterface` and
`PipelineContextInterface` kept their names but redefined their fields
for the graph-reconstitution domain. Built-in classification tasks live
in `src/classification/tasks/`; the predicate engine in
`src/classification/predicates/`; configuration in
`src/schemas/*.json`. The full implementation record is in `src/classification/tasks/` and `src/schemas/`.
