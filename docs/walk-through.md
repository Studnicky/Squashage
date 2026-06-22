---
layout: doc
title: Walk-through
description: One classified record's full journey through Squashage — JSON in, RDF out, plus PROV-O activity quads describing every node that ran.
---

# Walk-through

One record's full journey through Squashage. Pathfinder Second Edition data from the [Archives of Nethys](https://2e.aonprd.com/).

## Before — the input

```json
{
  "_type":  "feat",
  "url":    "https://2e.aonprd.com/Feats.aspx?ID=750",
  "name":   "Power Attack",
  "level":  1,
  "rarity": "common",
  "traits": ["flourish"],
  "action_cost": "two-actions",
  "_source": {
    "target": "aonprd",
    "url":    "https://2e.aonprd.com/Feats.aspx?ID=750",
    "plugin": "aonprd:parse"
  }
}
```

Any upstream tool can produce this — a scraper, an API client, a hand-written export. Squashage cares only that the record carries an optional `_source` block for provenance.

## The config

A config file is one run. The root object carries `input`, `output`, and the run knobs (`graphs`, `ontology`, `classification`, `enrichment`, `quarantine`, `concurrency`, `subjectIri`) directly.

```jsonc
{
  "input":  { "basePath": "./input", "format": "json" },
  "output": { "type": "file", "path": "./graphs/aonprd.trig", "format": "trig" },
  "concurrency": 4,
  "graphs": { "default": "https://example.org/graph/aonprd/default" },
  "ontology": { "baseIri": "https://2e.aonprd.com/" },
  "classification": {
    "conflict":   { "onConflict": "pickPriority", "evidence": true },
    "source":     true,
    "urlPattern": {
      "patterns": [
        { "className": "feat",  "match": "/Feats\\.aspx",  "priority": 35 },
        { "className": "spell", "match": "/Spells\\.aspx", "priority": 35 }
      ]
    },
    "structural": [
      { "className": "feat", "priority": 10,
        "predicate": { "path": "/_type", "equals": "feat" },
        "reasons":   ["_type=feat"] }
    ],
    "ontologyClassifier": {
      "classes": {
        "feat":  "https://example.org/vocab/Feat",
        "spell": "https://example.org/vocab/Spell"
      }
    }
  }
}
```

The DAG topology is fixed — the run is authored as `src/dag/*.dag.jsonld` documents loaded via `DAGDocument.load` and bound with `dispatcher.registerBundle`. Classifiers join the per-record DAG just by appearing under `classification`. `SquashageRun.forRun(config)` materialises the run; the CLI invokes it with:

```bash
squashage-dag build --config ./squashage.config.jsonc
```

## During — what the DAG does

1. **`walk-input`** scans `./input` and produces one `RecordLocator` per file. The native `scatter { dag }` placement fans the array out across per-record DAG instances.

2. **`scatter { dag }`** dispatches the per-record DAG once per locator, capped at `concurrency: 4` workers. Each record runs:

   a. **`record-init`** seeds per-record state from the scattered `RecordLocator`.

   b. **`json-read`** parses the file. On parse failure, route `quarantined` → `record-quarantine` → end.

   c. **`classify-all`** runs the classifier cascade concurrently:
      - `classify:source` writes a `__source__` sentinel because `_source` is present.
      - `classify:url-pattern` writes `{ className: 'feat', priority: 35 }` because the URL matches `/Feats\.aspx`.
      - `classify:structural` writes `{ className: 'feat', priority: 10 }` because `_type === 'feat'`.
      - The remaining classifiers have no config in this run, so their placeholders return `no-match`. See [Classifier cascade](./usage/classifier-cascade) for the full set and what each reads.

   d. **`classify:ontology`** reads `state.proposals` and confirms `feat` is in the known class map; no `__validation__` sentinel needed.

   e. **`classify:taxonomic-narrowing`** has no config slot in this run, so it routes `no-op`.

   f. **`record-health-gate`** sees two real proposals and zero errors; routes `has-proposals`.

   g. **`classify-conflict`** sees both proposals agree on `feat`; writes:
      ```ts
      state.classification = {
        type:       'feat',
        confidence: 1,
        engine:     'classify:url-pattern,classify:structural',
        reasons:    ['engine=url-pattern,regex=/Feats\\.aspx → feat', 'url=https://...', '_type=feat'],
      };
      ```

   h. **`squash`** projects the record to RDF through lenient json-tology ABox projection: the `feat` class maps to `<https://example.org/vocab/Feat>`. The projection drops no record on shape mismatch — an unmapped class is emitted under a Generic fallback class. Here the quad `<record-iri> rdf:type <https://example.org/vocab/Feat>` lands in `state.squashedQuads` and `services.dataset`.

   i. **`output-provenance`** is a no-op (no `output.provenance` config).

3. **`enrich-entity-link`** runs once after the fan-out gathers. No `enrichment.entityLink` config → skipped.

4. The native fold gather (`squashage:record-fold`) collects each per-record result. With `output.mode: 'stream'` the ABox and PROV quads stream to disk as they arrive; otherwise the finalize step splits the dataset:
   - Quads whose graph is `urn:squashage:prov:*` → `./graphs/aonprd.prov.trig`.
   - Everything else → `./graphs/aonprd.trig`.

5. **`catalog-emit`** is a no-op without `output.bucketing`.

## After — the success graph

```turtle
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

<https://squashage.dev/instance/aonprd/record/a94a8fe5>
  rdf:type <https://example.org/vocab/Feat> .
```

The PROV graph (sibling file) carries one `prov:Activity` per node:

```turtle
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dag:  <https://studnicky.dev/dagonizer/vocabulary#> .

<urn:squashage:prov:2026-05-18T00:00:00.000Z> {
  <urn:squashage:activity:.../run:0>
    a prov:Activity, dag:Run ;
    dag:dagName     "squashage:run" ;
    prov:startedAtTime "2026-05-18T00:00:00.000Z"^^xsd:dateTime ;
    prov:endedAtTime   "2026-05-18T00:00:01.234Z"^^xsd:dateTime ;
    dag:lifecycle   "completed" .

  <urn:squashage:activity:...:json-read:1716000000123>
    a prov:Activity, dag:NodeExecution ;
    dag:nodeName "json-read" ;
    dag:output   "loaded" ;
    prov:wasInformedBy <urn:squashage:activity:.../run:0> .

  # ... one activity per node execution ...
}
```

## See also

- [DAG](./usage/pipeline) — every node + every route.
- [Classifier cascade](./usage/classifier-cascade) — what each classifier reads and proposes.
- [Provenance](./usage/provenance) — the PROV-O graph in detail.
- [Architecture](./architecture) — module map + class lineage.
