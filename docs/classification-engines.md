# Classifier Engines

Squashage's classification cascade is purely deterministic. Same inputs
plus same config produce byte-identical proposals and final
`state.classification` across runs and machines. No `Math.random`, no
`Date.now()`, no network, no fs after startup. No probabilistic models
in the build path.

The implemented engine surface is the deterministic classifier menu
described in
`src/schemas/predicate.schema.json` and `src/classification/tasks/`.
This document covers the *why* behind those engine choices and the
considered alternatives that did not ship.

## What Ships

Six idiomatic classifier task classes. Targets pick which to use by
listing them in `pipeline:`; each task's config block must be present
and non-empty (cross-validation enforces this at config-load).

| Task | Engine | Source file |
|------|--------|-------------|
| `classify:source`     | reads `_source` from the record; emits a marker proposal | `src/classification/tasks/SourceClassifier.ts` |
| `classify:structural` | closed-vocab predicate over normalized facts             | `src/classification/tasks/StructuralClassifier.ts` |
| `classify:rules`      | closed-vocab predicate decision table                    | `src/classification/tasks/RulesClassifier.ts` |
| `classify:schema`     | per-class JSON Schema via pre-compiled AJV validators    | `src/classification/tasks/SchemaClassifier.ts` (over `src/classification/AjvClassifier.ts`) |
| `classify:ontology`   | validates proposals against a known className → IRI map  | `src/classification/tasks/OntologyClassifier.ts` |
| `classify:conflict`   | priority desc + className lex asc tiebreak; quarantines  | `src/classification/tasks/ConflictResolver.ts` |

Each task is an idiomatic class with a public constructor that takes
its frozen, AJV-validated config at run startup. Per-record execution
allocates only the proposal array. `ClassificationFactory.build`
instantiates the set per target; `SquashageOrchestrator` registers each
instance's bound `execute` on a fresh per-run `TaskRegistry`.

**Classification state machine**: (1) propose: each task accumulates proposals onto `state.classifications`, a growing array. (2) conflict detection: ConflictResolver examines all proposals, filters metadata sentinels (`__source__`, `__validation__`), and checks for ties on priority. (3) resolution: picks one winner by priority desc, then className lex asc as tiebreak. (4) emit or quarantine: writes the winning class to `state.classification`, or quarantines the record if onConflict/onUnknown policies say so.

## Predicate Vocabulary

`StructuralClassifier` and `RulesClassifier` consume compiled
predicates from `src/classification/predicates/Predicate.ts`. The
operator set is closed and validated at config-load against
`src/schemas/predicate.schema.json`:

| Operator | Shape |
|----------|-------|
| `equals` / `notEquals`   | `{ path, equals \| notEquals: <constant> }` (deep structural equality) |
| `in` / `notIn`           | `{ path, in \| notIn: [<constants>] }` |
| `exists` / `missing`     | `{ path, exists \| missing: true }` |
| `type`                   | `{ path, type: 'string' \| 'number' \| 'boolean' \| 'object' \| 'array' \| 'null' }` |
| `regex`                  | `{ path, regex: '^...$' }` (anchors required; no flags) |
| `length`                 | `{ path, length: { gte?, lte?, eq? } }` (strings + arrays) |
| `range`                  | `{ path, range: { gte?, lte?, gt?, lt? } }` (finite numbers) |
| `all` / `any` / `not`    | composition |

Paths are RFC 6901 JSON Pointers (`/types/0`, `~1` escapes `/`,
`~0` escapes `~`). Empty pointer (`""`) is rejected at compile.

Compilation pre-builds RegExp objects and pre-splits path segments;
runtime evaluation is a single switch over the AST.

**Worked example**: A feat record with `_type: 'feat'`, `level: 5`, and `traits: ['action']` matches: `{ all: [{ path: "/_type", equals: "feat" }, { path: "/level", range: { gte: 1, lte: 20 } }, { path: "/traits", type: "array" }] }`. Regex paths require full anchoring: `{ path: "/url", regex: "^https://2e\\\\.aonprd\\\\.com" }` matches but `{ path: "/url", regex: "aonprd" }` does not. Compilation happens once at startup; runtime is deterministic and zero-allocation.

## AJV Schema Engine

