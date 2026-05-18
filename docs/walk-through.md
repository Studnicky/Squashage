---
layout: doc
title: Walk-through
description: End-to-end example from raw Pathfinder JSON to interactive RDF graph — config, plugin, JSON-LD output, and cytoscape render. Everything runs from tests/e2e/aonprd/.
---

# Walk-through

One concrete end-to-end example from raw JSON to interactive RDF graph. The source data is Pathfinder Second Edition from the [Archives of Nethys](https://2e.aonprd.com/) (aonprd). You can run this exact pipeline yourself; everything is in `tests/e2e/aonprd/`.

---

## Before; the input

```json
{
  "_type":       "feat",
  "url":         "https://2e.aonprd.com/Feats.aspx?ID=750",
  "name":        "Power Attack",
  "level":       1,
  "rarity":      "common",
  "traits":      ["flourish"],
  "action_cost": "two-actions",
  "_source": {
    "target": "aonprd",
    "path":   "feat-power-attack.json",
    "url":    "https://2e.aonprd.com/Feats.aspx?ID=750",
    "plugin": "aonprd:parse"
  }
}
```

This is what an upstream tool (a scraper, an API client, anything) produced. Squashage does not care which tool; only that the record carries `_source` metadata for reproducibility.

Field breakdown:

- `_type`: the discriminator the classifier reads. Every structural, rules, schema, and ontology predicate in the cascade runs against this value.
- `_source.url`: where prefix derivation gets the instance namespace. `https://2e.aonprd.com/` → instance base `https://squashage.dev/instance/aonprd/`.
- `level`, `rarity`, `traits`, `action_cost`; structural fields that become RDF predicates in the output graph.

---

## The config

```jsonc
{
  "targets": {
    "aonprd": {
      "input": "./input",
      "pipeline": [
        "json:read",
        "classify:source",
        "classify:structural",
        "classify:rules",
        "classify:ontology",
        "classify:conflict",
        "aonprd:squash",
        "rdfjs:finalize"
      ],
      "classification": {
        "source": true,
        "structural": [
          {
            "className": "feat",
            "priority":  10,
            "predicate": { "path": "/_type", "equals": "feat" },
            "reasons":   ["_type=feat (structural)"]
          }
        ],
        "rules": [
          {
            "className": "feat",
            "priority":  20,
            "predicate": {
              "all": [
                { "path": "/_type", "equals": "feat" },
                { "path": "/level", "type": "number" }
              ]
            },
            "reasons": ["_type=feat", "level present"]
          }
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
      },
      "output": {
        "kind":         "file",
        "path":         "./out/aonprd.jsonld",
        "mode":         "dataset",
        "canonicalize": true
      }
    }
  }
}
```

Each pipeline step:

| Step | What it does |
|------|-------------|
| `json:read` | Reads one JSON file and populates `state.input` and `state.source`. |
| `classify:source` | Reads `_source` and emits a `__source__` marker proposal. |
| `classify:structural` | Matches closed-vocab predicates against the record; emits `feat` proposal. |
| `classify:rules` | Runs decision-table rules over the same predicate language; emits `feat` at higher priority. |
| `classify:ontology` | Checks proposed classNames against the ontology map; rejects unknowns. |
| `classify:conflict` | Picks the winner by `priority` desc then `className` lex asc; routes ties to quarantine. |
| `aonprd:squash` | User plugin; emits RDF/JS quads into the shared dataset. |
| `rdfjs:finalize` | Serializes the canonical dataset to JSON-LD; runs RDFC-1.0 canonicalization. |

---

## The squasher plugin

This is the only code the consumer writes. Everything else is config.

```ts
import { TaskRegistry } from 'squashage/registry/TaskRegistry';

TaskRegistry.register('aonprd:squash', async (next, state) => {
  const ctx            = state.context;
  const classification = state.classification;
  if (ctx === undefined || classification === null) { await next(); return; }

  const { factory, dataset, prefixes } = ctx;
  const urlTail = new URL(state.input['url'] as string).pathname.slice(1);
  const subject = factory.namedNode(`${prefixes.instances.base}${urlTail}`);
  const graph   = factory.namedNode(`${prefixes.graphs.base}${classification.type}`);
  const RDF_TYPE = factory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');

  // rdf:type
  dataset.add(factory.quad(
    subject, RDF_TYPE,
    factory.namedNode(`${prefixes.vocabulary.base}Feat`),
    graph,
  ));

  // aonprd:name
  if (typeof state.input['name'] === 'string') {
    dataset.add(factory.quad(
      subject,
      factory.namedNode(`${prefixes.vocabulary.base}name`),
      factory.literal(state.input['name']),
      graph,
    ));
  }

  // aonprd:rarity (object property → named node)
  if (typeof state.input['rarity'] === 'string') {
    dataset.add(factory.quad(
      subject,
      factory.namedNode(`${prefixes.vocabulary.base}rarity`),
      factory.namedNode(`${prefixes.vocabulary.base}Rarity-${state.input['rarity']}`),
      graph,
    ));
  }

  await next();
});
```

`state.context.prefixes` carries derived IRIs; squashage resolves `_source.url` into instance / graph / vocabulary base IRIs so the plugin never hardcodes a domain.

---

## After; the output

The relevant slice of `docs/public/examples/aonprd/aonprd.jsonld` for the Power Attack entity:

```json
{
  "@context": {
    "aonprd":       "https://squashage.dev/vocabulary/aonprd#",
    "aonprd:rarity": { "@id": "aonprd:rarity", "@type": "@id" },
    "aonprd:trait":  { "@id": "aonprd:trait",  "@type": "@id", "@container": "@set" },
    "aonprd:level":  { "@id": "aonprd:level",  "@type": "xsd:integer" },
    "aonprdg":      "https://squashage.dev/graph/aonprd/"
  },
  "@graph": [
    {
      "@id":           "aonprdg:feat",
      "@graph": [
        {
          "@id":              "https://squashage.dev/instance/aonprd/Feats.aspx?ID=750",
          "@type":            "aonprd:Feat",
          "aonprd:actionCost": "two-actions",
          "aonprd:level":      "1",
          "aonprd:name":       "Power Attack",
          "aonprd:rarity":    "aonprd:Rarity-common",
          "aonprd:trait":     ["aonprd:Trait-flourish"]
        }
      ]
    }
  ]
}
```

What each field shows:

- **`@id`**: derived from `_source.url` via `PrefixResolver`. No IRI was hardcoded; the pipeline computed it.
- **`@type`**: the classifier's winning `className` mapped to its ontology class IRI.
- **`aonprd:rarity`**: declared `@type: @id` in the context because every rarity value is a named node, not a literal. Auto-inferred by `JsonldContext.build`.
- **`aonprd:level`**: typed as `xsd:integer` because the source JSON value was a number. Auto-inferred.
- **`aonprd:trait`**: containerised as `@set` because the source JSON value was an array. Auto-inferred.

---

## What ran in between

1. **1 record read** from `feat-power-attack.json` via `json:read`.
2. **4 classification proposals emitted**: `__source__` (source classifier) + `feat` at priority 10 (structural) + `feat` at priority 20 (rules) + `feat` at priority 30 (schema).
3. **Conflict resolver** picked `feat` (highest priority; single winner).
4. **Squasher** emitted 6 quads: `rdf:type`, `name`, `level`, `rarity`, `trait`, `actionCost`.
5. **RDFC-1.0 canonicalization** normalized blank node labels and quad order.
6. **JSON-LD compaction** applied the auto-built `@context`, collapsed the dataset into a single file.
7. **Output report** written to `out/aonprd.jsonld`; 0 quarantine artifacts, exit code 0.

---

## Live demo

See the full Pathfinder/AONPRD fixture rendered as an interactive cytoscape graph on the [Demo page](./examples/aonprd).

---

## Where to look next

- [Architecture](./architecture); pipeline phases, package boundaries, output contract
- [Classifier engines](./classification-engines); the six task classes, the predicate language
- [Architecture](./architecture); implementation record and open work
