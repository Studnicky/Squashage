# Provenance (PROV-O sidecar)

## The problem: logs vs queryable provenance

Every Squashage run logs which classifier resolved each record and with what confidence. Those logs answer "what happened" but they are ephemeral, unstructured, and not queriable from the same RDF store that holds the classification output.

The sidecar provenance feature writes classification metadata as RDF quads into a dedicated named graph alongside the regular ABox output. Because provenance lives in the same TriG/N-Quads file as the domain data, a SPARQL query can join domain triples with their provenance in a single request -- no log scraping required.

## How it works

The pipeline after Phase 6 looks like this:

```
json:read
  -> classify:source
  -> classify:structural / classify:rules / classify:schema / ...
  -> classify:conflict        (picks the winning class)
  -> aonprd:squash            (domain quad emission -- your plugin)
  -> output:provenance        (provenance quad emission -- built-in)
  -> rdfjs:finalize           (serialise to disk)
```

For each record that reaches `output:provenance`, the task emits quads into a separate named graph:

```turtle
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .

GRAPH <https://squashage.dev/instance/aonprd/provenance> {
  <https://squashage.dev/instance/aonprd/run/d8f772a1>
      a                   prov:Activity ;
      prov:wasGeneratedBy <https://squashage.dev/instance/aonprd/classifier/schema+rules> ;
      prov:value          "0.95"^^xsd:decimal ;
      prov:atTime         "2026-05-06T00:00:00.000Z"^^xsd:dateTime ;
      prov:reason         "schema=feat,priority=40" .
}
```

One `prov:Activity` is emitted per record that reaches the task. Records quarantined by `json:read` (malformed JSON) never reach the task and produce no provenance quads.

The subject IRI (`run/{hash}`) is derived deterministically from the record's file path and line number using a SHA-1 hash, so the same record always maps to the same IRI across runs.

The timestamp is the run's frozen start time, set once when the orchestrator constructs the context. Two replays of the same input with the same config produce byte-identical provenance quads.

## Configuration

Add a `provenance` block to `targets.<id>.output`:

```json
{
  "targets": {
    "aonprd": {
      "pipeline": [
        "json:read",
        "classify:source",
        "classify:structural",
        "classify:rules",
        "classify:schema",
        "classify:conflict",
        "aonprd:squash",
        "output:provenance",
        "rdfjs:finalize"
      ],
      "output": {
        "kind":   "file",
        "path":   "./graphs/aonprd.trig",
        "mode":   "dataset",
        "provenance": {
          "enabled": true,
          "graph":   "provenance",
          "include": ["classifier", "confidence", "reasons", "timestamp"]
        }
      }
    }
  }
}
```

### Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Enable provenance emission. Default-off; standard runs are unaffected. |
| `graph` | string | `"provenance"` | Named-graph IRI suffix or full IRI. A suffix is appended to the instances base (e.g. `provenance` becomes `https://.../provenance`). A string starting with `http://` or `https://` is used as-is. |
| `include` | string[] | all four | Which metadata categories to emit. Remove an item to suppress that metadata. |

### `include` flavours

All four are enabled by default. You can restrict them:

```json
{ "include": ["classifier", "confidence", "reasons", "timestamp"] }
```

| Value | Emitted quad |
|-------|-------------|
| `"classifier"` | `prov:wasGeneratedBy <classifier:{engine}>` |
| `"confidence"` | `prov:value "0.95"^^xsd:decimal` |
| `"reasons"` | `prov:reason "schema=feat,priority=40"` |
| `"timestamp"` | `prov:atTime "2026-..."^^xsd:dateTime` |

Only `"classifier"` example (all others suppressed):

```json
{ "include": ["classifier"] }
```

Only `"timestamp"` example (useful for audit trails):

```json
{ "include": ["timestamp"] }
```

## Edge cases

**Record quarantined before `output:provenance` fires (e.g. malformed JSON):** The record never reaches the task; no provenance quad is emitted.

**Record quarantined by `classify:conflict` or `classify:conflict` (unknown class):** The record does reach `output:provenance` with `state.classification === null`. A `prov:Activity` quad is still emitted (the record was processed), but `prov:wasGeneratedBy`, `prov:value`, and `prov:reason` are suppressed because they require a non-null classification. Only `prov:atTime` (and the type quad) are written.

**`graph` suffix vs full IRI:** If your target's instances base is `https://2e.aonprd.com/` and you configure `"graph": "meta/provenance"`, the provenance graph IRI is `https://2e.aonprd.com/meta/provenance`. Use a full `https://...` IRI to override the base entirely.

**Determinism:** The run-start timestamp is frozen at context construction time, not captured per-record. Two replays of the same input produce identical provenance graphs (modulo TriG serialisation order, which canonicalisation handles).

## SPARQL example

Find all records classified by SchemaClassifier with confidence below 0.7:

```sparql
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>

SELECT ?record ?engine ?confidence
FROM NAMED <https://squashage.dev/instance/aonprd/provenance>
WHERE {
  GRAPH <https://squashage.dev/instance/aonprd/provenance> {
    ?record a prov:Activity ;
            prov:wasGeneratedBy ?engineNode ;
            prov:value ?confidence .
    FILTER (xsd:decimal(?confidence) < 0.7)
    BIND(STRAFTER(STR(?engineNode), "classifier/") AS ?engine)
    FILTER CONTAINS(?engine, "Schema")
  }
}
```

Find all records classified in a given run (by timestamp):

```sparql
PREFIX prov: <http://www.w3.org/ns/prov#>

SELECT ?record ?reason
FROM NAMED <https://squashage.dev/instance/aonprd/provenance>
WHERE {
  GRAPH <https://squashage.dev/instance/aonprd/provenance> {
    ?record a prov:Activity ;
            prov:atTime "2026-05-06T00:00:00.000Z"^^prov:dateTime ;
            prov:reason ?reason .
  }
}
```