`AjvClassifier` runs records against an ordered set of pre-compiled AJV
validators (one per class). Schema files are read by
`ClassificationFactory.build` at run startup, parsed, and compiled
through a single AJV instance with `addFormats` and strict mode (matching
`SquashageConfig`). The engine itself does no I/O and no compilation.
Per-class entries carry `{ className, priority, validate }`.

**Compilation rationale**: Schemas are compiled once at config load, not per-record. This costs CPU upfront but eliminates the per-record overhead of parsing schema syntax and building validators. A record flowing through an AJV validator is just a function call; no interpretation or meta-programming at runtime. This keeps classification fast and deterministic even with large, complex schemas.

## SHACL Validation

SHACL validation runs through `src/shacl/ShaclGate.ts` (v0.x backed by
`rdf-validate-shacl`). It is a
pre-write hook on `output.validate.shapes`: when configured, the gate
validates the canonical dataset against the shapes graph before the
output file is written. On non-conformance, `ShaclGate.formatReport` and
the report's W3C SHACL `dataset` are written to
`./graphs/<target>/quarantine/output/validation.report.{txt,ttl}` and
the destination output file is *not* written.

`SHACLValidator` is constructed without a `factory` option — the
validator's bundled `defaultEnv` is required (passing only
`@rdfjs/dataset`'s factory triggers `factory.clownface is not a
function`). `Dataset` from `@rdfjs/dataset` already implements the
`DatasetCore` shape `rdf-validate-shacl` accepts.

## Considered Alternatives (did not ship)

The following options were evaluated and rejected in favor of the
closed-vocab engine plus AJV. They are documented here for posterity
and to keep future contributors from re-running the same evaluation.

- **`json-rules-engine`**: open-ended fact callbacks, runtime function
  references, and operator extensibility break determinism guarantees.
  Closed-vocab predicates with AJV-validated config are equivalent for
  the v0.x rule shapes we need.
- **`json-logic-js`**: smaller surface than `json-rules-engine` but
  still admits arbitrary function shimming. Same determinism concern.
- **GoRules / Zen Engine**: useful when decision tables need a visual
  editor; for v0.x, the JSON rule arrays are edited as text and the
  closed-vocab AST is enough.
- **`natural` Bayes / logistic**: probabilistic; out of scope for
  canonical RDF/JS output. Could appear later as an *advisory*
  proposal generator that writes review artifacts only.
- **ONNX / embedding models**: probabilistic; same out-of-scope
  rationale.

If a future lane needs any of these, it lands as an *advisory*
classifier that writes proposals into `quarantine/<bucket>/` for human
review and never participates in the canonical RDF emission. The
`SHOULD NOT run in `squashage build`` rule from the original design
holds: a deterministic config update promotes a proposal, never a
probabilistic ranker.

## Embeddings (advisory only)

Embeddings help authoring, not classification. Useful for:

- finding duplicates across sources with different labels
- suggesting candidate ontology classes for unknown records
- aligning messy source fields to ontology predicates
- clustering quarantined records into batches

Output from any future embedding lane is written as proposals next to
the quarantine artifacts, with `status: "needs-review"` and a clear
`source` field. A deterministic config update (a new `classify:rules`
entry, a new schema, a new structural predicate) is what ever promotes a
proposal into the build.

## LLM / Reasoning Assistants (authoring tools only)

LLMs are useful for authoring config and explaining failures:

- drafting a `classify:rules` entry from a cluster of unknown records
- summarising a SHACL `validation.report.ttl`
- proposing a JSON Schema for a class
- generating test fixtures for new predicates

They do not run inside `squashage build`. The boundary is the same as
embeddings: deterministic config in, deterministic graph out.

## References

- AJV: <https://github.com/ajv-validator/ajv>
- N3.js (consumed via `src/rdf/Serializer.ts` and `src/rdf/Parser.ts`): <https://github.com/rdfjs/N3.js>
- jsonld.js: <https://github.com/digitalbazaar/jsonld.js>
- rdf-canonize: <https://github.com/digitalbazaar/rdf-canonize>
- rdf-validate-shacl: <https://github.com/zazuko/rdf-validate-shacl>
- W3C SHACL: <https://www.w3.org/TR/shacl/>
- W3C OWL: <https://www.w3.org/OWL/>
