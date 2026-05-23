---
layout: doc
title: SHACL-shape classifier
description: classify:shacl-shape projects each record into a SHACL-validatable ABox and emits one proposal per conforming NodeShape.
---

# SHACL-shape classifier

`classify:shacl-shape` validates each record's projected ABox against SHACL NodeShapes. Each shape with `sh:targetClass` or an ontology-derived class identity becomes a class-vote.

Shapes are loaded once at construction time (Turtle file or `services.ontology.shacl()`); the per-record path builds a tiny per-shape data graph via `sh:path` projection and runs `rdf-validate-shacl` over it.

## Config slot

Under `targets[].classification.shaclShape`:

```json
{
  "classification": {
    "shaclShape": {
      "shapesFrom": "ontology",
      "priority":   45
    }
  }
}
```

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `shapesFrom` | string | yes | | `"ontology"` reads shapes from `services.ontology.shacl()`; any other string is a filesystem path to a Turtle shapes file. |
| `priority` | integer ≥ 0 | no | `45` | Numeric priority written onto every emitted proposal. |

## Shape sources

| `shapesFrom` value | Source |
|---|---|
| `"ontology"` | `services.ontology.shacl()` — auto-emitted shapes from the json-tology engine. When the ontology is absent, the node returns `no-match` silently. |
| any other path | Filesystem Turtle file resolved relative to `schemasBase`. Loaded + parsed at construction. |

## Class name resolution

For each NodeShape descriptor:

1. `sh:targetClass` IRI's last fragment/segment, when present.
2. Ontology mode: look up the class whose schema `$id` matches the NodeShape IRI in `services.ontology.classMap()`.
3. Fallback: the NodeShape IRI's last fragment/segment.

A shape that resolves no name is skipped.

## ABox projection

For each shape, the classifier builds a tiny data graph centred on a synthetic `urn:record:0` subject:

- When the shape has `sh:targetClass`, an `rdf:type` triple satisfies the focus-node selector.
- When it doesn't, the shape graph is cloned and a synthetic `sh:targetNode <urn:record:0>` is injected.
- Each `sh:path` IRI's last fragment/segment becomes the property key; the record's value at that key is emitted as a typed literal (`xsd:integer` / `xsd:decimal` / `xsd:boolean` / plain string).

The validation runs through `ShaclGate` (a thin wrapper over `rdf-validate-shacl`). A conformance result emits one proposal per shape:

```json
{
  "source":     "classify:shacl-shape",
  "className":  "Feat",
  "priority":   45,
  "confidence": 1,
  "reasons": [
    "shacl:targetClass=https://example.org/vocabulary#Feat",
    "shacl:conforms=true"
  ]
}
```

The highest-priority conforming shape wins `state.proposals['classify:shacl-shape']`; reasons from every conforming shape are merged.

## Edge cases

- **Empty shapes graph.** `no-match` for every record.
- **No `NodeShape` quads.** `no-match` for every record.
- **Validator throws on a shape.** That shape is silently skipped; remaining shapes still evaluate.
- **Ontology mode + no ontology.** `no-match` silently — consumers of optional `services.ontology` must no-op when it's absent.

## See also

- [Classifier cascade](./classifier-cascade)
- [Ontology (json-tology)](./ontology) — auto-emits SHACL shapes from schemas.
