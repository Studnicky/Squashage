# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Mechanism-depth expansions across user-facing docs (architecture, pipeline, classification-engines, classifier-cascade, configuration, output, plugins, viz) following the yamete-fidelity bar: problem framing, state machines, determinism contract, edge cases. Also fixed outdated cytoscape references in `docs/usage/viz.md` to reflect the sigma + graphology engine since v0.2.0.

## [0.3.0] - 2026-05-06

### Changed

- Dependency baseline refresh:
  - `typescript` 5.9.3 → 6.0.3
  - `@types/node` 22.19.17 → 25.6.0
  - `commander` 12.1.0 → 14.0.3
  - `globals` 15.15.0 → 17.6.0
  - `typescript-eslint` 8.59.0 → 8.59.2 (minor-and-patch group)
  - `eslint-ecosystem` group: 2 patch updates
- GitHub Actions baseline:
  - `actions/deploy-pages` 4 → 5
  - `actions/github-script` 7 → 9
  - `actions/upload-artifact` 4 → 7


## [0.2.1] - 2026-05-06

### Added

- `.github/dependabot.yml`: canonical dependabot configuration with npm + github-actions update groups. NPM updates split into eslint-ecosystem (major + minor + patch) and minor-and-patch (all others).
- `.github/labels.json`: GitHub label definitions (bug, enhancement, documentation, breaking-change, automated, dependencies, security, ci, stale, pinned, work-in-progress).
- `.github/workflows/changelog-check.yml`: validates CHANGELOG.md has entries for [Unreleased] on feature PRs or versioned entries for release PRs.
- `.github/workflows/license-check.yml`: security audit of dependency licenses, blocks GPL/AGPL/LGPL/UNLICENSED.
- `.github/workflows/security.yml`: npm audit + artifact upload (production + dev scopes).
- `.github/workflows/stale.yml`: auto-marks inactive issues / PRs after 30/14 days respectively.
- `.github/workflows/publish.yml`: publish to npm on main branch push (gated by NPM_PUBLISH_ENABLED, off by default). Validates changelog, checks version uniqueness, publishes with provenance, creates GitHub release.
- Cross-link to Ripperoni upstream in README and package.json description.

### Changed

- `.gitattributes`: line-ending normalization (LF) + binary file markers from json-tology canonical pattern. Preserved linguist hints for demo/build artifacts.
- `package.json` description: "squashes classified JSON records into deterministic RDF" (from classifies → reconstitutes).
- `docs/.vitepress/config.ts` description: simplified tagline, explicit RDF format list (Turtle, TriG, JSON-LD, N-Triples, N-Quads).
- GitHub repo description: "Graph reconstitution pipeline — squashes classified JSON records into deterministic RDF graph sausage."
- `.gitattributes`: demo HTML wrapper, baked JSON-LD payload, per-graph chunk JSON, and the inlined sigma+graphology vendor bundle marked `linguist-vendored` / `linguist-generated` so GitHub's language detector reflects the TypeScript library, not the size of the embedded WebGL viewer or its corpus data.

## [0.2.0] - 2026-05-05

### Added

- `JsonLdGraph.fromJsonLd` (async): expands compacted JSON-LD via `jsonld.expand` before walking, so `@type: @id` CURIE-string references produce edges. Fixes missing edges in the aonprd demo.
- `src/viz/ChunkBuilder.ts`: build-time partitioner — runs ForceAtlas2 per named graph (canonical `inferSettings`), normalises positions onto a tile grid, bakes node sizes (`degree/3`, capped 2-20), bakes a 16-color categorical palette per chunk, writes `index.json` + `chunks/<slug>.json` with positions / sizes / colors frozen.
- `src/viz/SigmaGraphRenderer.ts`: small HTML wrapper (~170 KB) embedding the vendored sigma + graphology bundle. Init script fetches `index.json` then progressively merges chunks into a graphology Graph in ascending node-count order; sigma renders incrementally via WebGL. Hover/select reducers hue-shift the focus node + neighbours toward the rose accent (size unchanged) and hide non-incident edges; labels render with a 4-px dark halo for readability against any cluster color.
- `scripts/bundle-sigma.mjs`: produces `src/viz/vendor/sigmaBundle.ts` (sigma + graphology IIFE bundle, ~155 KB minified) via esbuild.
- `docs/examples/aonprd.md`: VitePress page embedding the chunked demo via iframe.
- `docs/usage.md`: end-to-end walk-through against the Pathfinder/aonprd fixture.
- `docs/index.md` switched from `layout: home` to `layout: doc` so the sidebar is visible on the home page.
- Sidebar "Demo" and "Walk-through" entries in `docs/.vitepress/config.ts`.
- `@types/jsonld` stub extended with `expand()` method declaration.

