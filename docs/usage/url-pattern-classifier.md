# URL-pattern classifier

The `classify:url-pattern` task is a deterministic classifier that evaluates pre-compiled regular expressions against each record's URL field and emits one proposal per matching pattern. For scraped data, the URL is often the strongest available type signal -- a `/Feats.aspx` path is unambiguous in a way that property structure alone cannot be. This engine promotes that signal to an explicit, configurable surface.

## When to use URL-pattern classification

| Engine | Best for | Signal strength |
|--------|----------|-----------------|
| `classify:structural` | Type-discriminator fields (`_type`, `kind`) | Very high when field is present |
| `classify:schema` | JSON Schema property validation (AJV) | High, but schema must be manually maintained |
| `classify:url-pattern` | URL path as a class discriminator | Very high for scraped data with consistent URL patterns |
| `classify:rules` | Complex multi-field compound predicates | High for narrow conditions; brittle at scale |

Choose `classify:url-pattern` when:

- You are processing scraped records where the page URL reliably identifies the record type (e.g., `/Feats.aspx`, `/Spells.aspx`).
- You want to capture type information that is not present in the JSON record body itself.
- URL patterns are stable across your data corpus and change only with schema-breaking upstream updates.

The default priority (35) places URL-pattern proposals below schema classifier proposals (priority 30 is a common baseline) but at a corroborating tier. Adjust `priority` in config to change how the ConflictResolver weighs this signal against others.

## State machine

```
                  +----------------------------------------------+
                  |  UrlPatternClassifier.execute(state)          |
                  +--------------------+--------------------------+
                                       |
               No _source.url AND no top-level url?
                                       |  YES
                                       v
                           next()  [no proposal]
                                       |  NO
                                       v
                    url = _source.url ?? input.url
                                       |
                    +------------------v------------------+
                    |  For each compiled pattern (frozen) |
                    +------------------+------------------+
                                       |
                    +------------------v------------------+
                    |  pattern.regex.test(url)?           |
                    +------------------+------------------+
                               NO |   | YES
                                  |   v
                                  | emit proposal {
                                  |   className, priority,
                                  |   engine: 'url-pattern',
                                  |   reasons: ['url-pattern: <src>', 'url=<url>']
                                  | }
                                  |   |
                    +--------------+--+
                                       |
                       (more patterns to evaluate?)
                                       |
                                       v
                              next()
```

Regex instances are compiled once at construction time in `UrlPatternClassifier.create(config)`. The hot per-record path performs only `regex.test(url)` calls against the frozen compiled-pattern array -- no string interpolation, no allocation beyond the proposal list.

## Config schema

```json
{
  "classification": {
    "urlPattern": {
      "patterns": [
        {
          "className": "feat",
          "match":     "/Feats\\.aspx",
          "priority":  35
        }
      ]
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `patterns` | array | Yes | One or more pattern entries. At least one is required. |
| `patterns[].className` | string | Yes | Ontology class id to propose when the pattern matches. |
| `patterns[].match` | string | Yes | Regex source string. Compiled once at config load via `new RegExp(match)`. |
| `patterns[].priority` | integer | No (default: 35) | Numeric priority written onto every proposal emitted by this pattern. |

### Worked example: aonprd feat and spell patterns

```jsonc
{
  "targets": {
    "aonprd": {
      "pipeline": [
        "json:read",
        "classify:source",
        "classify:url-pattern",
        "classify:schema",
        "classify:ontology",
        "classify:conflict",
        "aonprd:squash",
        "rdfjs:finalize"
      ],
      "classification": {
        "source": true,
        "urlPattern": {
          "patterns": [
            { "className": "feat",  "match": "/Feats\\.aspx",  "priority": 35 },
            { "className": "spell", "match": "/Spells\\.aspx", "priority": 35 }
          ]
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

A record with `_source.url: "https://2e.aonprd.com/Feats.aspx?ID=750"` produces:

```json
{
  "source":     "classify:url-pattern",
  "className":  "feat",
  "priority":   35,
  "confidence": 1,
  "reasons": [
    "url-pattern: /Feats\\.aspx",
    "url=https://2e.aonprd.com/Feats.aspx?ID=750"
  ]
}
```

## URL field resolution

The classifier looks for the URL in two places, in priority order:

1. `_source.url` (squashage-enriched form, populated by the scraper plugin).
2. Top-level `url` field (raw scrape form, present when the scraper did not embed a `_source` block).

When `_source` is present but has no `url` field, the classifier falls back to the top-level `url`. When neither is present (or both are empty strings), no proposal is emitted and the record passes through to the next task.

## Edge cases

### Missing URL field

Records without `_source.url` and without a top-level `url` field receive no URL-pattern proposals. The record continues through the pipeline; other classifiers (structural, schema, rules) may still produce proposals. If no classifier produces any proposal, `classify:conflict` applies `onUnknown` policy.

### Invalid regex at construction

If any `match` string in the config is not a valid regular-expression source, `UrlPatternClassifier.create()` throws an `OutputConfigError` at startup (before any records are processed). The error message names the zero-based pattern index:

```
classify:url-pattern: invalid regex at patterns[1].match "[invalid(": ...
```

This is intentional: invalid regex patterns indicate a config error, not a per-record failure. The pipeline never starts.

### Ambiguous URL matching multiple patterns

A URL that matches two or more patterns produces multiple proposals -- one per matching pattern. The `classify:conflict` resolver selects the winner based on priority. When two patterns share the same `priority` and both match, the conflict resolver applies `onConflict` policy (`pickPriority` selects the first by insertion order; `quarantine` writes the record to the conflicts bucket).

### Non-string URL fields

If `_source.url` or top-level `url` exists but is not a string (e.g., `null`, a number, or an object), the classifier skips that field and moves to the fallback. A non-string value in both positions is treated the same as an absent URL -- no proposal is emitted.
