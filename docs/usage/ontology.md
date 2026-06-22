---
layout: doc
title: Ontology (json-tology)
description: Squashage ontology modes — hand-map (flat class-to-IRI map) and the json-tology engine (derives SHACL shapes, JSON Schemas, and OWL TBox from a single ontology definition). ABox projection is lenient; unmapped classes fall back to Generic.
---

# Ontology

Squashage supports two ontology modes for a run: the default **hand-map** mode and the opt-in **json-tology** engine. Both modes coexist; setting `engine: "json-tology"` does not change how classification runs.

## json-tology projection

ABox projection runs on `@studnicky/json-tology`. Projection is **lenient**: no record is dropped on shape mismatch. A record whose class maps to a known schema projects against that schema; a record whose class has no schema mapping projects under the **Generic fallback class**, so every classified record reaches the graph. The Generic fallback keeps the open-world contract intact — unmapped data is still typed and queryable rather than quarantined.

## Two-mode design

### Hand-map mode (default)

You supply a flat class map under `ontologyClassifier` (the config namespace for the `classify:ontology` node):

```json
"classification": {
  "ontologyClassifier": {
    "classes": {
      "feat":  "https://squashage.dev/vocabulary/aonprd#Feat",
      "spell": "https://squashage.dev/vocabulary/aonprd#Spell"
    }
  }
}
```

Note: the config namespace is `ontologyClassifier`, not `ontology`. The `ontology` key at the config root is reserved for the json-tology engine config (`ontology.engine`). This asymmetry prevents collision.

The `classify:ontology` node uses this map to validate that every proposed class name has a registered IRI. No schemas are needed; no TBox or SHACL files are produced. This is the right choice when:

- You maintain ontology IRI assignments manually.
- You do not need auto-derived TBox or SHACL files.

### json-tology engine (opt-in)

You point Squashage at your JSON Schemas and let it derive class IRIs, OWL TBox declarations, and SHACL shapes automatically:

```json
"ontology": {
  "engine":  "json-tology",
  "baseIRI": "https://squashage.dev/vocabulary/aonprd",
  "schemas": [
    { "schemaPath": "./schemas/feat.schema.json" },
    { "schemaPath": "./schemas/spell.schema.json" }
  ],
  "emit": {
    "tbox":  "graphs/aonprd/ontology.ttl",
    "shacl": "graphs/aonprd/shapes.ttl"
  }
}
```

With this mode active, Squashage:

1. Reads each schema file at config-load time.
2. Derives `className` from the schema `title` field (falls back to the last `$id` segment if `title` is absent).
3. Builds class IRIs as `${baseIRI}#${className}`.
4. Exposes a `JsonTologyOntology` instance on `services.ontology` for use in plugin nodes.
5. Runs the `ontology-emit` node to write the TBox and SHACL files to the configured paths.

The `ontologyClassifier.classes` block coexists with this mode; it continues to drive `classify:ontology` in the same way.

## Schema requirements

Each schema must have:

- `$id` (string): a URI identifying the schema. Used as the lookup key in `services.ontology.toQuads(schemaId, instance)`.
- `title` (string, recommended): becomes the `className`. Without `title`, Squashage falls back to the last segment of `$id`. If the last segment is empty or degenerate, config load fails.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://squashage.dev/schemas/aonprd/feat",
  "title": "Feat",
  "type": "object",
  "properties": {
    "name": { "type": "string" }
  }
}
```

## Pipeline state machine

The TBox and SHACL files are produced through the following sequence:

```
Config load
  |
  v
SquashageConfig.loadFromFile()
  - reads ontology.schemas[] from the config root
  - validates engine, baseIRI, schemas (AJV if/then)
  |
  v
SquashageRun.forRun()
  - reads each schemaPath relative to the config directory
  - calls JsonTologyOntology.create({ baseIRI, schemas })
  - stores the instance on services.ontology; any derivation error surfaces here
  |
  v