### Changed

- **Visualisation engine replaced**: cytoscape + cytoscape-fcose (canvas, single 18 MB inlined HTML, runtime layout) → sigma 3 + graphology + graphology-layout-forceatlas2 (WebGL, multi-file chunked artifacts, layout baked at build time). Cold load on the full AON corpus (13 089 nodes / 40 078 edges) goes from "never finishes" to <5 s even in hidden tabs; vendor bundle 760 KB → 155 KB; HTML wrapper 18 MB → ~170 KB.
- `viz` CLI command emits a directory (`<basename>/<basename>.html`, `<basename>/index.json`, `<basename>/chunks/*.json`) instead of a single inline-everything HTML file. New `--iterations <n>` flag for ForceAtlas2 override.
- Streaming kicks off via `setTimeout` rather than `requestAnimationFrame` so it fires regardless of tab visibility (rAF callbacks are throttled / never fire in hidden Chrome tabs).
- All Bulbapedia/Torreya/Pokémon vocabulary references replaced with Pathfinder/aonprd vocabulary throughout source TSDoc examples, unit-test fixture class names, integration-test records, documentation prose, and config snippets. The canonical example is now the aonprd Pathfinder fixture.
- `squashage.config.torreya.example.json` deleted.
- `scripts/create-type-stubs.js`: `@types/jsonld` stub updated with `expand()` declaration.

### Removed

- `src/viz/GraphRenderer.ts`, `src/viz/vendor/cytoscapeBundle.ts`, `src/viz/vendor/cytoscapeFcoseBundle.ts`, `scripts/refresh-viz-vendor.js`, `tests/unit/viz/GraphRenderer.test.ts`.
- `cytoscape` and `cytoscape-fcose` devDependencies; replaced with `sigma`, `graphology`, `graphology-layout-forceatlas2`, `graphology-types`, `esbuild`.

## [0.1.0-beta.1] - 2026-05-04

The Squashage v0.x branch — graph reconstitution pipeline that consumes structured JSON records, classifies each record through a deterministic cascade, projects matched records into RDF/JS quads, and emits a single serialized RDF file (or interactive HTML graph). 662 unit tests + 22 integration tests + 43 e2e tests, all gates green. Branch ready for the v0.x npm release.

### Added

**Project bootstrap**
- Squashage workspace bootstrapped; package identity set to `squashage`; config examples created as `squashage.config*.example.json`.
- Squashage icon at `docs/assets/squashage.png`.

