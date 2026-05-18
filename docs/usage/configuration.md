---
layout: doc
title: Configuration
description: Squashage JSON config schema — top-level shape, target blocks, plugin namespace declarations, schema paths, and output block. Load with squashage build --config squashage.config.json.
---

# Configuration

The config is a JSON file. Load it with `squashage build --config squashage.config.json`. Schema source of truth: `src/schemas/squashage-config.schema.json`.

Copy `squashage.config.example.json` as a starting point; the unprefixed file is gitignored so you don't accidentally commit credentials.

## Top-level shape

```ts
{
  input:   { basePath: string; format: 'json' | 'jsonl' };  // required
  targets: { [name: string]: TargetConfig };                  // required, min 1
}
```

### `input`

Global input directory and format.

| Key | Type | Required | What it does |
|-----|------|----------|--------------|
| `basePath` | string | yes | Base directory for all target input paths. Each target's `input` is resolved relative to this. |
| `format` | `"json"` \| `"jsonl"` | yes | File format. `json` = one JSON object per file; `jsonl` = one JSON object per line. |

### `targets`

An object whose keys are target names (e.g. `"aonprd"`) and values are target configs. Minimum one target.

---

## Target config

```ts
{
  input:          string;            // required
  pipeline:       string[];          // required, min 1 item
  output:         OutputConfig;      // required
  concurrency:    number;            // optional, default 1
  graphs:         { [key: string]: string };  // optional; named graph IRI overrides
  ontology:       object;            // optional; free-form ontology metadata
  quarantine:     object;            // optional; quarantine path overrides
  // Per-plugin classifier namespaces at the top level (v0.7.0+):
  source?:             true;
  structural?:         StructuralRule[];
  rules?:              RulesEntry[];
  schemas?:            SchemaEntry[];
  ontologyClassifier?: { classes: { [className: string]: string } };
  conflict?:           ConflictConfig;
  shaclShape?:         ShaclShapeConfig;
  taxonomicNarrowing?: TaxonomicNarrowingConfig;
  urlPattern?:         UrlPatternConfig;
  propertyFingerprint?: PropertyFingerprintConfig;
  winknlpEntities?:    WinknlpEntitiesConfig;
}
```

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `input` | string | yes |  | Path to input directory (resolved relative to `input.basePath`). |
| `pipeline` | string[] | yes |  | Ordered list of task names. Each must be registered (built-in or plugin). |
| `output` | OutputConfig | yes |  | See [Output config](#output-config) below. |
| `concurrency` | integer ≥ 1 | no | `1` | How many records to process in parallel. `ConcurrentPipeline` uses this. |
| `graphs` | object | no |  | Named-graph IRI overrides. Keys map to task-specific graph names. |
| `ontology` | object | no |  | Ontology engine config. Controls `json-tology` integration. |
| `quarantine` | object | no |  | Path overrides for quarantine artifact directories. |

---

## Classification config (v0.7.0 flat per-plugin namespaces)

In v0.7.0+, each classifier plugin reads its config from a **top-level namespace** on the target config object. There is no wrapping `classification: { ... }` block. Each namespace is optional: if the namespace is absent, the plugin's `onRunStart` hook no-ops so the pipeline continues without that classifier.

The cascade is opt-in by task. List `classify:rules` in `pipeline` and provide a top-level `rules` namespace; leave it out entirely if you don't need it. Each plugin validates its own namespace during `onRunStart` using the run-wide shared AJV instance from `context:ajv`.

**Validation timing**: Config namespaces are validated at run startup (once, before any record is processed). If a namespace is present but invalid (e.g., malformed predicate), the plugin throws `OutputConfigError` during `onRunStart`. Schema files (for `classify:schema`) are loaded and compiled once at startup. This fail-fast behavior prevents silent failures where 1000 records process before a config mistake is discovered.

### `source`

Set to `true`. Enables `classify:source`. Reads `_source` from the record and emits a `__source__` marker proposal. No other config needed.

```json
{
  "source": true
}
```

### `structural`

Array of structural rules. Each rule:

```json
{
  "className": "feat",
  "priority":  10,
  "predicate": { "path": "/_type", "equals": "feat" },
  "reasons":   ["_type=feat (structural)"]
}
```

| Key | Type | Required | Notes |
|-----|------|----------|-------|
| `className` | string | yes | The class name this rule proposes. |
| `priority` | number | yes | Higher number wins in `classify:conflict`. |
| `predicate` | Predicate | yes | JSON Pointer predicate expression. See [classifier-cascade](./classifier-cascade). |
| `reasons` | string[] | yes | Human-readable evidence strings preserved in the classification result. |

### `rules`

Same shape as `structural`. Use for multi-condition decision-table rules.

### `schemas`

Per-class AJV JSON Schema validators:

```json
[
  { "className": "feat",  "priority": 30, "schemaPath": "./schemas/feat.schema.json" },
  { "className": "spell", "priority": 30, "schemaPath": "./schemas/spell.schema.json" }
]
```

`schemaPath` is resolved relative to the config file's directory.

### `ontologyClassifier`

Maps class names to their full ontology IRI. The `classify:ontology` task rejects proposals whose `className` is not in this map.

The namespace is `ontologyClassifier`, not `ontology`. The `ontology` key is reserved for the json-tology engine config (`targets.<id>.ontology.engine`). Using `ontologyClassifier` prevents collision.

```json
{
  "classes": {
    "feat":  "https://squashage.dev/vocabulary/aonprd#Feat",
    "spell": "https://squashage.dev/vocabulary/aonprd#Spell"
  }
}
```

### `conflict`

Required when more than one class-proposing task is in the pipeline (which is almost always). The orchestrator asserts `classify:conflict` is registered when two or more `proposesClass: true` plugins exist.

```json
{
  "onConflict": "quarantine",
  "onUnknown":  "quarantine",
  "evidence":   true
}
```

| Key | Values | Notes |
|-----|--------|-------|
| `onConflict` | `quarantine` \| `pickPriority` | What to do when two proposals tie at the same priority. |
| `onUnknown` | `quarantine` \| `skip` | What to do when no proposal survives. |
| `evidence` | boolean | Whether to include the full proposals array in quarantine artifacts. |

### `shaclShape`

Config for `classify:shacl-shape`. See [SHACL-shape classifier](./shacl-shape-classifier).

```json
{
  "shapesFrom": "ontology",
  "priority": 45
}
```

### `taxonomicNarrowing`

Config for `classify:taxonomic-narrowing`. See [Taxonomic narrowing](./taxonomic-narrowing).

```json
{
  "enabled": true,
  "tboxFrom": "ontology"
}
```

### `urlPattern`

Config for `classify:url-pattern`. See [URL-pattern classifier](./url-pattern-classifier).

```json
{
  "patterns": [
    { "className": "feat", "match": "/Feats\\.aspx", "priority": 35 }
  ]
}
```

### `propertyFingerprint`

Config for `classify:property-fingerprint`. See [Property-fingerprint classifier](./property-fingerprint-classifier).

```json
{
  "fingerprintsFrom": "./fingerprints.json",
  "minMatchScore": 0.85,
  "priority": 32
}
```

### `winknlpEntities`

Config for `classify:winknlp-entities`. See [winkNLP entities classifier](./winknlp-entities).

```json
{
  "patterns": [
    {
      "name":      "feat-action-cost",
      "patterns":  ["two actions", "three actions"],
      "className": "feat",
      "priority":  28
    }
  ],
  "fields": ["description"]
}
```

---

## Output config

Source of truth: `src/schemas/output.schema.json`.

```ts
{
  kind:         'file';                          // required, only value
  path:         string;                          // required
  format?:      'turtle'|'trig'|'ntriples'|'nquads'|'jsonld';
  encoding?:    'atomic' | 'stream';             // default: 'atomic'
  prefixes?:    { [prefix: string]: string };
  baseIRI?:     string;
  graph?:       string;
  canonicalize?: boolean;                        // default: false
  validate?:    { shapes: string };
  dryRun?:      boolean;                         // default: false
  jsonldContext?: string | object;
  provenance?:  ProvenanceConfig;
}
```

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `kind` | `"file"` | yes |  | Only `"file"` is supported. |
| `path` | string | yes |  | Output file path. Extension determines format if `format` is omitted. |
| `format` | enum | no | inferred from extension | One of `turtle`, `trig`, `ntriples`, `nquads`, `jsonld`. RDF/XML and N3 are deferred; no maintained streaming serializer exists on npm. |
| `encoding` | `"atomic"` \| `"stream"` | no | `"atomic"` | `atomic` buffers the full graph before writing; `stream` writes quads as they arrive. Stream mode disables `canonicalize` and `validate`. |
| `prefixes` | object | no |  | Additional prefix declarations merged into the output context. |
| `baseIRI` | URI | no |  | Base IRI for relative IRI resolution. |
| `graph` | URI | no |  | Collapse all quads into this named graph at write time. Required when using a triple-only format (turtle, ntriples) with a target that emits named-graph quads. |
| `canonicalize` | boolean | no | `false` | Run RDFC-1.0 before writing. Produces byte-identical output across runs. Incompatible with stream encoding. |
| `validate.shapes` | string | no |  | Path to a SHACL shapes graph. Validated by `src/shacl/ShaclGate.ts` before write. On failure: writes quarantine report, skips output file. |
| `dryRun` | boolean | no | `false` | Run the full pipeline including classification and projection; skip writing the output file. |
| `jsonldContext` | string \| object | no | auto | Compaction context for JSON-LD output. Path string, inline object, or omit to let squashage build one from the quad set. Rejected by cross-validation when `format` is not `jsonld`. |
| `provenance` | object | no |  | See [Provenance](./provenance). |

---

## Minimal valid config

```json
{
  "input": { "basePath": "./output", "format": "json" },
  "targets": {
    "aonprd": {
      "input": "aonprd",
      "pipeline": ["json:read", "aonprd:squash", "rdfjs:finalize"],
      "output": {
        "kind": "file",
        "path": "./graphs/aonprd.ttl"
      }
    }
  }
}
```

No classifier tasks in the pipeline means records go straight from `json:read` to your squasher plugin. Fine if you're classifying in the plugin itself or all records are the same type.

---

## Richly-configured example

All classifiers active, SHACL validation, RDFC-1.0 canonicalization, concurrent processing. Note the flat top-level namespaces for each plugin:

```jsonc
{
  "input": { "basePath": "./output", "format": "json" },
  "targets": {
    "aonprd": {
      "input": "aonprd",
      "concurrency": 4,
      "pipeline": [
        "json:read",
        "classify:source",
        "classify:structural",
        "classify:rules",
        "classify:schema",
        "classify:url-pattern",
        "classify:property-fingerprint",
        "classify:winknlp-entities",
        "classify:shacl-shape",
        "classify:taxonomic-narrowing",
        "classify:ontology",
        "classify:conflict",
        "aonprd:squash",
        "output:provenance",
        "rdfjs:finalize"
      ],
      // Each plugin reads its own top-level namespace from this config object:
      "source": true,
      "structural": [
        {
          "className": "feat",
          "priority":  10,
          "predicate": { "path": "/_type", "equals": "feat" },
          "reasons":   ["_type=feat"]
        }
      ],
      "rules": [
        {
          "className": "feat",
          "priority":  20,
          "predicate": {
            "all": [
              { "path": "/_type", "equals": "feat" },
              { "path": "/level", "type": "number" }
            ]
          },
          "reasons": ["_type=feat", "level present"]
        }
      ],
      "schemas": [
        { "className": "feat", "priority": 30, "schemaPath": "./schemas/feat.schema.json" }
      ],
      "urlPattern": {
        "patterns": [
          { "className": "feat",  "match": "/Feats\\.aspx",  "priority": 35 },
          { "className": "spell", "match": "/Spells\\.aspx", "priority": 35 }
        ]
      },
      "propertyFingerprint": {
        "fingerprintsFrom": "./fingerprints.json",
        "minMatchScore": 0.85,
        "priority": 32
      },
      "winknlpEntities": {
        "patterns": [
          {
            "name":      "feat-action-cost",
            "patterns":  ["two actions", "three actions"],
            "className": "feat",
            "priority":  28
          }
        ],
        "fields": ["description"]
      },
      "shaclShape": {
        "shapesFrom": "ontology",
        "priority":   45
      },
      "taxonomicNarrowing": {
        "enabled":  true,
        "tboxFrom": "ontology"
      },
      "ontologyClassifier": {
        "classes": {
          "feat":  "https://squashage.dev/vocabulary/aonprd#Feat",
          "spell": "https://squashage.dev/vocabulary/aonprd#Spell"
        }
      },
      "conflict": {
        "onConflict": "quarantine",
        "onUnknown":  "quarantine",
        "evidence":   true
      },
      "ontology": {
        "engine":  "json-tology",
        "baseIRI": "https://squashage.dev/vocabulary/aonprd",
        "schemas": [
          { "schemaPath": "./schemas/feat.schema.json" },
          { "schemaPath": "./schemas/spell.schema.json" }
        ]
      },
      "output": {
        "kind":         "file",
        "path":         "./graphs/aonprd.trig",
        "encoding":     "atomic",
        "canonicalize": true,
        "validate": {
          "shapes": "./schemas/aonprd.shapes.ttl"
        },
        "provenance": {
          "enabled": true,
          "graph":   "provenance",
          "include": ["classifier", "confidence", "reasons", "timestamp"]
        }
      }
    }
  }
}
```

---

## Bucketing

Named-graph bucketing splits the output dataset into one file per named graph instead of writing a single combined file. Enable it by adding a `bucketing` block to `output` and setting `output.path` to a **directory** path (no extension).

The default strategy is `per-graph-iri`: filenames are derived from graph IRIs by slugifying the IRI path segment. The alternative is `per-config-bucket` which uses an explicit `graphIRI → filename` map.

```jsonc
{
  "output": {
    "kind":   "file",
    "path":   "./graphs/aonprd",
    "format": "trig",
    "bucketing": {
      "enabled":              true,
      "strategy":             "per-graph-iri",
      "defaultGraphFilename": "default",
      "defaultGraphCatalogIri": "urn:x-arq:DefaultGraphNode"
    }
  }
}
```

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `enabled` | boolean | yes |  | Must be `true` to activate bucketing. |
| `strategy` | `"per-graph-iri"` \| `"per-config-bucket"` | no | `"per-graph-iri"` | How filenames are derived. |
| `defaultGraphFilename` | string | no | `"default"` | Stem for the default-graph bucket file. |
| `defaultGraphCatalogIri` | string | no | — | When set, the default-graph bucket gets a `<uri>` entry in the catalog using this IRI (e.g. `"urn:x-arq:DefaultGraphNode"` for Jena). |
| `buckets` | object | no | — | For `per-config-bucket`: `{ "graphIRI": "stem" }` mapping. |
| `onUnmapped` | `"other"` \| `"drop"` \| `"fail"` | no | `"other"` | What to do with quads whose graph IRI is not in the `buckets` map. |
| `maxOpenFiles` | number | no | `256` | Maximum concurrent file handles in lazy-open streaming mode. Excess handles are LRU-closed and reopened on demand. |

**Constraints:**
- `output.graph` cannot be set when bucketing is on (graph collapse eliminates the bucketing key).
- When bucketing is on, the report's `path` field is the bucket directory; `report.buckets[]` has one entry per bucket.
- Triple-only formats (`turtle`, `ntriples`) work with bucketing because each bucket contains exactly one graph.

**Streaming mode (`encoding: stream`) with bucketing:**
- `per-graph-iri` uses lazy-open: file handles are opened on the first quad for each graph.
- `per-config-bucket` uses pre-open: all declared bucket handles are opened before per-record dispatch.

---

## Catalog

An OASIS XML Catalog 1.1 file (`<targetId>.catalog.xml`) can be emitted after a bucketed run. The catalog maps graph IRIs to relative file paths so RDF tools that support XML Catalogs can resolve any IRI reference to a local file.

Catalog generation requires bucketing to be on. Add `catalog:emit` to the pipeline (after `rdfjs:finalize` or `rdfjs:stream`).

```jsonc
{
  "pipeline": [
    "json:read",
    "aonprd:squash",
    "rdfjs:finalize",
    "catalog:emit"
  ],
  "output": {
    "kind":   "file",
    "path":   "./graphs/aonprd",
    "format": "trig",
    "bucketing": {
      "enabled":  true,
      "strategy": "per-graph-iri"
    },
    "catalog": {
      "enabled": true,
      "rewriteRoots": [
        {
          "uriStartString": "https://squashage.dev/graph/aonprd/",
          "rewritePrefix":  "./"
        }
      ]
    }
  }
}
```

The catalog is written to `<output.path>/<targetId>.catalog.xml`.

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `enabled` | boolean | yes |  | Must be `true` to emit the catalog. Requires `bucketing.enabled: true`. |
| `filename` | string | no | `<targetId>.catalog.xml` | Override the catalog filename. Falls back to `catalog.xml` if the target ID is unavailable. |
| `prefer` | `"public"` \| `"system"` | no | `"public"` | OASIS catalog `prefer` attribute. `"public"` is the correct value when resolving by graph IRI. |
| `includeOntologies` | boolean | no | `true` | Emit `<public>`/`<uri>` entries for ontology files when the ontology engine is active. |
| `includeContexts` | boolean | no | `true` | Emit `<system>` entries for JSON-LD context files when `format=jsonld`. |
| `includeShapes` | boolean | no | `true` | Emit `<uri>` entries for the SHACL shapes file when `output.validate.shapes` is set. |
| `rewriteRoots` | array | no | `[]` | `<rewriteURI>` entries. Each item: `{ uriStartString, rewritePrefix }`. |

**Catalog entries:**
- One `<uri name="<graphIRI>" uri="./filename.ext"/>` per non-empty named-graph bucket.
- Default-graph bucket: indexed only when `bucketing.defaultGraphCatalogIri` is set.
- Overflow bucket (`__other__`): never indexed.
- All paths are relative to the catalog file's location (OASIS convention).

---

## Migration from v0.6.x

Prior to v0.7.0, classifier config was nested inside a `classification` block:

```jsonc
// v0.6.x (old)
{
  "targets": {
    "aonprd": {
      "classification": {
        "source": true,
        "structural": [ ... ],
        "rules": [ ... ],
        "schemas": [ ... ],
        "ontology": { "classes": { ... } },
        "conflict": { ... }
      }
    }
  }
}
```

In v0.7.0+, each namespace moves to the top of the target config. Remove the `classification` wrapper and flatten:

```jsonc
// v0.7.0+ (new)
{
  "targets": {
    "aonprd": {
      "source": true,
      "structural": [ ... ],
      "rules": [ ... ],
      "schemas": [ ... ],
      "ontologyClassifier": { "classes": { ... } },  // note: renamed from "ontology"
      "conflict": { ... }
    }
  }
}
```

Key renames:
- `classification.ontology` → `ontologyClassifier` (avoid collision with `target.ontology.engine`)
- All other keys are identical; only the nesting level changes.

Plugin-provided config stays where it was (e.g., `enrichment.entityLink` remains under `enrichment`).

---

## Related

- [Pipeline](./pipeline); how the task queue works
- [Classifier cascade](./classifier-cascade); predicate language, per-task behavior, priority table
- [Output](./output); format details, canonicalization, SHACL gate
- [Context silo](../context-silo); how plugins read their config namespace via `ctx.config[<namespace>]`
