---
layout: doc
title: Taxonomic narrowing
description: classify:taxonomic-narrowing drops supertype proposals when a more-specific subtype is also present, via OWL subClassOf transitive closure.
---

# Taxonomic narrowing

`classify:taxonomic-narrowing` runs sequentially after the parallel classifier placement. It reads every other classifier's proposal and drops any supertype proposals when a more-specific subtype is also present. Result: when `classify:rules` proposes `Weapon` and `classify:structural` proposes `Sword`, only `Sword` survives — provided the TBox declares `Sword rdfs:subClassOf Weapon`.

It never adds class proposals; it only removes them. A `__narrowing_applied__` sentinel summarises the audit trail for evidence preservation.

## Config slot

Under `classification.taxonomicNarrowing`:

```json
{
  "classification": {
    "taxonomicNarrowing": {
      "tboxFrom": "ontology",
      "enabled":  true
    }
  }
}
```

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `tboxFrom` | string | yes | | Either `"ontology"` (read from `services.ontology.tbox()`) or a filesystem path to a Turtle / N-Quads OWL TBox file (resolved relative to `schemasBase`). |
| `enabled` | boolean | no | `true` | When `false`, the node is a no-op. |

## TBox sources

| `tboxFrom` value | Source |
|---|---|
| `"ontology"` | `services.ontology.tbox()` — requires `targetConfig.ontology.engine === 'json-tology'`. When the ontology is absent, the node disables itself silently. |
| any other path | Filesystem file. Format inferred from extension (`.nq` / `.n-quads` → N-Quads; everything else → Turtle). Loaded synchronously at construction. |

## Closure algorithm

1. Collect every `<sub> owl:subClassOf <sup>` quad where both terms are `NamedNode`. Class names are the IRI's last `#`-fragment or `/`-segment.
2. Seed `closure[A] = directSupertypes[A]`.
3. Iterate until fixpoint: for each `A`, add every supertype-of-a-supertype reachable through the graph. Warshall-style; cycles terminate because the loop only adds, never removes.

The resulting `Map<className, Set<supertypeName>>` is cached in the node instance. Per-record execution reads `state.proposals`, identifies classes that another proposal supersedes, deletes those proposal slots, and writes a single `__narrowing_applied__` sentinel under `state.proposals['classify:taxonomic-narrowing']`:

```json
{
  "source":     "classify:taxonomic-narrowing",
  "className":  "__narrowing_applied__",
  "priority":   0,
  "confidence": 1,
  "reasons": [
    "narrowed: Sword subClassOf Weapon; dropped Weapon"
  ]
}
```

`classify-conflict` filters the sentinel before picking a winner; it surfaces in `state.classification.reasons` only when `conflict.evidence: true`.

## Edge cases

- **No subClassOf assertions.** Closure is empty; the node returns `no-op` for every record.
- **Cycles in subClassOf.** Tolerated (the algorithm only adds entries, so it terminates). All classes in a cycle become mutually supertypes; every proposal is considered a supertype of every other; nothing survives. Don't ship cyclic TBoxes.
- **Single proposal.** Fewer than two proposals → nothing to narrow → `no-op`.

## See also

- [Classifier cascade](./classifier-cascade)
- [Ontology (json-tology)](./ontology) — wire an ontology so `tboxFrom: 'ontology'` resolves.