**v0.x runtime — file output and OSS RDF stack** (plan 13)
- **RDF wrapper layer** under `src/rdf/`: `Formats`, `DataFactory`, `TermGuards`, `Namespaces` (+ `IRIUtils`, `BaseIRIResolver`), `Vocab` (RDF/RDFS/OWL/XSD/SHACL + `STANDARD_PREFIXES`), `Dataset`, `Parser` (n3 + jsonld dispatcher), `Serializer` (n3.Writer + jsonld.fromRDF dispatcher), `Canonicalize` (rdf-canonize RDFC-1.0), `SyntaxValidator` (parse round-trip), `GraphBuilder` (vendored from `semantics/rdf-builder`, trimmed for v0.x).
- **SHACL wrapper** at `src/shacl/ShaclGate.ts` over `rdf-validate-shacl` (uses the validator's bundled defaultEnv — no factory option).
- **Output layer** under `src/output/`: `OutputInterface`, `OutputReport`, `FormatResolver`, `FileOutput` with atomic write (tmp + fsync + rename), pre-write SHACL hook with `validation.report.{txt,ttl}` quarantine emission, optional canonicalization, `output.graph` collapse for triple-only formats, `dryRun` mode.
- **Quarantine** at `src/quarantine/QuarantineWriter.ts`: four buckets (`unknown`, `conflicts`, `projection`, `output`) with SHA-1 record IDs, `summary()` and `exitCodeFor()` helpers.
- **Config + schemas** under `src/config/` and `src/schemas/`: AJV-validated `SquashageConfig.loadFromFile`, JSON Schemas for `output`, `target`, `predicate`, root config, with `OutputConfigInterface` derived via `json-schema-to-ts`. Cross-validation enforces classification-task ↔ config-block presence.
- **Built-in tasks** under `src/tasks/`: `json:read` (file / JSONL), `rdfjs:finalize` (orchestrator-invoked drain-then-finalize), `index.ts` side-effect bootstrap.
- **Orchestrator** at `src/orchestrators/SquashageOrchestrator.ts`: builds a fresh per-run `TaskRegistry`, walks the input source recursively, drives `ConcurrentPipeline.executeAll`, strips `rdfjs:finalize` from the per-record queue and invokes it once after the final batch settles, returns `RunResultInterface`.
- **CLI** at `src/cli/cli.ts`: `build`, `classify`, `inspect`, `viz` subcommands; `--out`, `--format`, `--in`, `--dry-run`, `--title` overrides; `buildCli()` factory + ESM `isMain` guard for test friendliness.
- **Application code is firewalled** from the underlying OSS packages — enforced by ESLint `no-restricted-imports`. Plugins, finalize, orchestrator, classifier all import from `src/rdf/*` and `src/shacl/*` only.
- v0.x publishing posture: ships against permissive open-source RDF libraries (`@rdfjs/types`, `@rdfjs/data-model`, `@rdfjs/dataset`, `@rdfjs/namespace`, `n3`, `jsonld`, `rdf-canonize`, `rdf-validate-shacl`). v1.x will swap wrapper bodies to the unpublished `@semantics/*` workspace without touching application code; RDF/XML and N3 output formats return at v1.x.

**Deterministic classifier cascade**
- Six idiomatic task classes the user opts into via `targets[].pipeline`. Each instantiated per-target with its frozen, AJV-validated config at run startup; per-record execution does no I/O and no allocations beyond the proposal array.
  - **`classify:source`** (`SourceClassifier`): emits a `__source__` marker proposal from the record's `_source` block.
  - **`classify:structural`** (`StructuralClassifier`): predicate-based structural gate.
  - **`classify:rules`** (`RulesClassifier`): predicate-based decision table over normalized facts.
  - **`classify:schema`** (`SchemaClassifier` + `AjvClassifier` engine): per-class JSON Schema validation via pre-compiled AJV validators.
  - **`classify:ontology`** (`OntologyClassifier`): validates proposed classNames against a known IRI map.
  - **`classify:conflict`** (`ConflictResolver`): picks winner by `priority` desc, then `className` lex asc; quarantines on tie or unknown per `onConflict`/`onUnknown` policy.
- **Closed-vocabulary `Predicate` engine** (`src/classification/predicates/`): purely deterministic predicate language. Closed operator set — `equals`, `notEquals`, `in`, `notIn`, `exists`, `missing`, `type`, `regex` (must be anchored), `length`, `range`, plus `all`/`any`/`not` composition. Paths are RFC 6901 JSON Pointers. Compiled at startup (RegExp pre-built, path segments pre-split, AST tagged-union). AJV schema at `src/schemas/predicate.schema.json` validates raw config against the closed vocab.
- **`ClassificationFactory.build`** consumes the target's `classification` config block, compiles raw predicates, reads + AJV-compiles schema files, and returns the six classifier instances keyed by task name. All file I/O happens here at startup, never per-record.
- **AJV cross-validation** in `SquashageConfig`: walks each target's `pipeline:` and asserts the matching `classification.<key>` config sub-block exists and is non-empty. Enforces that `classify:conflict` is required when ≥2 distinct class-proposing classifiers (`structural`, `rules`, `schema`) are listed.
- **Per-run `TaskRegistry`**: `Pipeline` constructor accepts an optional `registry?: TaskRegistry`. The static surface is preserved as a back-compat delegating wrapper around a module-private default. The orchestrator constructs a fresh `TaskRegistry` per run, seeds built-ins, registers per-target classifier instances, and threads the instance into `Pipeline`.

**Deterministic prefix derivation + auto JSON-LD context**
- **`PrefixResolver`** (`src/classification/PrefixResolver.ts`): resolves `(instances, graphs, vocabulary)` prefix-base pairs from `targets[].ontology.prefixes` if present, otherwise derives from `_source.url` host (with TLD + trivial-label filtering) and the target name. Returns `{ source: 'config' | 'derived' | 'fallback' }` for evidence/logging. Result lives on `PipelineContextInterface.prefixes`.
- **`JsonldContext.build`** (`src/rdf/JsonldContext.ts`): walks the produced quad set + `ctx.prefixes` and emits a deterministic compaction `@context`. Infers `@type: @id` for predicates whose objects are always NamedNodes, typed-literal `@type` (e.g. `xsd:integer`) when datatype is consistent across all observations, and `@container: @set` when at least one subject has ≥2 distinct values for a predicate (per-graph counting). Term collisions across vocabularies stay fully-qualified — no aliasing.
- **`output.jsonldContext` config field**: optional path-string or inline-object override for the auto-built context. AJV cross-validation rejects it when format is not `jsonld`. Default is auto-build; `'auto'` sentinel is explicit synonym.

**Cytoscape graph renderer + `viz` CLI + Pathfinder demo**
- **`src/viz/JsonLdGraph.ts`**: pure JSON-LD → `VizPayloadInterface` (nodes, edges, graphs, prefixes) adapter. No DOM, no library imports.
- **`src/viz/GraphRenderer.ts`**: emits a self-contained HTML document string with the vendored cytoscape bundle, the payload as JSON, and a sidebar (details, graph legend, node list grouped by class). Class-derived node colors, graph-derived edge colors, click handlers wired.
- **`src/viz/vendor/cytoscapeBundle.ts`**: vendored cytoscape 3.33.3 as a TypeScript `string` constant (backticks and backslashes pre-escaped by `scripts/refresh-viz-vendor.js`). Cytoscape is a `devDependency` only; runtime production code never imports it.
- **`squashage viz --in <jsonld> --out <html> --title <string>`** CLI subcommand that runs the adapter + renderer.
- **`docs/examples/aonprd/{aonprd.jsonld,aonprd.html}`** — checked-in offline demo (open `aonprd.html` in any browser). Regenerable via `npm run viz:demo`.

**Tests**
- 662 unit tests across `src/{rdf,shacl,output,quarantine,config,tasks,orchestrators,cli,classification,viz,registry,pipeline,types,errors}/`.
- 22 integration tests covering the full pipeline (`tests/integration/build-trig.test.ts`, `tests/integration/build-classify-cascade.test.ts`).
- 43 e2e tests at `tests/e2e/aonprd.test.ts` against 12 Pathfinder fixtures (feat / spell / monster / action / equipment + 3 quarantine triggers). The e2e config has **zero hardcoded IRIs** — the package derives all prefixes from `_source.url` and the target name, proving the `PrefixResolver` + auto-context pipeline works end-to-end. Explicit assertions only; no snapshots.

**Documentation**
- Plan 13 (`docs/plans/13-file-output-and-semantics-integration.md`) — full implementation record: orchestrator-driven `rdfjs:finalize`, AJV schemas, code standards, deterministic classifier menu, file inventory with importer-evidence-based deletion plan.
- Plan 15 (`docs/plans/15-graph-viz.md`) — viz architecture and refresh workflow.
- README, architecture, classification-engines, plans/README, plans/00-current-state — synced to shipped reality (no "should be" / "currently being defined" preamble; format support split v0.x vs v1.x).

### Changed
- Package identity set to `squashage`.
- Output contract clarified: RDF/JS is the build's *internal* canonical product; the configured `output` is a single serialized RDF file (turtle/trig/ntriples/nquads/jsonld in v0.x; rdfxml/n3 deferred to v1.x). Graph-store loading is out of scope.
- Code standards: lint, tsc, AJV, hooks, CI, conventional commits, changelog gate, TSDoc density, logger discipline, module conventions.

### Removed
- `squashage.config.example.json` added as config example.
- `docs/assets/squashage.png` added as the package icon.
- Scraper layer wholesale: `src/scrapers/`, `src/crawlers/`, `src/orchestrators/ScrapeOrchestrator.ts`, `src/modules/cache/`, `src/modules/http/`, related types and tests, all `docs/*.html`, root-level `scrapers/*.js`, `errors/*.js` stray compiled artifacts, `examples/{docs-scraper,wiki-docs}/`. Orphan deps dropped: `bottleneck`, `cheerio`, `domhandler`, `wtf_wikipedia`.

