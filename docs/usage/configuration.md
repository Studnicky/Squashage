---
layout: doc
title: Configuration
description: Squashage JSON config schema — a config file IS one run. Root object holds input, output, and run knobs directly. Load with squashage-dag build --config squashage.config.json.
---

# Configuration

The config is a JSON file. **A config file is one run.** The root object holds `input`, `output`, and the run knobs directly. Load it with `squashage-dag build --config squashage.config.json`.

Schema source of truth: `src/schemas/squashage-config.schema.json`.

Copy `squashage.config.example.json` as a starting point.

## Root shape

```ts
{
  input:          { basePath: string; format: 'json' | 'jsonl' };  // required
  output:         OutputConfig;                          // required — see Output config below
  concurrency:    number;                                // optional, default 1
  graphs:         { [key: string]: string };             // optional — named-graph IRI overrides
  ontology:       OntologyConfig;                         // optional — json-tology engine config
  classification: ClassificationConfig;                  // optional — classifier opt-ins
  enrichment:     { entityLink?: EntityLinkConfig };     // optional — post-batch enrichment
  quarantine:     QuarantineConfig;                       // optional — quarantine output overrides
  subjectIri:     SubjectIriConfig;                       // optional — subject IRI minting policy
}
```

There is **no `pipeline` field**. The DAG topology is authored as `.dag.jsonld` documents and loaded at construction; classifiers join the per-record DAG automatically when their config slot is present. See [DAG](./pipeline) for the full topology.

### `input`

| Key | Type | Required | What it does |
|---|---|---|---|
| `basePath` | string | yes | Base directory for the run's input. |
| `format` | `"json"` \| `"jsonl"` | yes | One JSON object per file (`json`), or one per line (`jsonl`). |

### Root knobs

| Key | Type | Required | Default | Notes |
|---|---|---|---|---|
| `input` | object | yes | | Input source — see above. |
| `output` | OutputConfig | yes | | See [Output config](#output-config). |
| `concurrency` | integer ≥ 1 | no | `1` | Maximum concurrent record-DAG clones in the native `scatter`. |
| `graphs` | object | no | | Named-graph IRI overrides; keys map to `services.graphs`. |
| `ontology` | object | no | | `{ engine: 'json-tology', baseIRI, schemas: [...] }` enables the optional `services.ontology`. |
| `classification` | object | no | | Per-classifier config slots — see below. |
| `enrichment.entityLink` | object | no | | Post-batch entity-link configuration. |
| `quarantine` | object | no | | Quarantine output directory overrides. |
| `subjectIri` | object | no | | Subject IRI minting policy. |

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

The primary classification path for runs where records carry a type field.

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
  type:   'file';
  path:   string;
  format: 'turtle' | 'trig' | 'ntriples' | 'nquads' | 'jsonld';
  mode?:  'dataset' | 'stream';   // default 'dataset'; 'stream' streams quads to disk
}
```

`type` is the discriminant. `rdfjs-finalize` writes these files on every run:

| File | What it carries |
|---|---|
| `<output.path>` | The success graph. |
| `<output.path-stem>.prov.<ext>` | PROV-O activity graph emitted by the dispatcher's lifecycle hooks. |
| `<outDir>/<run>/quarantine/<bucket>/<id>.json` | Failed records, grouped by bucket. |

---

## Example

```jsonc
{
  "input":  { "basePath": "./input", "format": "json" },
  "output": { "type": "file", "path": "./graphs/aonprd.trig", "format": "trig" },
  "concurrency": 4,
  "graphs": { "default": "https://example.org/graph/aonprd/default" },
  "ontology": { "baseIri": "https://2e.aonprd.com/" },
  "classification": {
    "conflict":   { "onConflict": "pickPriority", "evidence": true },
    "source":     true,
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
```

For bounded-memory streaming, set `output.mode` to `stream` and write a quad format:

```jsonc
{
  "input":  { "basePath": "./input", "format": "json" },
  "output": { "type": "file", "path": "./graphs/aonprd.nq", "format": "nq", "mode": "stream" }
}
```
