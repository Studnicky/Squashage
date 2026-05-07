# Ontology

Squashage supports two ontology modes for a target: the default **hand-map** mode and the opt-in **json-tology** engine. Both modes coexist; changing an existing config to use `engine: "json-tology"` does not break the classification pipeline.

## Two-mode design

### Hand-map mode (default)

The legacy mode. You supply a flat `classification.ontology.classes` map:

```json
"classification": {
  "ontology": {
    "classes": {
      "feat":  "https://squashage.dev/vocabulary/aonprd#Feat",
      "spell": "https://squashage.dev/vocabulary/aonprd#Spell"
    }
  }
}
```

The `classify:ontology` task uses this map to validate that every proposed class name has a registered IRI. No schemas are needed; no TBox or SHACL files are produced. This is the right choice when:

- You maintain ontology IRI assignments manually.
- You do not need auto-derived TBox or SHACL files.
- You are migrating from v0.4.x and want a zero-change upgrade path.

### json-tology engine (opt-in, v0.5.0+)

The new mode. You point Squashage at your JSON Schemas and let it derive class IRIs, OWL TBox declarations, and SHACL shapes automatically:

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
4. Exposes a `JsonTologyOntology` instance on `state.context.jt` for use in plugin tasks.
5. Runs the `ontology:emit` task to write the TBox and SHACL files to the configured paths.

The `classification.ontology.classes` block is **not** replaced by this mode; it continues to drive `classify:ontology` in the same way. Migration of that block is a Phase 2 concern.

## Schema requirements

Each schema must have:

- `$id` (string): a URI identifying the schema. Used as the lookup key in `state.context.jt.toQuads(schemaId, instance)`.
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
  - reads ontology.schemas[] from the target config
  - validates engine, baseIRI, schemas (AJV if/then)
  |
  v
SquashageOrchestrator.#buildJtInstance()
  - reads each schemaPath relative to the config directory
  - calls JsonTologyOntology.create({ baseIRI, schemas })
  - stores the instance; any derivation error surfaces here
  |
  v
SquashageOrchestrator.#buildContext()
  - assigns jt to state.context.jt
  - all per-record states share the same jt instance
  |
  v
Per-record pipeline (json:read, classify:*, squash:*, ...)
  - plugin tasks may call ctx.jt.toQuads(schemaId, record)
  |
  v
rdfjs:finalize
  - serializes the canonical dataset to the output file
  |
  v
ontology:emit
  - calls ctx.jt.tbox()  -> OWL TBox quads
  - calls ctx.jt.shacl() -> SHACL shape quads
  - serializes each to TriG (named-graph-aware)
  - writes to ontology.emit.tbox and ontology.emit.shacl paths
  |
  v
Done
```

## Plugin usage

Plugin tasks can use `state.context.jt` for typed ABox projection:

```ts
const aboxQuads = await ctx.jt?.toQuads(FeatSchema.$id, record);
if (aboxQuads !== undefined) {
  for (const q of aboxQuads) {
    ctx.dataset.add(q);
  }
}
```

The `?.` guard makes the plugin backward-compatible: when `engine` is absent or `"map"`, `ctx.jt` is `undefined` and the block is skipped.

## Edge cases

**Missing schema title**: If a schema has no `title` and its `$id` ends with an empty segment (e.g. `https://example.org/`), config load throws `OutputConfigError`. Fix: add an explicit `title` to the schema.

**IRI conflicts**: If two schemas derive the same `className` (e.g. two schemas both titled `"Widget"`), config load throws `OutputConfigError`. Fix: ensure all `title` values (or `$id` trailing segments) are unique within the target's `ontology.schemas[]` array.

**Empty schemas array**: `engine: "json-tology"` with `schemas: []` is rejected by the AJV schema at config load. The JSON Schema `if/then` constraint requires `baseIRI` and `schemas` when `engine` is `"json-tology"`.

**emit paths not configured**: If `ontology.emit.tbox` or `ontology.emit.shacl` is absent, `ontology:emit` logs a warning and calls `next()` without writing any files. This is intentional: the engine can be active for ABox projection without emitting TBox or SHACL files.

**TriG output format**: TBox and SHACL quads from json-tology include named graph IRIs (e.g. `https://squashage.dev/vocabulary/aonprd/ontology/`). The `ontology:emit` task serializes them as TriG. Despite the `.ttl` extension convention, the files are valid TriG documents.

## Worked example: aonprd fixture

Config snippet (`tests/e2e/aonprd/squashage.config.json`):

```json
{
  "targets": {
    "aonprd": {
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
  }
}
```

Each schema file has a `title` (`"Feat"`, `"Spell"`, etc.). After `ontology:emit` runs:

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

These match the hand-written IRIs in the legacy `classification.ontology.classes` map, making the two modes interoperable during the Phase 1 to Phase 2 migration window.
