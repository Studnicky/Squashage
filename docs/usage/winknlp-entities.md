# winkNLP entities classifier

The `classify:winknlp-entities` task is a deterministic, pattern-based Named Entity Recognition (NER) classifier that inspects configured prose fields (such as `description`, `summary`, or `rules_text`) and emits one classification proposal per matched pattern. It recovers type signal that is buried in human-readable text but invisible to structural or URL classifiers.

## The problem

Many records in scraped corpora emit prose fields as bare `xsd:string` literals. The graph loses signal that is textually obvious:

- "This feat costs **two actions** to activate" -- action-cost pattern visible to a human, invisible to a key-presence rule
- "You can **cast this spell** as a reaction" -- cast-timing idiom, again structurally invisible

`classify:winknlp-entities` recovers that signal using deterministic pattern matching: no probabilities, no models, no network calls.

## Why winkNLP and not LLMs

Squashage operates under a no-LLM determinism contract: the same input must produce byte-identical output on every replay, offline and in CI. LLM-based extraction violates that contract.

winkNLP satisfies the contract:

| Property | winkNLP | LLM-based extraction |
|---|---|---|
| Deterministic output | Yes | No (sampling, API drift) |
| Offline capable | Yes (model ships with npm package) | No (network call) |
| Performance | ~650 k tokens/sec | 10-100x slower |
| Pattern authorship | Explicit, auditable config | Prompt engineering |
| CI safe | Yes | No |

## Pattern syntax

Patterns are expressed as space-separated token strings. By default each token is matched against the normalized (lowercased) form of the document token:

```json
{ "patterns": ["two actions"] }
```

matches the literal sequence `two actions` anywhere in the prose field.

Bracket syntax `[option1|option2]` expresses alternatives within a single token position:

```json
{ "patterns": ["[two|2] [action|actions]"] }
```

matches `two action`, `two actions`, `2 action`, or `2 actions`.

For the full pattern reference, see the [winkNLP learnCustomEntities documentation](https://winkjs.org/wink-nlp/learn-custom-entities.html).

## Configuration

Add `classification.winknlpEntities` to any target:

```jsonc
"classification": {
  "winknlpEntities": {
    "patterns": [
      {
        "name":      "feat-action-cost",
        "patterns":  ["two actions", "three actions", "[one|1] action"],
        "className": "feat",
        "priority":  28
      },
      {
        "name":      "spell-cast-time",
        "patterns":  ["cast this spell", "casting time"],
        "className": "spell",
        "priority":  28
      }
    ],
    "fields": ["description", "summary", "rules_text"]
  }
}
```

Add `classify:winknlp-entities` to the pipeline before `classify:conflict`:

```jsonc
"pipeline": [
  "json:read",
  "classify:source",
  "classify:structural",
  "classify:winknlp-entities",
  "classify:conflict",
  "rdfjs:finalize"
]
```

### Config fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `patterns` | array | yes | -- | One or more pattern groups (see below) |
| `fields` | string[] | no | `["description"]` | Prose fields to inspect per record |

Each entry in `patterns`:

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | yes | -- | Unique pattern identifier, appears in proposal reasons |
| `patterns` | string[] | yes | -- | One or more winkNLP pattern strings |
| `className` | string | yes | -- | Ontology class proposed on match |
| `priority` | integer | no | `28` | Conflict-resolution weight |

## Worked example: aonprd feats and spells

Given the following aonprd records:

```json
// feat-power-attack.json
{
  "_type": "feat",
  "name": "Power Attack",
  "description": "You unleash a powerful attack that costs two actions."
}

// spell-fireball.json
{
  "_type": "spell",
  "name": "Fireball",
  "description": "Cast this spell to hurl a bead of fire."
}
```

With config:

```jsonc
"winknlpEntities": {
  "patterns": [
    {
      "name":      "feat-action-cost",
      "patterns":  ["two actions", "three actions"],
      "className": "feat",
      "priority":  28
    },
    {
      "name":      "spell-cast",
      "patterns":  ["cast this spell"],
      "className": "spell",
      "priority":  28
    }
  ],
  "fields": ["description"]
}
```

The classifier emits:

- For `feat-power-attack.json`: proposal `{ className: "feat", priority: 28, reasons: ["winknlp:pattern=feat-action-cost", "winknlp:matched=two actions", "winknlp:field=description"] }`
- For `spell-fireball.json`: proposal `{ className: "spell", priority: 28, reasons: ["winknlp:pattern=spell-cast", "winknlp:matched=cast this spell", "winknlp:field=description"] }`

## Edge cases

**Missing field.** If the record does not have the configured prose field (e.g., no `description` key), the classifier silently produces no proposal and calls `next()`. The pipeline continues normally.

**Empty string.** If the configured field is an empty string, no `readDoc` call is made and no proposal is emitted.

**Pattern with zero matches.** If the prose text contains none of the configured patterns, no proposal is emitted. The classifier is a no-op for that field.

**Non-string field value.** If the configured field contains a number, array, or object instead of a string, the value is silently skipped.

**Conflicting class names.** If two patterns fire on the same record and their `className` values differ, both proposals land on `state.classifications`. The downstream `classify:conflict` resolver selects the winner based on `priority`. Configure `classify:conflict` with `onConflict: "pickPriority"` or `onConflict: "quarantine"` to control conflict behaviour.

**Malformed pattern.** winkNLP validates patterns at `create` time (before the first record is processed). If a pattern string is malformed, construction throws `OutputConfigError` naming the offending pattern's `name` field. The pipeline fails fast at startup rather than silently producing no proposals at runtime.

**Snippet truncation.** The `winknlp:matched=` reason carries at most 80 characters of matched text. Longer matches are truncated without ellipsis.

## Pipeline placement

`classify:winknlp-entities` is a proposer-tier task. Place it after input tasks and before `classify:conflict`:

```
json:read
classify:source          (optional)
classify:structural      (optional)
classify:url-pattern     (optional)
classify:winknlp-entities
classify:conflict        (required when >= 2 proposers are active)
rdfjs:finalize
```

The winkNLP model and all patterns are compiled once at orchestrator startup. Per-record cost is tokenization plus pattern automaton evaluation -- no I/O, no allocations beyond the proposal array.
