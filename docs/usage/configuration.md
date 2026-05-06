---
layout: doc
title: Configuration
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
  classification: ClassificationConfig;  // optional; needed if classify:* tasks are in pipeline
  concurrency:    number;            // optional, default 1
  graphs:         { [key: string]: string };  // optional; named graph IRI overrides
  ontology:       object;            // optional; free-form ontology metadata
  quarantine:     object;            // optional; quarantine path overrides
}
```

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `input` | string | yes |  | Path to input directory (resolved relative to `input.basePath`). |
| `pipeline` | string[] | yes |  | Ordered list of task names. Each must be registered (built-in or plugin). |
| `output` | OutputConfig | yes |  | See [Output config](#output-config) below. |
| `classification` | ClassificationConfig | no |  | Required when pipeline includes `classify:*` tasks. |
| `concurrency` | integer ≥ 1 | no | `1` | How many records to process in parallel. `ConcurrentPipeline` uses this. |
| `graphs` | object | no |  | Named-graph IRI overrides. Keys map to task-specific graph names. |
| `ontology` | object | no |  | Free-form metadata passed to plugins via `state.context`. |
| `quarantine` | object | no |  | Path overrides for quarantine artifact directories. |

---

## Classification config

Only needed when the pipeline includes `classify:source`, `classify:structural`, `classify:rules`, `classify:schema`, `classify:ontology`, or `classify:conflict`.

The cascade is opt-in by task. If you list `classify:rules` in `pipeline`, you must supply `classification.rules`. The AJV schema rejects partial configs at load time.

**Validation timing**: Config is validated at load time (before any record is processed). If a pipeline lists `classify:rules` but `classification.rules` is missing or empty, the orchestrator throws exit code `2`. If a listed task's config block is present but invalid (e.g., malformed predicate), the schema rejects it during parsing. Schema files are loaded and compiled once at startup; if a schema file doesn't exist or is invalid JSON Schema, the build fails before the first record is read. This fail-fast behavior prevents silent mode where 1000 records process before a config mistake is discovered.

```ts
{
  source:     true;                          // enable SourceClassifier
  structural: StructuralRule[];              // enable StructuralClassifier
  rules:      RulesEntry[];                  // enable RulesClassifier
  schemas:    SchemaEntry[];                 // enable SchemaClassifier (AJV)
  ontology:   { classes: { [className: string]: string } };  // enable OntologyClassifier
  conflict:   { onConflict: 'quarantine'|'pickPriority'; onUnknown: 'quarantine'|'skip'; evidence: boolean };
}
```

### `classification.source`

Set to `true`. Enables `classify:source`. Reads `_source` from the record and emits a `__source__` marker proposal. No other config needed.

### `classification.structural`

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

### `classification.rules`

Same shape as `structural`. Use for multi-condition decision-table rules.

### `classification.schemas`

Per-class AJV JSON Schema validators:

```json
[
  { "className": "feat",  "priority": 30, "schemaPath": "./schemas/feat.schema.json" },
  { "className": "spell", "priority": 30, "schemaPath": "./schemas/spell.schema.json" }
]
```

`schemaPath` is resolved relative to the config file's directory.

### `classification.ontology`

Maps class names to their full ontology IRI. The `classify:ontology` task rejects proposals whose `className` is not in this map:

```json
{
  "classes": {
    "feat":  "https://squashage.dev/vocabulary/aonprd#Feat",
    "spell": "https://squashage.dev/vocabulary/aonprd#Spell"
  }
}
```

### `classification.conflict`

Required when more than one class-proposing task is in the pipeline (which is almost always):

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

---

## Output config

Source of truth: `src/schemas/output.schema.json`.

```ts
{
  kind:         'file';                          // required, only value
  path:         string;                          // required
  format?:      'turtle'|'trig'|'ntriples'|'nquads'|'jsonld';
  mode?:        'dataset' | 'stream';            // default: 'dataset'
  prefixes?:    { [prefix: string]: string };
  baseIRI?:     string;
  graph?:       string;
  canonicalize?: boolean;                        // default: false
  validate?:    { shapes: string };
  dryRun?:      boolean;                         // default: false
  jsonldContext?: string | object;
}
```

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `kind` | `"file"` | yes |  | Only `"file"` is supported. |
| `path` | string | yes |  | Output file path. Extension determines format if `format` is omitted. |
| `format` | enum | no | inferred from extension | One of `turtle`, `trig`, `ntriples`, `nquads`, `jsonld`. RDF/XML and N3 are deferred; no maintained streaming serializer exists on npm. |
| `mode` | `"dataset"` \| `"stream"` | no | `"dataset"` | `dataset` buffers the full graph before writing; `stream` writes quads as they arrive. Stream mode disables `canonicalize` and `validate`. |
| `prefixes` | object | no |  | Additional prefix declarations merged into the output context. |
| `baseIRI` | URI | no |  | Base IRI for relative IRI resolution. |
| `graph` | URI | no |  | Collapse all quads into this named graph at write time. Required when using a triple-only format (turtle, ntriples) with a target that emits named-graph quads. |
| `canonicalize` | boolean | no | `false` | Run RDFC-1.0 before writing. Produces byte-identical output across runs. Incompatible with stream mode. |
| `validate.shapes` | string | no |  | Path to a SHACL shapes graph. Validated by `src/shacl/ShaclGate.ts` before write. On failure: writes quarantine report, skips output file. |
| `dryRun` | boolean | no | `false` | Run the full pipeline including classification and projection; skip writing the output file. |
| `jsonldContext` | string \| object | no | auto | Compaction context for JSON-LD output. Path string, inline object, or omit to let squashage build one from the quad set. Rejected by cross-validation when `format` is not `jsonld`. |

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

**Cross-field validation**: If you list a classifier task in the pipeline but omit its config block (e.g., `pipeline: ["json:read", "classify:rules", ...]` but no `classification.rules`), the orchestrator rejects the config at load time and exits with code `2`. This fail-fast prevents silent skipping where a rule file doesn't exist and classification appears to work but produces no proposals. Schema path resolution is relative to the config file's directory; if a schema file path is absolute or relative to the wrong directory, file-not-found errors surface before the first record is processed.

---

## Richly-configured example

All classifiers active, SHACL validation, RDFC-1.0 canonicalization, concurrent processing:

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
        "classify:ontology",
        "classify:conflict",
        "aonprd:squash",
        "rdfjs:finalize"
      ],
      "classification": {
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
        "ontology": {
          "classes": {
            "feat":  "https://squashage.dev/vocabulary/aonprd#Feat",
            "spell": "https://squashage.dev/vocabulary/aonprd#Spell"
          }
        },
        "conflict": {
          "onConflict": "quarantine",
          "onUnknown":  "quarantine",
          "evidence":   true
        }
      },
      "output": {
        "kind":         "file",
        "path":         "./graphs/aonprd.jsonld",
        "mode":         "dataset",
        "canonicalize": true,
        "validate": {
          "shapes": "./schemas/aonprd.shapes.ttl"
        }
      }
    }
  }
}
```

---

## Related

- [Pipeline](./pipeline); how the task queue works
- [Classifier cascade](./classifier-cascade); predicate language, per-task behavior
- [Output](./output); format details, canonicalization, SHACL gate
