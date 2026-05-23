---
layout: doc
title: winkNLP entities classifier
description: classify:winknlp-entities runs deterministic pattern-based NER on configured prose fields via winkNLP custom entities.
---

# winkNLP entities classifier

`classify:winknlp-entities` runs deterministic pattern-based named-entity recognition on configured prose fields via [winkNLP](https://winkjs.org/wink-nlp/) custom entities.

One winkNLP model is loaded in the node's constructor; all configured patterns are registered via `learnCustomEntities` once at that time. The per-record hot path is `nlp.readDoc(text).customEntities().out(its.detail)` over each configured field.

## Config slot

Under `targets[].classification.winknlpEntities`:

```json
{
  "classification": {
    "winknlpEntities": {
      "fields": ["description", "summary"],
      "patterns": [
        {
          "name":      "two-action-cost",
          "patterns":  ["two actions", "two-action"],
          "className": "ActionTwoCost",
          "priority":  28
        }
      ]
    }
  }
}
```

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `patterns` | array, min 1 | yes | | One or more pattern groups. |
| `patterns[].name` | string | yes | | Unique pattern identifier passed to winkNLP. |
| `patterns[].patterns` | string[], min 1 | yes | | winkNLP pattern strings (literal tokens or alternations like `[two\|2]`). |
| `patterns[].className` | string | yes | | Ontology class id proposed when this pattern fires. |
| `patterns[].priority` | integer ≥ 0 | no | `28` | Numeric priority. |
| `fields` | string[] | no | `["description"]` | Prose field names to inspect on each record. |

## Match semantics

Patterns are registered with `matchValue: false, usePOS: false, useEntity: false`, so pattern strings match against normalized (lowercase) token values as plain literals. Fields absent on a record, non-string, or empty are silently skipped.

## Emitted proposal

The highest-priority matching pattern wins `state.proposals['classify:winknlp-entities']`. Every match across every field appears in `reasons`:

```json
{
  "source":     "classify:winknlp-entities",
  "className":  "ActionTwoCost",
  "priority":   28,
  "confidence": 1,
  "reasons": [
    "winknlp:pattern=two-action-cost",
    "winknlp:matched=two actions",
    "winknlp:field=description"
  ]
}
```

Matched text snippets are truncated to 80 characters in `reasons`.

## Edge cases

- **Malformed pattern.** `learnCustomEntities` throws at construction; the error names every pattern in the failing group.
- **Unknown pattern type returned.** Should never happen (we register every pattern ourselves); silently dropped if it does.
- **All fields absent.** Returns `no-match`; other classifiers may still produce one.

## See also

- [Classifier cascade](./classifier-cascade)
- [Configuration](./configuration)
