# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Native `@studnicky/dagonizer@0.25` engine.** The projection pipeline runs on the published `@studnicky/dagonizer@^0.25.0` batch API, resolved from GitHub Packages via `.npmrc` scope routing, replacing the prior file-linked engine. Every pipeline node is a `ScalarNode` implementing `executeOne`, returning output ports via `NodeOutputBuilder` and collecting errors via `NodeErrorBuilder`; each declares its `outputSchema`. State classes expose typed mutable fields and `clone(): this`; the dispatcher and `ProvObserver` use the 0.25 hook signatures (`placementPath`, `output: string | null`, `lifecycle.variant`).
- **DAGs are authored documents.** Each run/record/induce/refine/bootstrap DAG is a committed `src/dag/*.dag.jsonld` document loaded at runtime via `DAGDocument.load`; a `build:assets` step mirrors the documents and JSON schemas into `dist/`. Node and DAG registration uses the native `dispatcher.registerBundle(DispatcherBundleType)`.
- **Native record/draft fan-out.** Per-record and per-draft processing use the engine's native `scatter { dag }` placement — child state is metadata-seeded by a `record-init` node and per-record summaries collect through shared services — replacing the hand-dispatch nodes (`recordDispatch`/`draftDispatch` removed).
- **Lenient projection — no record is dropped on shape.** The ABox projection schema is relaxed (induced `required`/enum/bounds/null- and integer-narrowing stripped) so records project with whatever properties they carry; the strict schema is retained for TBox/SHACL and deviations surface as advisory warnings. Records that no classifier maps fall back to the `Generic` class (no-drop floor) instead of quarantining. On the aonprd corpus this takes quarantine from 100% of projectable records to 5 genuine cases.
- **Ontology/TBox emission errors route through the DAG.** A malformed class schema makes `ontology-emit` collect a warning and return an `error` output port (routed onward to finalize) rather than throwing and aborting the whole run.

### Added

- **Transient json-tology #126 workaround.** ABox projection inline-resolves cross-schema `$ref` property bodies so referenced object properties are not dropped during `toQuads`; TBox/SHACL emission stays on the strict-graph schemas. Removed when json-tology #126 ships upstream.

## [0.7.1] - 2026-05-18

### Fixed

- **Publish pipeline targets GitHub Packages and actually works.** The publish workflow had three pre-existing bugs preventing publication on every release since v0.4.0: (1) called `npm run type-check` but the script is named `typecheck`; (2) targeted `https://registry.npmjs.org` instead of GitHub Packages; (3) used `NPM_TOKEN` secret (never provisioned) instead of the auto-issued `GITHUB_TOKEN`. Workflow now points at `https://npm.pkg.github.com`, authenticates with `GITHUB_TOKEN`, declares `packages: write` permission, and uses the correct script name. `workflow_dispatch` trigger added so future republish runs can fire without a master push.
- **`package.json` configured for publishing.** Name scoped to `@studnicky/squashage` (GitHub Packages requires scoped names). `private: true` removed. New `publishConfig.registry: https://npm.pkg.github.com`, `publishConfig.access: public`, `repository`, `bugs`, `homepage`, and `files` fields added. `files` limits the publish tarball to `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md`. Consumers import as `@studnicky/squashage` from GitHub Packages registry.

## [0.7.0] - 2026-05-18

### Added

