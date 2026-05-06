# Property-fingerprint classifier

The `classify:property-fingerprint` task is a classifier that computes Jaccard similarity between a record's top-level property key set and a set of pre-loaded class fingerprints. Rules generalize poorly across scraped corpora where records share a structural shape but not a clean discriminator field. Fingerprints catch the long tail: records that lack a `_type` field, fail schema validation, or sit outside URL-pattern coverage but still carry a recognisable property silhouette.

## When to use property-fingerprint classification

| Engine | Best for | Signal strength |
|--------|----------|-----------------|
| `classify:structural` | Type-discriminator fields (`_type`, `kind`) | Very high when field is present |
| `classify:schema` | JSON Schema property validation | High, but schema must be maintained |
| `classify:url-pattern` | URL path as a class discriminator | Very high for scraped data |
| `classify:property-fingerprint` | Property key set similarity | Medium-high; complements other classifiers |

Choose `classify:property-fingerprint` when:

- Records lack a reliable type-discriminator field.
- URL patterns are not available or unreliable.
- You have a labelled training corpus to derive fingerprints from (use `npm run viz:fingerprints`).
- You want a fallback signal that fires when structural/schema classifiers produce no proposal.

The default priority (32) places property-fingerprint proposals in the same tier as `classify:rules` and below `classify:schema` (priority 30 baseline). Adjust `priority` to change conflict-resolver weighting.

## State machine

```
                  +----------------------------------------------+
                  |  PropertyFingerprintClassifier.execute(state) |
                  +--------------------+--------------------------+
                                       |
                Extract top-level keys from state.input
                                       |
                         recordKeys = Set(Object.keys(input))
                                       |
                     recordKeys empty?
                          YES |  NO
                              |  v
                              |  For each compiled fingerprint (frozen)
                              |       |
                              |  Compute Jaccard(recordKeys, fingerprint.keySet)
                              |       |
                              |  score >= minMatchScore?
                              |     NO |  YES
                              |        v
                              |  emit proposal {
                              |    className, priority,
                              |    engine: 'property-fingerprint',
                              |    reasons: ['fingerprint.score=<N.NN>',
                              |              'fingerprint.shared=<count>']
                              |  }
                              |        |
                              +--------+
                                       |
                              next()
```

Fingerprints are loaded once at construction time in `PropertyFingerprintClassifier.create(config, configDir)` and pre-computed into `Set<string>` objects. The hot per-record path performs only set-intersection counting -- no file I/O, no string interpolation beyond the proposal reasons array.

## Fingerprints file format

```json
{
  "feat":  { "keys": ["name", "level", "rarity", "traits", "action_cost"], "weight": 0.95 },
  "spell": { "keys": ["name", "level", "traditions", "range", "area"],     "weight": 0.95 }
}
```

Each entry maps a `className` to an object with:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `keys` | string[] | Yes | Top-level property keys that characterise this class. Must be non-empty. |
| `weight` | number | No | Informational; stored in the file but not currently used in scoring. Reserved for future extension. |

## Config schema

```json
{
  "classification": {
    "propertyFingerprint": {
      "fingerprintsFrom": "./fingerprints.json",
      "minMatchScore":    0.85,
      "priority":         32
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fingerprintsFrom` | string | Yes | Path to the fingerprints JSON file, resolved relative to the squashage config file directory. |
| `minMatchScore` | number [0,1] | No (default: 0.85) | Minimum Jaccard similarity required to emit a proposal. |
| `priority` | integer >= 0 | No (default: 32) | Numeric priority written onto every emitted proposal. |

## Worked example: aonprd corpus

### Step 1 -- derive fingerprints from labelled records

```sh
npm run viz:fingerprints -- --records tests/e2e/aonprd/input --out fingerprints.json
```

With the aonprd test corpus this produces (keys sorted):

```json
{
  "feat": {
    "keys": [
      "_source", "_type", "action_cost", "description_text",
      "level", "name", "prerequisites", "rarity", "traits", "url"
    ],
    "weight": 1
  },
  "spell": {
    "keys": [
      "_source", "_type", "action_cost", "area", "description_text",
      "level", "name", "rarity", "range", "saving_throw", "traditions",
      "traits", "url"
    ],
    "weight": 1
  }
}
```

### Step 2 -- add to squashage config

```jsonc
{
  "targets": {
    "aonprd": {
      "pipeline": [
        "json:read",
        "classify:source",
        "classify:property-fingerprint",
        "classify:conflict",
        "aonprd:squash",
        "rdfjs:finalize"
      ],
      "classification": {
        "source": true,
        "propertyFingerprint": {
          "fingerprintsFrom": "./fingerprints.json",
          "minMatchScore":    0.80,
          "priority":         32
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

### Step 3 -- example proposal

A feat record with keys `_source, _type, action_cost, description_text, level, name, prerequisites, rarity, traits, url` (10 keys) compared against the `feat` fingerprint (10 keys) produces:

```
Intersection = 10, union = 10, Jaccard = 1.0
```

Proposal emitted:

```json
{
  "source":     "classify:property-fingerprint",
  "className":  "feat",
  "priority":   32,
  "confidence": 1.0,
  "reasons": [
    "fingerprint.score=1.00",
    "fingerprint.shared=10"
  ]
}
```

## Offline trainer script

The `viz:fingerprints` npm script reads a flat directory of labelled JSON records and writes a fingerprints file by computing the UNION of top-level keys per class name.

```sh
npm run viz:fingerprints -- --records <dir> --out <path>
```

### Filename convention

Records are labelled by filename: `<className>-<rest>.json`. The className is derived from the text before the first hyphen.

| Filename | Derived className |
|----------|------------------|
| `feat-power-attack.json` | `feat` |
| `spell-fireball.json` | `spell` |
| `equipment-longsword.json` | `equipment` |
| `noHyphen.json` | `noHyphen` |

### Key-set union semantics

When multiple records share the same className, the output fingerprint's `keys` array is the UNION of all keys seen across every record. This ensures the fingerprint is broad enough to match any variant of the class, not just the first example.

## Edge cases

### Empty record

A record with no top-level keys (e.g., `{}`) produces no proposals. The classifier calls `next()` and the record continues through the pipeline.

### All-keys-missing record

A record whose keys do not overlap with any fingerprint produces a Jaccard score of 0 for all fingerprints, which is always below the default threshold of 0.85. No proposals are emitted.

### Fingerprint with `weight` field

The `weight` field in the fingerprints file is stored and preserved during `viz:fingerprints` output but is not used in the current Jaccard scoring. It is reserved for future extension (e.g., weighted intersection scoring). Setting it to any value has no effect on the classifier's behaviour.

### Multiple fingerprints matching the same record

When two or more fingerprints both meet `minMatchScore`, the classifier emits one proposal per matching fingerprint. The `classify:conflict` resolver selects the winner based on priority. When two fingerprints share the same priority and both match, the conflict resolver applies `onConflict` policy.

### Missing or malformed fingerprints file

If `fingerprintsFrom` points to a non-existent file, or the file is not valid JSON, `PropertyFingerprintClassifier.create()` throws an `OutputConfigError` at startup (before any records are processed). The error message includes the absolute path to the file.

```
classify:property-fingerprint: cannot read fingerprints file at /abs/path/fingerprints.json: ...
```

### Fingerprint entry with empty keys

If any fingerprint entry has an empty `keys` array, construction throws immediately with an `OutputConfigError` naming the class:

```
classify:property-fingerprint: fingerprint entry "myClass" at /abs/path/fingerprints.json
has an empty "keys" array; at least one key is required
```
