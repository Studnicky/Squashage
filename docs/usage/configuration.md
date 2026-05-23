---
layout: doc
title: Configuration
description: Squashage JSON config schema — top-level shape, target blocks, classifier config slots, output block. Load with squashage-dag build --config squashage.config.json.
---

# Configuration

The config is a JSON file. Load it with `squashage-dag build --target <name> --config squashage.config.json`.

Schema source of truth: `src/schemas/squashage-config.schema.json` (top-level) and `src/schemas/target.schema.json` (per-target).

Copy `squashage.config.example.json` as a starting point.

## Top-level shape

```ts
{
  input:   { basePath: string; format: 'json' | 'jsonl' };  // required
  targets: { [name: string]: TargetConfig };                 // required, min 1
}
```

### `input`

| Key | Type | Required | What it does |
|---|---|---|---|
| `basePath` | string | yes | Base directory for all target input paths. |
| `format` | `"json"` \| `"jsonl"` | yes | One JSON object per file (`json`), or one per line (`jsonl`). |

### `targets`

An object whose keys are target names and values are target configs.

---

## Target config

```ts
{
  input:          string;       // required — input directory or single file
  output:         OutputConfig; // required — see Output config below
  concurrency:    number;       // optional, default 1
  graphs:         { [key: string]: string };          // optional — named-graph IRI overrides
  ontology:       OntologyConfig;                      // optional — json-tology engine config
  classification: ClassificationConfig;                // optional — classifier opt-ins
  enrichment:     { entityLink?: EntityLinkConfig };   // optional — post-batch enrichment
}
```

There is **no `pipeline` field**. The DAG topology is fixed; classifiers join the parallel placement automatically when their config slot is present. See [DAG](./pipeline) for the full topology.

| Key | Type | Required | Default | Notes |
|---|---|---|---|---|
| `input` | string | yes | | Input directory or single file. JSON / JSONL detected by extension. |
| `output` | OutputConfig | yes | | See [Output config](#output-config). |
| `concurrency` | integer ≥ 1 | no | `1` | Maximum concurrent record-DAG executions. |
| `graphs` | object | no | | Named-graph IRI overrides; keys map to `services.graphs`. |
| `ontology` | object | no | | `{ engine: 'json-tology', baseIRI, schemas: [...] }` enables the optional `services.ontology`. |
| `classification` | object | no | | Per-classifier config slots — see below. |
| `enrichment.entityLink` | object | no | | Post-batch entity-link configuration. |

---

## Classification config

Each classifier in the per-record DAG has its own slot under `classification.<key>`. When a slot is present, the corresponding classifier is constructed and registered on the dispatcher. When a slot is absent, a no-op classifier is registered under the same name so the static DAG topology still resolves.

```ts
{
  classification: {
    conflict:            ConflictConfig;             // optional but recommended
    discriminator:       DiscriminatorConfig;        // optional — primary open-world path
    source:              true;                       // optional — emits __source__ marker
    structural:          StructuralRule[];           // optional
    rules:               RulesEntry[];               // optional
    schemas:             SchemaEntry[];              // optional
    urlPattern:          UrlPatternConfig;           // optional
    shaclShape:          ShaclShapeConfig;           // optional
    propertyFingerprint: PropertyFingerprintConfig;  // optional
    winknlpEntities:     WinknlpEntitiesConfig;      // optional
    ontologyClassifier:  OntologyClassifierConfig;   // optional — sequential post-parallel
    taxonomicNarrowing:  TaxonomicNarrowingConfig;   // optional — sequential post-parallel
  };
}
```

| Slot | Classifier | Output |
|---|---|---|
| `discriminator` | reads a JSON Pointer field (e.g. `/_type`) and uses the literal value as the className; open-world (no enumeration needed) | `proposed` / `no-match` |
| `source` | reads `_source` block; emits a `__source__` metadata marker | `proposed` / `no-match` |
| `structural` | compiled JSON-pointer predicates over `state.input` | `proposed` / `no-match` |
| `rules` | full decision-table predicates | `proposed` / `no-match` |
| `schemas` | AJV per-class validators | `proposed` / `no-match` |
| `urlPattern` | regex over `_source.url` or top-level `url` | `proposed` / `no-match` |
| `shaclShape` | SHACL ABox validation against record-projected quads | `proposed` / `no-match` |
| `propertyFingerprint` | Jaccard similarity over property key sets | `proposed` / `no-match` |
| `winknlpEntities` | pattern-based NER over prose fields | `proposed` / `no-match` |
| `ontologyClassifier` | validates other classifiers' class names against the known class map | `validated` / `no-match` |
| `taxonomicNarrowing` | drops supertype proposals via OWL `subClassOf` closure | `narrowed` / `no-op` |

### `discriminator`

The primary classification path for targets where records carry a type field.

```ts
{
  from:      string;                               // JSON Pointer into the record
  fallback?: string;                               // pointer used when from is absent
  priority?: number;                               // default 50; recommend 80 to beat fallbacks
  sanitize?: 'verbatim' | 'pascalCase' | 'kebabToPascal';  // default 'verbatim'
}
```

`pascalCase` and `kebabToPascal` both split on `[-_\s]+` boundaries and capitalize each segment: `"monster-family"` → `"MonsterFamily"`.

See [Classifier cascade](./classifier-cascade) and [Taxonomy](./taxonomy) for detail.

### `conflict`

```ts
{
  onConflict: 'quarantine' | 'pickPriority';
  evidence:   boolean;
}
```

`onConflict` decides how the conflict resolver behaves on a genuine tie (two or more classes share the top priority). `evidence: true` preserves every contributing proposal's `reasons` in the final `state.classification`.

---

## Output config

See [Output](./output) for full details. The minimal shape:

```ts
{
  kind:   'file';
  path:   string;
  format: 'turtle' | 'trig' | 'ntriples' | 'nquads' | 'jsonld';
}
```

`rdfjs-finalize` writes three files in every run:

| File | What it carries |
|---|---|
| `<output.path>` | The success graph. |
| `<output.path-stem>.prov.<ext>` | PROV-O activity graph emitted by `ProvObserver`. |
| `<outDir>/<target>/quarantine/<bucket>/<id>.json` | Failed records, grouped by bucket. |

---

## Example

```json
{
  "input":   { "basePath": "./output", "format": "json" },
  "targets": {
    "aonprd": {
      "input":   "./output/aonprd",
      "output":  { "kind": "file", "path": "./graphs/aonprd.trig", "format": "trig" },
      "concurrency": 4,
      "graphs":  { "default": "https://example.org/graph/aonprd/default" },
      "ontology": { "baseIri": "https://aonprd.example.org/" },
      "classification": {
        "conflict": { "onConflict": "pickPriority", "evidence": true },
        "structural": [
          { "className": "feat", "priority": 20,
            "predicate": { "path": "/_type", "equals": "feat" },
            "reasons": ["_type=feat"] }
        ],
        "urlPattern": {
          "patterns": [
            { "className": "feat", "match": "/Feats\\.aspx", "priority": 35 }
          ]
        }
      }
    }
  }
}
```