- **Phase 11 silo migration: classifiers convert to self-registering plugins.** Each of the 11 classifier task modules under `src/classification/tasks/` self-registers on the global `TaskRegistry` at module-load time: a per-record task and an `onRunStart` lifecycle hook (declaring `proposesClass: true` on the seven class-proposers). Each hook validates its config namespace via `ctx.ajv.compile(<plugin>ConfigSchema)` using the run-wide shared AJV instance from `context:ajv`, compiles its own startup state (predicates, regexes, schemas, fingerprints, winkNLP model, etc.), and writes into a module-level cache keyed by `ctx.target` for concurrent-run isolation. Per-record tasks read from the cache and fail-fast with `OutputConfigError` on a cache miss. Hook-driven `SquashageOrchestrator` replaces the legacy `ScrapeOrchestrator`; `ClassificationFactory` removed (#25). Schema flip + fixture flatten (#27/#28) co-land in this release.
- **Named-graph bucketing on output (`output.bucketing`).** Configurable per-graph file emission: when `bucketing.enabled` is true the writer fans `quad.graph.value` out into one file per logical bucket under `output.path` (treated as a directory). Three strategies — `per-graph-iri` (default; deterministic slug from each named-graph IRI), `per-config-bucket` (explicit `buckets: {iri → filename}` map), and `per-template` (`{slug}`/`{hash}`/`{graph}` filename templating). Filename derivation handles IRI fragment/query, URL-decoded non-`[A-Za-z0-9._-]` runs, 128-char truncation, and SHA-1 collision suffixes. The default graph follows TriG-native unnamed semantics and writes to `default.<ext>` (override via `bucketing.defaultGraphFilename`). New `Bucketer` class (`src/output/Bucketer.ts`) handles classification + filename derivation as a pure no-I/O module. `FileOutput.close()` hoists canonicalize/SHACL to run once on the union dataset, then serializes per-bucket. `OutputReportInterface` extended with `buckets: ReadonlyArray<BucketReportInterface>` and `path` becomes the bucket-root directory.
- **MultiStreamWriter for bucketed streaming output.** Streaming mode supports both bucketing strategies. `per-config-bucket` opens all N stream writers up-front; `per-graph-iri` uses lazy file open — file pool starts empty, opens on first quad seen for each new graph IRI, serializes opens through `Map<string, Promise<StreamWriter>>` to prevent double-open under concurrent emit. TriG/Turtle prefix headers emit at first open; subsequent reopens use append mode (no header). Configurable `bucketing.maxOpenFiles` (default 256) with LRU close + reopen-append on overflow. Lazy-open failure aborts cleanly leaving `.partial` forensics.
- **OASIS XML Catalog generation (`output.catalog`).** New `catalog:emit` post-finalize task generates an OASIS XML Catalogs 1.1 manifest mapping each named-graph IRI to its bucket file path. Filename derived from target ID (`<targetId>.catalog.xml`, falls back to `catalog.xml`). New `OasisCatalog` static builder (`src/output/OasisCatalog.ts`) handles `<uri>`, `<rewriteURI>`, `<systemSuffix>`, `<group>`, `<public>`, and `<system>` element generation with XML escaping. All entries use paths relative to catalog location so the directory is portable. Optional `bucketing.defaultGraphCatalogIri` escape hatch (e.g. `"urn:x-arq:DefaultGraphNode"`) emits a `<uri>` entry for the otherwise-unnamed default graph. `includeOntologies` / `includeContexts` / `includeShapes` config flags control non-bucket entries. Catalog only emitted when bucketing is enabled (skip in single-file output). Validation via `@xmldom/xmldom` round-trip parse.
- **Full SEO suite ported from iridis (`docs/.vitepress/config.ts` + `docs/public/`).** Configurable site-identity constants drive 42+ SEO artifacts: complete favicon stack (`favicon.svg`, PNG variants, apple-touch-icon, mask-icon), `manifest.webmanifest`, `robots.txt`, `llms.txt`, Open Graph card (`og-image.png` + self-contained `og-image.svg` with base64-inlined logo), 12 OG meta tags, 7 Twitter Card tags, 3 inline JSON-LD blocks (`SoftwareSourceCode`, `WebSite`, `Organization`). `transformPageData` emits per-page canonical URL, OG tags, Twitter tags, description, and `BreadcrumbList` JSON-LD on every route. `buildEnd` parses `CHANGELOG.md` (Keep-a-Changelog format) into an RSS 2.0 `feed.xml`. All 27 markdown pages now carry `description:` frontmatter. Conditional verification meta (`google-site-verification`, `msvalidate.01`) driven by `package.json → squashage.seo.*` block (empty string suppresses tag emission). Search-engine submission scripts (IndexNow / GSC / Bing Webmaster) deferred.
- **GitHub repo social preview asset (`docs/public/github-social-preview.png`).** 1280×640 PNG rendered from the same `og-image.svg` source so the GitHub social card matches OG/Twitter/Discord/Slack link embeds for visual consistency. Upload via repo Settings → Social preview.

### Changed

- **All RDF library imports are static ESM backed by public type sources.** `@types/n3 ^1.26.1` and `@types/jsonld ^1.5.15` added as devDependencies; the previous local `src/rdf/n3-shim.d.ts` and `src/rdf/jsonld-shim.d.ts` are deleted in favour of DefinitelyTyped declarations. `rdf-canonize` has no public types — the local `src/rdf/rdf-canonize-shim.d.ts` is reformed as a `declare module 'rdf-canonize'` block exporting `canonize` and `CanonizeOptions`, which `esModuleInterop` + `allowSyntheticDefaultImports` (both already enabled) resolve as a default import. The `createRequire(import.meta.url)(...)` workarounds introduced during bucketing implementation are removed from `src/rdf/Serializer.ts`, `src/rdf/Parser.ts`, and `src/rdf/Canonicalize.ts`.
- **`package.json` license field** changed from `UNLICENSED` to `MIT` to match the `LICENSE` file. The discrepancy meant npm registry and dependency-license tools mis-reported the project.

### Fixed

- **`docs/public/og-image.svg` is self-contained.** The previous `<image href="squashage.png">` relative reference broke when the SVG was viewed standalone (browser file://, GitHub web preview, IDE SVG preview) — the icon rendered as a broken placeholder outside the rsvg-convert pipeline. The PNG is now inlined as a `data:image/png;base64` URI so the SVG renders correctly in any consumer with no external fetches.

## [0.6.0] - 2026-05-07

### Added

- **AONPRD demo regenerated from full Archives of Nethys corpus through pokemontology-style emitters and Ripperoni v2.5.0 cache-driven enrichment.** `docs/public/examples/aonprd/` now reflects the full v0.6.0 extraction pipeline applied to 12,553 records re-parsed from the cached AON HTML (no re-fetch). Output grew from 4.39 MB / 13089 nodes / 40078 edges to 7.18 MB / 14124 nodes / 45760 edges (+1035 nodes, +5682 edges, +2.79 MB). Source records now carry the new fields from Ripperoni v2.5.0's cache-driven extraction (`entity_id`, `trait_ids`, `sources[]`, spell `defense`/`deities`, feat `related_feats`, monster `family_links`, weapon IDs, etc.). `scripts/build-aonprd-demo.ts` updated to resolve `schemaPath` inside `ontology.schemas` (not just `classification.schemas`) relative to the FIXTURE directory, fixing a full-corpus mode crash on json-tology schema load.
- **AONPRD plugin: pokemontology-style enrichment (11 items).** Borrowing the pokemontology ontological density patterns, the AONPRD fixture plugin (`tests/e2e/aonprd/plugin.ts`) gains structured semantic enrichment across all emitters: (1) `rdfs:label "Name"@en` on every class emitter; (2) monster stat-block resource reification -- each numeric stat field (hp, ac, perception, str/dex/con/int/wis/cha) produces a skolemized `aonprd:StatBlock` resource with `statName` and `statValue` predicates; (3) `aonprd:actionCost` is replaced by a reified `aonprd:ActionCost` skolemized resource carrying `aonprd:actionSymbol` (feat and action emitters); (4) spell school as a second-axis IRI (`aonprd:school aonprd:School-evocation`); (5) feat `aonprd:hasPrerequisite` forward links and `aonprd:isPrerequisiteFor` inverse links, supporting both plain string/array and structured `prerequisites_links` arrays; (6) `skos:broader` hierarchy for trait records with a `category` field; (7) `dct:source` per-record provenance quad pointing to `_source.url` as a NamedNode; (8) `aonprd:description` literal from `description_text`; (9) monster `aonprd:size` emitted as an IRI (`aonprd:Size-Gargantuan`) rather than a literal; (10) `owl:inverseOf` TBox axiom for `hasPrerequisite`/`isPrerequisiteFor` is a gap -- json-tology's axiom config surface does not currently support arbitrary OWL axiom injection; documented here for tracking; (11) JSON Schema numeric range constraints added to all five schemas: feat level 1-20, spell level 1-10, monster level -1 to 25, equipment `item_level` 0-25. All reified resources use skolemized NamedNode IRIs derived from the subject IRI for deterministic canonicalization across concurrent pipeline runs. `SKOS` and `DCT` namespace builders added to `src/rdf/Vocab.ts`; both added to `STANDARD_PREFIXES`. Corresponding unit test suite added under `tests/unit/plugins/aonprd/` (5 focused test files, 38 new cases).

- **Phase 10: rdfjs:stream streaming output task.** New built-in pipeline task `rdfjs:stream` eliminates OOM on large datasets (Veekun-scale 486K learnsets) by writing quads to disk as they arrive rather than accumulating them in RAM before writing atomically. The orchestrator opens a streaming file handle once before per-record dispatch and wraps `ctx.dataset` with a write-through proxy: each `dataset.add(quad)` call serializes the quad immediately to the output file. Quads are optionally dropped from the in-memory dataset via `dropInMemory: true` to bound RSS growth. Config fields added to `OutputConfigInterface`: `encoding: atomic | stream` (default `atomic`, preserving all prior behaviour) and `dropInMemory: boolean` (default `false`). Config-load errors thrown when `encoding: stream` is combined with `canonicalize: true` or `format: jsonld` (both require the full graph). Compatible formats for streaming: `ntriples`, `nquads`, `turtle` (line-oriented), `trig` (line-oriented). `rdfjs:finalize` is unchanged and remains the default. Documentation page `docs/usage/streaming-output.md` added with problem framing, format compatibility matrix, state machine, `dropInMemory` tradeoffs, and worked Veekun example.
- **v0.6.0-alpha.3 Phase 9: winkNLP entity-link enrichment.** New end-of-run pipeline task `enrich:entity-link` (`EntityLinkTask`) densifies the RDF graph by scanning configured prose predicates on every typed instance and emitting `<subject> <edgeIri> <target>` quads for any span that case-fold-matches a known instance label. The task is an end-of-run enrichment phase: the orchestrator strips `enrich:entity-link` from the per-record pipeline and invokes it once after all per-record squash tasks have settled, so the entity index is built from the fully-populated dataset. Index construction is O(n) over dataset quads; per-subject span extraction uses winkNLP tokenization with a 1-5 token sliding window; lookup is O(1) via a frozen `Map<string, string>`. No new IRIs are invented: edge targets must already exist as typed instances in the dataset. Self-links and duplicate edges per subject are suppressed. Configurable via `targets.<id>.enrichment.entityLink` (`engine: "winknlp"`, `fields`, `edgeIri`, `linkAgainst`, `minConfidence`). Config schema extended with `enrichment.entityLink` block; AJV cross-validation enforces `engine: "winknlp"` and rejects missing `enrichment.entityLink` when `enrich:entity-link` is in the pipeline. Orchestrator strips the task name from per-record names, builds and registers the stateful `EntityLinkTask` instance, then invokes it post-batch before finalize. Documentation page `docs/usage/entity-link.md` added; sidebar entry added to `docs/.vitepress/config.ts`.

- **v0.5.0-beta.2 Phase 7: RDF-star reification.** Extends `output:provenance` with an optional `encoding: "rdf-star"` mode. When enabled, provenance metadata is attached directly to the winning `rdf:type` assertion using quoted triples (`<< subject rdf:type class >> prov:wasGeneratedBy ...`) rather than a sidecar named graph. Default is `encoding: "named-graph"`, preserving all Phase 6 behaviour unchanged. New `RdfStar` utility class exposes `quoteQuad()` and `isSupported()` helpers. `Serializer.serialize` extended with an `n3FormatOverride` option to request RDF-star-capable formats (`application/trig-star`, `text/turtle-star`, `application/n-quads-star`). Documentation extended with an `## RDF-star encoding` section in `docs/usage/provenance.md` covering when to use each encoding, config examples, sample TriG-star output, and trade-off table. Note: n3.js v2.0.3 serializes quoted triples as `<<( )>>` (with inner parentheses); the parser does not round-trip that syntax in v2.0.3.
- **v0.6.0-alpha.2 Phase 8: winkNLP content-based classifier.** New `classify:winknlp-entities` pipeline task (`WinknlpEntitiesClassifier`) runs deterministic pattern-based NER on configured prose fields (`description`, `summary`, `rules_text`, etc.) via winkNLP custom entities. The winkNLP model (`wink-eng-lite-web-model`, ~5 MB, ships from npm) and all configured custom-entity patterns are compiled once at orchestrator startup via `learnCustomEntities`; no model load or pattern compilation occurs on the hot per-record path. For each matched pattern, one proposal is emitted with `source: 'classify:winknlp-entities'`, `reasons: ['winknlp:pattern=<name>', 'winknlp:matched=<snippet>', 'winknlp:field=<field>']`, and a configurable `priority` (default 28). Invalid patterns fail fast at startup with `OutputConfigError` naming the offending pattern. Config schema extended with `classification.winknlpEntities` (`patterns[]`, `fields`). `CLASS_PROPOSERS` and `CLASSIFY_TASK_CONFIG_KEYS` updated; `ClassificationFactory` and orchestrator wiring added. New npm dependencies: `wink-nlp`, `wink-eng-lite-web-model`. Documentation page `docs/usage/winknlp-entities.md` added.: v0.6.0-alpha.2 -- winkNLP content-based classifier (Phase 8))

- **v0.5.0-beta.1 Phase 6: sidecar provenance reification.** New built-in pipeline task `output:provenance` emits PROV-O metadata quads into a dedicated sidecar named graph for each processed record. Controlled by `targets.<id>.output.provenance` config block (`enabled`, `graph`, `include`). Default-off; existing configs and e2e behaviour are unaffected. Four metadata categories are emitted when enabled: `prov:wasGeneratedBy` (winning classifier engine), `prov:value` (confidence decimal), `prov:atTime` (frozen run-start timestamp -- deterministic across replays), and `prov:reason` (comma-joined evidence reasons). The run-start timestamp is frozen once at orchestrator context construction and stored as `ctx.runStartTime`, ensuring two replays of the same input produce byte-identical provenance graphs. `PROV` namespace builder added to `src/rdf/Vocab.ts`; `prov` prefix added to `STANDARD_PREFIXES`. `PipelineContextInterface` extended with optional `runStartTime?: string`. Documentation page `docs/usage/provenance.md` added with problem framing, state machine, full config examples across all four `include` flavours, edge cases, and SPARQL query examples.



- json-tology integration scaffold under `targets.<id>.ontology.engine: "json-tology"`. New `JsonTologyOntology` class wraps json-tology's JsonTology + OntologyBuilder, exposing `classMap()`, `tbox()`, `shacl()`, `toQuads()` for downstream classification and emission.
- New pipeline task `ontology:emit` writes auto-derived OWL TBox + SHACL shapes to configured paths when the json-tology engine is active.
- `state.context.jt` (optional) gives plugins access to the typed ABox projection (`jt.toQuads(schemaId, instance)`) for opt-in adoption.
- New `classify:shacl-shape` classifier task (`ShaclShapeClassifier`). Validates each record's property-projected ABox against loaded SHACL NodeShapes using `rdf-validate-shacl` and emits one proposal per conforming shape. Configurable via `classification.shaclShape.shapesFrom` (`"ontology"` for json-tology-derived shapes or a Turtle file path) and `classification.shaclShape.priority` (default 45, sits between schema classifier at 30 and ontology classifier at 50). Config schema updated; cross-validation and `classify:shacl-shape` task registration added to orchestrator.
- Documentation page `docs/usage/shacl-shape-classifier.md` covering problem framing, state machine, full config worked examples (ontology and file-path modes), and edge cases.
- New `classify:taxonomic-narrowing` classifier task (`TaxonomicNarrowingClassifier`). Runs after all class-proposing classifiers but before `classify:conflict`. Collapses supertype proposals when a more-specific subtype is also present using the OWL `subClassOf` transitive closure derived from the configured TBox. TBox source is `"ontology"` (reads from `state.context.jt.tbox()`) or a Turtle/N-Quads file path. Emits a `__narrowing_applied__` audit-trail sentinel filtered by `ConflictResolver`. Config schema, cross-validation, `ClassificationFactory` registration, and orchestrator wiring updated. Documentation page `docs/usage/taxonomic-narrowing.md` added.
- New `classify:url-pattern` classifier task (`UrlPatternClassifier`). Evaluates pre-compiled regular expressions against the record's `_source.url` (squashage-enriched) or top-level `url` (raw scrape fallback) and emits one proposal per matching pattern. Regexes are compiled once at construction time via `UrlPatternClassifier.create(config)`; invalid regex source strings fail fast at startup with `OutputConfigError` naming the zero-based pattern index. Multiple patterns can match a single URL, producing multiple proposals for the ConflictResolver to resolve. Default priority 35 places URL-pattern proposals as corroborating evidence below structural/schema classifiers. Config schema extended with `classification.urlPattern.patterns[]` (`className`, `match`, `priority`); `CLASS_PROPOSERS` and `CLASSIFY_TASK_CONFIG_KEYS` updated; `ClassificationFactory` and orchestrator wiring added. Documentation page `docs/usage/url-pattern-classifier.md` added.
- New `classify:property-fingerprint` classifier task (`PropertyFingerprintClassifier`). Computes Jaccard similarity between each record's top-level property key set and pre-loaded class fingerprints from a JSON file. Fingerprints are loaded once at construction via `PropertyFingerprintClassifier.create(config, configDir)` and pre-computed into `Set<string>` for O(1) intersection on the hot per-record path. Each fingerprint whose similarity meets or exceeds `minMatchScore` (default 0.85) emits one proposal with reasons `fingerprint.score=<N.NN>` and `fingerprint.shared=<count>`. Multiple fingerprints may match a single record. Default priority 32 sits alongside `classify:rules` in the proposer tier. Config schema extended with `classification.propertyFingerprint` (`fingerprintsFrom`, `minMatchScore`, `priority`); `CLASS_PROPOSERS` and `CLASSIFY_TASK_CONFIG_KEYS` updated; `ClassificationFactory` and orchestrator wiring added. New offline trainer script `scripts/build-fingerprints.ts` derives fingerprints from a labelled corpus directory (`<className>-<rest>.json` filename convention) by computing the union of top-level keys per class; exposed as `npm run viz:fingerprints`. Documentation page `docs/usage/property-fingerprint-classifier.md` added.

## [0.4.0] - 2026-05-06

### Changed

- Em-dashes (`—`) replaced with plain punctuation (`: ` for list/definition items, `; ` for clause joins, `, ` mid-sentence) across `README.md`, `docs/**/*.md`, `package.json`, and `docs/.vitepress/config.ts`. 142 occurrences total. CHANGELOG history left untouched.

### Added

- Mechanism-depth expansions across user-facing docs (architecture, pipeline, classification-engines, classifier-cascade, configuration, output, plugins, viz) following the yamete-fidelity bar: problem framing, state machines, determinism contract, edge cases. Also fixed outdated cytoscape references in `docs/usage/viz.md` to reflect the sigma + graphology engine since v0.2.0.

### Changed

- GitHub Actions baseline: `actions/checkout` 4 → 6 across all workflow files.

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

