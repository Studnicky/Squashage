---
layout: doc
title: Classifier cascade
---

# Classifier cascade

Six tasks. You list the ones you want in `pipeline:` and that's the whole opt-in.

List none and you get no classifier. List `classify:rules` and you have to write a rule. List two class-proposing tasks and you have to list `classify:conflict` after them, or the loader yells at you.

The cascade is purely deterministic. Same config + same record = same classification, same quarantine, same exit code. No probabilistic models, no random seeds, no network calls.

## Task menu

| Task | When to use it | Config block |
|------|---------------|--------------|
| `classify:source` | Always — marks the record's origin. | `classification.source: true` |
| `classify:structural` | Records have a reliable discriminator field (`_type`, `type`, `kind`). | `classification.structural: []` |
| `classify:rules` | Multi-field conditions (field X AND field Y exists AND field Z matches regex). | `classification.rules: []` |
| `classify:schema` | You have or can write a JSON Schema per class. | `classification.schemas: []` |
| `classify:ontology` | Sanity-check that only known class names get through. | `classification.ontology: {}` |
| `classify:conflict` | Any time more than one proposing task is in the pipeline. | `classification.conflict: {}` |

**Proposal accumulation flow**: Each proposing task (source, structural, rules, schema) appends to `state.classifications` independently. A single record can accumulate 6+ proposals if multiple classifiers match. The conflict resolver then examines all of them, filters metadata sentinels like `__source__`, and picks one winner by priority (highest first) and className (lex asc as tiebreak). If two proposals tie on priority and disagree on class, `onConflict: 'quarantine'` writes the record to quarantine with both candidates preserved; `onConflict: 'pickPriority'` deterministically picks the lexicographically first className.

---

## classify:source

Reads the `_source` block from the record. If `_source` is present and valid, emits a `__source__` marker proposal at priority 0. Does not propose a class — just marks the record as traceable.

Config: `"source": true`. No other options.

What it emits:
```json
{ "source": "classify:source", "className": "__source__", "priority": 0, "confidence": 1, "reasons": ["_source present"] }
```

---

## classify:structural

Closed-vocab predicate rules evaluated against the record. Each rule has one predicate expression and emits at most one proposal.

```json
"structural": [
  {
    "className": "feat",
    "priority":  10,
    "predicate": { "path": "/_type", "equals": "feat" },
    "reasons":   ["_type=feat (structural)"]
  }
]
```

When to use: the record has a single discriminator field whose value unambiguously identifies the class. If `_type === 'feat'` always means feat, structural is the right layer.

What it emits: one proposal per matching rule. Multiple rules for the same class at different paths are fine.

---

## classify:rules

Same rule shape as structural, but the predicate can compose multiple conditions. Use `all`, `any`, `not` to build decision tables.

```json
"rules": [
  {
    "className": "feat",
    "priority":  20,
    "predicate": {
      "all": [
        { "path": "/_type", "equals": "feat" },
        { "path": "/level", "type": "number" },
        { "path": "/rarity", "in": ["common", "uncommon", "rare"] }
      ]
    },
    "reasons": ["_type=feat", "level present", "rarity valid"]
  }
]
```

Priority 20 is higher than structural's 10 — so if both fire, the rules proposal wins.

---

## classify:schema

Runs the record through an ordered list of pre-compiled AJV validators. First match wins. Schema files are loaded and compiled once at startup.

```json
"schemas": [
  { "className": "feat",  "priority": 30, "schemaPath": "./schemas/feat.schema.json" },
  { "className": "spell", "priority": 30, "schemaPath": "./schemas/spell.schema.json" }
]
```

`schemaPath` is resolved relative to the config file. Standard JSON Schema Draft-07 format.

When to use: you already have schemas (or want to write them) that formally describe each class's structure. Schema validation is more expressive than predicate rules for complex shapes.

---

## classify:ontology

Validates that every proposed class name has an entry in the ontology map. Proposals with unknown class names are rejected and the record goes to quarantine.

```json
"ontology": {
  "classes": {
    "feat":  "https://squashage.dev/vocabulary/aonprd#Feat",
    "spell": "https://squashage.dev/vocabulary/aonprd#Spell"
  }
}
```

Use this whenever you want a hard gate: only classes you've declared in the ontology can make it through. Unknown class proposals from structural/rules/schema get quarantined here rather than silently producing untyped quads.

---

## classify:conflict

Picks the winner from all accumulated proposals.

```json
"conflict": {
  "onConflict": "quarantine",
  "onUnknown":  "quarantine",
  "evidence":   true
}
```

