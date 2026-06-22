---
layout: doc
title: URL-pattern classifier
description: classify:url-pattern evaluates pre-compiled regexes against each record's URL field and emits one proposal per matching pattern.
---

# URL-pattern classifier

`classify:url-pattern` evaluates regular expressions against each record's URL field. For scraped data, the URL is often the strongest available type signal — a `/Feats.aspx` path is unambiguous in a way property structure alone cannot be.

Regexes are compiled once in the node's constructor; the per-record hot path is `regex.test(url)` against the frozen compiled array.

## URL field resolution

Resolved in priority order:

1. `_source.url` (squashage-enriched form).
2. Top-level `url` (raw scrape form).

When neither field exists or both are empty strings, the classifier emits no proposal and routes `no-match`.

## Config slot

Under `classification.urlPattern`:

```json
{
  "classification": {
    "urlPattern": {
      "patterns": [
        { "className": "feat",  "match": "/Feats\\.aspx",  "priority": 35 },
        { "className": "spell", "match": "/Spells\\.aspx", "priority": 35 }
      ]
    }
  }
}
```

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `patterns` | array, min 1 | yes | | One or more pattern entries. |
| `patterns[].className` | string | yes | | Ontology class id proposed when the pattern matches. |
| `patterns[].match` | string | yes | | Regex source. Compiled via `new RegExp(match)` at construction. |
| `patterns[].priority` | integer | no | `35` | Numeric priority written onto the emitted proposal. |

## Emitted proposal

The highest-priority matching pattern wins the `state.proposals['classify:url-pattern']` slot. The proposal carries every matched pattern's source in `reasons`:

```json
{
  "source":     "classify:url-pattern",
  "className":  "feat",
  "priority":   35,
  "confidence": 1,
  "reasons": [
    "engine=url-pattern,regex=/Feats\\.aspx → feat",
    "url=https://2e.aonprd.com/Feats.aspx?ID=750"
  ]
}
```

## Edge cases

- **Missing URL field.** Returns `no-match`; no proposal emitted. Other classifiers may still produce one.
- **Invalid regex.** Construction throws synchronously, naming the zero-based pattern index. The pipeline never starts.
- **Multiple matches.** All matched patterns appear in `reasons`; the highest-priority className wins.
- **Non-string URL fields.** Skipped silently; falls through to the next field (or `no-match` if both are missing).

## See also

- [Classifier cascade](./classifier-cascade) — full classifier set + conflict resolution.
- [Configuration](./configuration) — every config slot.
