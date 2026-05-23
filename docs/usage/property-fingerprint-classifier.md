---
layout: doc
title: Property-fingerprint classifier
description: classify:property-fingerprint computes Jaccard similarity between each record's top-level property keys and pre-computed class fingerprints.
---

# Property-fingerprint classifier

`classify:property-fingerprint` computes Jaccard similarity between each record's top-level property key set and a pre-computed fingerprint per class. Useful when records lack an explicit `_type` discriminator and structural rules would be brittle — the shape of the property set itself becomes the signal.

Fingerprints are loaded from a JSON file at construction time and compiled into `Set<string>` instances. The per-record path computes `|A ∩ B| / |A ∪ B|` against each fingerprint and emits a proposal when the score meets or exceeds `minMatchScore`.

## Config slot

Under `targets[].classification.propertyFingerprint`:

```json
{
  "classification": {
    "propertyFingerprint": {
      "fingerprintsFrom": "./schemas/fingerprints.json",
      "minMatchScore":    0.85,
      "priority":         32
    }
  }
}
```

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `fingerprintsFrom` | string | yes | | Path to the fingerprints JSON file, resolved relative to the config directory. |
| `minMatchScore` | number `[0,1]` | no | `0.85` | Jaccard threshold; matches at or above this score emit a proposal. |
| `priority` | integer ≥ 0 | no | `32` | Numeric priority written onto every emitted proposal. |

## Fingerprints file

A JSON object mapping `className` → `{ keys: string[] }`:

```json
{
  "feat":  { "keys": ["name", "type", "level", "description"] },
  "spell": { "keys": ["name", "tradition", "level", "components"] }
}
```

Each entry's `keys` array must have at least one element. The classifier strips `_source` from the record's key set before computing similarity, so source metadata never skews the score.

## Emitted proposal

```json
{
  "source":     "classify:property-fingerprint",
  "className":  "feat",
  "priority":   32,
  "confidence": 0.892,
  "reasons":    ["fingerprint:feat jaccard=0.892"]
}
```

`confidence` is the Jaccard score of the winning fingerprint. When multiple fingerprints exceed the threshold, the highest-priority (then highest-score) one wins the slot; every match appears in `reasons`.

## Edge cases

- **Empty fingerprints file.** Construction throws at startup.
- **Empty `keys` array on a class.** Construction throws naming the className.
- **No record keys.** Jaccard of two empty sets returns `0`; falls below any positive threshold; routes `no-match`.

## See also

- [Classifier cascade](./classifier-cascade)
- [Configuration](./configuration)