Per-record DAG (json-read, classify:*, squash, ...)
  - the squash node may call services.ontology.toQuads(schemaId, record)
  - records with no schema mapping project under the Generic fallback class
  |
  v
rdfjs-finalize
  - serializes the canonical dataset to the output file
  |
  v
ontology-emit
  - calls services.ontology.tbox()  -> OWL TBox quads
  - calls services.ontology.shacl() -> SHACL shape quads
  - serializes each to TriG (named-graph-aware)
  - writes to ontology.emit.tbox and ontology.emit.shacl paths
  |
  v
Done
```

## Plugin usage

Squash nodes can use `services.ontology` for typed ABox projection:

```ts
const aboxQuads = await context.services.ontology?.toQuads(FeatSchema.$id, record);
if (aboxQuads !== undefined) {
  for (const q of aboxQuads) {
    context.services.dataset.add(q);
  }
}
```

The `?.` guard keeps the node working when the engine is absent: when `engine` is unset, `services.ontology` is `null` and the block is skipped.

## Edge cases

**Missing schema title**: If a schema has no `title` and its `$id` ends with an empty segment (e.g. `https://example.org/`), config load throws `OutputConfigError`. Fix: add an explicit `title` to the schema.

**IRI conflicts**: If two schemas derive the same `className` (e.g. two schemas both titled `"Widget"`), config load throws `OutputConfigError`. Fix: ensure all `title` values (or `$id` trailing segments) are unique within `ontology.schemas[]`.

**Empty schemas array**: `engine: "json-tology"` with `schemas: []` is rejected by the AJV schema at config load. The JSON Schema `if/then` constraint requires `baseIRI` and `schemas` when `engine` is `"json-tology"`.

**emit paths not configured**: If `ontology.emit.tbox` or `ontology.emit.shacl` is absent, `ontology-emit` logs a warning and continues without writing those files. This is intentional: the engine can be active for ABox projection without emitting TBox or SHACL files.

**TriG output format**: TBox and SHACL quads from json-tology include named graph IRIs (e.g. `https://squashage.dev/vocabulary/aonprd/ontology/`). The `ontology-emit` node serializes them as TriG. Despite the `.ttl` extension convention, the files are valid TriG documents.

## Worked example: aonprd fixture

Config snippet (`tests/e2e/aonprd/squashage.config.json`):

```json
{
  "ontology": {
    "engine":  "json-tology",
    "baseIRI": "https://squashage.dev/vocabulary/aonprd",
    "schemas": [
      { "schemaPath": "./schemas/feat.schema.json" },
      { "schemaPath": "./schemas/spell.schema.json" },
      { "schemaPath": "./schemas/monster.schema.json" },
      { "schemaPath": "./schemas/action.schema.json" },
      { "schemaPath": "./schemas/equipment.schema.json" }
    ],
    "emit": {
      "tbox":  "graphs/aonprd/ontology.ttl",
      "shacl": "graphs/aonprd/shapes.ttl"
    }
  }
}
```

Each schema file has a `title` (`"Feat"`, `"Spell"`, etc.). After `ontology-emit` runs:

- `graphs/aonprd/ontology.ttl` contains OWL class and property declarations for all five schemas.
- `graphs/aonprd/shapes.ttl` contains SHACL NodeShape and PropertyShape constraints derived from the same schemas.

Class IRIs derive as:

| title | class IRI |
|-------|-----------|
| Feat  | `https://squashage.dev/vocabulary/aonprd#Feat` |
| Spell | `https://squashage.dev/vocabulary/aonprd#Spell` |
| Monster | `https://squashage.dev/vocabulary/aonprd#Monster` |
| Action | `https://squashage.dev/vocabulary/aonprd#Action` |
| Equipment | `https://squashage.dev/vocabulary/aonprd#Equipment` |

These match the hand-written IRIs in the `ontologyClassifier.classes` map, so the two modes interoperate.
