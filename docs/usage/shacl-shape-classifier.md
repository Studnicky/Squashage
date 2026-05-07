# SHACL-shape classifier

The `classify:shacl-shape` task is a deterministic classifier that validates each record's projected ABox against SHACL shapes and emits one proposal per conforming `sh:NodeShape`. It sits between the schema classifier (priority 30) and the ontology classifier (priority 50) in the standard cascade, with a default priority of 45.

## Rules vs schemas vs shapes: when to pick which

| Engine | Best for | Signal strength |
|--------|----------|-----------------|
| `classify:structural` | Type-discriminator fields (`_type`, `kind`) | Very high when a field is present |
| `classify:schema` | JSON Schema property validation (AJV) | High, but schema must be manually maintained |
| `classify:shacl-shape` | Semantic shape conformance via SHACL NodeShapes | High; shapes can be auto-derived from json-tology |
| `classify:ontology` | Class IRI lookup by derived or mapped class names | Medium; confirms class membership, does not classify by structure |
| `classify:rules` | Complex multi-field compound predicates | High for narrow conditions; brittle at scale |

Choose `classify:shacl-shape` when:

- You are already using `engine: "json-tology"` and want auto-emitted shapes to drive classification without writing rules.
- You have existing SHACL shape files from an ontology governance workflow and want to reuse them as a classification signal.
- Property-cardinality constraints and `sh:datatype` checks are strong classification signals for your data.

## State machine

```
                  ┌─────────────────────────────────────────┐
                  │  ShaclShapeClassifier.execute(state)     │
                  └───────────────────┬─────────────────────┘
                                      │
                shapesFrom === 'ontology' AND jt absent?
                                      │ YES
                                      v
                           next()  [no-op]
                                      │ NO
                                      v
                        Load shapes (jt.shacl() or file)
                                      │
                        ┌─────────────v───────────────┐
                        │   extractNodeShapes(quads)  │
                        └─────────────┬───────────────┘
                                      │
                        For each NodeShape with targetClass:
                                      │
                        ┌─────────────v───────────────┐
                        │  resolveClassName(shape,jt)  │
                        └─────────────┬───────────────┘
                                      │
                        ┌─────────────v───────────────┐
                        │  buildValidationPair(shape,  │
                        │    record)                  │
                        └─────────────┬───────────────┘
                                      │
                        ┌─────────────v───────────────┐
                        │  ShaclGate.run(shapes, data) │
                        └─────────────┬───────────────┘
                                      │
                     report.conforms? │ YES
                                      v
                         emit proposal { className, priority:45 }
                                      │
                                      v
                           next()
```

**ABox projection** uses the shape's `sh:path` property IRIs as predicates. For each path IRI, the classifier looks for a record property whose key matches the last fragment or path segment of the IRI (e.g., `https://squashage.dev/schemas/aonprd/feat#name` maps to `record["name"]`). A synthetic `sh:targetNode` is injected when the shape lacks `sh:targetClass`.

## Config schema

```json
{
  "classification": {
    "shaclShape": {
      "shapesFrom": "ontology",
      "priority": 45
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `shapesFrom` | `"ontology"` or string | Yes | Shape source. `"ontology"` uses auto-emitted shapes from json-tology. Any other value is treated as a filesystem path to a Turtle shape file. |
| `priority` | integer | No (default: 45) | Numeric priority written onto every proposal. |

### Worked example: ontology mode

```jsonc
{
  "targets": {
    "aonprd": {
      "pipeline": [
        "json:read",
        "classify:shacl-shape",
        "classify:schema",
        "classify:ontology",
        "classify:conflict",
        "aonprd:squash",
        "rdfjs:finalize"
      ],
      "ontology": {
        "engine":  "json-tology",
        "baseIRI": "https://squashage.dev/vocabulary/aonprd",
        "schemas": [
          { "schemaPath": "./schemas/feat.schema.json" },
          { "schemaPath": "./schemas/spell.schema.json" }
        ]
      },
      "classification": {
        "shaclShape": {
          "shapesFrom": "ontology",
          "priority":   45
        },
        "schemas": [
          { "className": "feat",  "priority": 30, "schemaPath": "./schemas/feat.schema.json" },
          { "className": "spell", "priority": 30, "schemaPath": "./schemas/spell.schema.json" }
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
      }
    }
  }
}
```

### Worked example: file-path mode

```jsonc
{
  "classification": {
    "shaclShape": {
      "shapesFrom": "./shacl/aonprd-shapes.ttl",
      "priority":   45
    }
  }
}
```

The Turtle file must use `sh:targetClass` on each `sh:NodeShape` for the classifier to derive class names:

```turtle
@prefix sh:  <http://www.w3.org/ns/shacl#> .
@prefix aon: <https://squashage.dev/vocabulary/aonprd#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

aon:FeatShape a sh:NodeShape ;
  sh:targetClass aon:Feat ;
  sh:property [
    sh:path aon:name ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
  ] .
```

## Edge cases

### Shape with no `sh:targetClass`

In ontology mode (json-tology), NodeShape IRIs are the schema `$id`s (e.g., `https://squashage.dev/schemas/aonprd/feat`). There is no `sh:targetClass` in auto-emitted shapes. The classifier resolves the class name by looking up the schema `$id` in `jt.classMap()` and uses `sh:targetNode` for focus node selection instead.

In file-path mode, shapes without `sh:targetClass` fall back to deriving the class name from the last fragment or path segment of the NodeShape IRI. If the IRI yields an empty segment, the shape is skipped.

### Multi-class records

If a record's properties satisfy multiple shapes simultaneously (e.g., both a `Feat` and a `Spell` shape), the classifier emits one proposal per conforming shape. The `classify:conflict` resolver downstream picks the highest-priority proposal or quarantines the record when configured with `onConflict: "quarantine"`.

### Zero-conformance records

Records that fail every shape receive no SHACL proposal. The record continues through the pipeline; downstream classifiers (schema, ontology, rules) may still produce proposals. If no classifier produces a proposal, `classify:conflict` applies `onUnknown` policy.

### Shape file load failure

When `shapesFrom` is a filesystem path and the file is missing or unreadable, `ShaclShapeClassifier.create()` throws an `OutputConfigError` at startup (before any records are processed). This is intentional: missing shape files indicate a config error, not a per-record failure.

### Shape file parse failure

Malformed Turtle in a shape file causes `Parser.parse()` to reject at startup. The error propagates as an unhandled rejection from the async parsing step and surfaces before the pipeline begins processing records.