Resolution order:
1. `__source__` proposals are filtered out (they don't represent classes).
2. Remaining proposals sorted: `priority` descending, then `className` lexicographic ascending as tiebreak.
3. If the top two proposals share the same priority → conflict. `onConflict` decides: `quarantine` writes the record to `quarantine/conflicts/<id>.json`; `pickPriority` takes the first one alphabetically.
4. If no proposals survive → unknown. `onUnknown` decides: `quarantine` writes to `quarantine/unknown/<id>.json`; `skip` drops the record.
5. Winner is written to `state.classification`.

Quarantine is graceful. The build doesn't fail when records land there — exit code stays `0`. Check `graphs/<target>/quarantine/` after a build.

**Edge cases**: If structural proposes `feat` at priority 10 and rules proposes `feat` at priority 20, both for the same record, conflict resolution sees one className (feat) with two distinct priorities. The higher-priority rules proposal wins; the structural proposal is superseded, not a conflict. A true conflict happens when structural and rules both fire for different classes at the same priority: `feat` at 20 and `spell` at 20. Then `onConflict` decides whether to quarantine or pick the lexicographically first one (spell). Unreachable rules (predicates that never evaluate to true for any input record in the dataset) produce zero proposals; these records may land unknown or be caught by structural/schema.

---

## Predicate language

All structural and rules predicates use JSON Pointer paths (RFC 6901) and a closed operator set defined in `src/schemas/predicate.schema.json`.

Paths:
- `/field` — top-level field
- `/nested/field` — nested
- `/array/0` — array index
- `~1` escapes `/`, `~0` escapes `~`
- Empty pointer `""` is rejected

### Operators

| Operator | Shape | Notes |
|----------|-------|-------|
| `equals` | `{ path, equals: value }` | Deep structural equality. |
| `notEquals` | `{ path, notEquals: value }` | Inverse of equals. |
| `in` | `{ path, in: [value, ...] }` | Value must be in the array. |
| `notIn` | `{ path, notIn: [value, ...] }` | Value must not be in the array. |
| `exists` | `{ path, exists: true }` | Path must resolve to a non-null value. |
| `missing` | `{ path, missing: true }` | Path must not resolve (or resolve to null). |
| `type` | `{ path, type: 'string'\|'number'\|'boolean'\|'object'\|'array'\|'null' }` | JSON type check. |
| `regex` | `{ path, regex: '^...$' }` | Anchors required. No flags. |
| `length` | `{ path, length: { gte?, lte?, eq? } }` | String or array length. |
| `range` | `{ path, range: { gte?, lte?, gt?, lt? } }` | Finite number comparison. |
| `all` | `{ all: [Predicate, ...] }` | All must match. |
| `any` | `{ any: [Predicate, ...] }` | At least one must match. |
| `not` | `{ not: Predicate }` | Invert. |

### Worked examples

One predicate per operator:

```jsonc
// equals — exact value match
{ "path": "/_type", "equals": "feat" }

// notEquals — exclude a value
{ "path": "/_type", "notEquals": "spell" }

// in — set membership
{ "path": "/rarity", "in": ["common", "uncommon"] }

// notIn — set exclusion
{ "path": "/rarity", "notIn": ["rare", "unique"] }

// exists — field present and non-null
{ "path": "/level", "exists": true }

// missing — field absent or null
{ "path": "/deprecated", "missing": true }

// type — JSON type
{ "path": "/level", "type": "number" }

// regex — pattern match (anchors required)
{ "path": "/url", "regex": "^https://2e\\.aonprd\\.com/Feats\\.aspx" }

// length — string or array length bounds
{ "path": "/traits", "length": { "gte": 1 } }

// range — numeric range
{ "path": "/level", "range": { "gte": 1, "lte": 20 } }

// all — conjunction
{ "all": [
    { "path": "/_type", "equals": "feat" },
    { "path": "/level", "type": "number" },
    { "path": "/rarity", "exists": true }
] }

// any — disjunction
{ "any": [
    { "path": "/_type", "equals": "feat" },
    { "path": "/_type", "equals": "archetype" }
] }

// not — negation
{ "not": { "path": "/_type", "equals": "spell" } }
```

Composition works to arbitrary depth:

```json
{
  "all": [
    { "path": "/_type", "equals": "feat" },
    { "any": [
        { "path": "/level", "range": { "gte": 1, "lte": 10 } },
        { "path": "/traits", "in": ["legendary"] }
    ]},
    { "not": { "path": "/deprecated", "exists": true } }
  ]
}
```

Predicates are compiled once at config load. Runtime evaluation is a single switch over the AST — no interpretation overhead per record.

---

## Related

- [Configuration](./configuration) — how to wire classifiers in the config
- [Pipeline](./pipeline) — where classification fits in the task queue
- [Plugins](./plugins) — classifier plugins that emit custom proposals
