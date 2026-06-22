---
layout: doc
title: Provenance (PROV-O graph)
description: SquashageDagonizer's lifecycle hooks write one prov:Activity per node execution into a dedicated PROV-O named graph; rdfjs-finalize emits it to a sibling file alongside the success graph.
---

# Provenance (PROV-O graph)

Every Squashage run emits PROV-O activity quads describing what happened: the run itself, every per-node execution, every termination outcome. The graph lands in its own named graph (`urn:squashage:prov:<runStartTime>`) and `rdfjs-finalize` serializes it to a sibling file next to the success graph.

PROV-O is written directly from `SquashageDagonizer`'s five lifecycle hook overrides (`onFlowStart`, `onFlowEnd`, `onNodeStart`, `onNodeEnd`, `onError`). Quads land in `services.provSink` in stream mode, or `services.dataset` in dataset mode, using `services.factory` and the `ProvVocabulary` term builder.

## Output files

| File | Contents | Format |
|---|---|---|
| `<output.path>` | success graph | the format from `output.format` |
| `<output.path-stem>.prov.<ext>` | PROV-O activity graph | N-Quads (always) |

The PROV file is separate from the success graph by design: provenance is a debug/audit artifact and shouldn't pollute the application-facing graph.

## What gets emitted

For the run as a whole:

```turtle
<urn:squashage:activity:2026-05-18T00:00:00Z:run:0>
  a prov:Activity, dag:Run ;
  dag:dagName     "squashage:run" ;
  prov:startedAtTime "2026-05-18T00:00:00.000Z"^^xsd:dateTime ;
  prov:endedAtTime   "2026-05-18T00:00:01.234Z"^^xsd:dateTime ;
  dag:lifecycle   "completed" ;
  prov:wasAssociatedWith <urn:squashage:agent:squashage%2Faonprd> .
```

For every per-node execution:

```turtle
<urn:squashage:activity:2026-05-18T00:00:00Z:walk-input:1716000001234>
  a prov:Activity, dag:NodeExecution ;
  dag:nodeName    "walk-input" ;
  prov:startedAtTime "2026-05-18T00:00:00.123Z"^^xsd:dateTime ;
  prov:endedAtTime   "2026-05-18T00:00:00.456Z"^^xsd:dateTime ;
  prov:wasAssociatedWith <urn:squashage:agent:squashage%2Faonprd> ;
  prov:wasInformedBy     <urn:squashage:activity:...:run:0> ;
  dag:output      "walked" .
```

`prov:wasInformedBy` forms a chain across the run: each activity points at the activity it followed (the run activity for the first node, then each prior node activity).

When a node errors, the activity carries `dag:error "<error message>"` and the `prov:endedAtTime` reflects the failure point.

## Per-record output-provenance

A separate `output-provenance` node also runs inside the per-record DAG (between `squash` and end). It writes per-record `prov:Activity` quads scoped to each record's subject, controlled by `output.provenance`:

```json
{
  "output": {
    "provenance": {
      "enabled": true,
      "graph":   "provenance",
      "include": ["classifier", "confidence", "reasons", "timestamp"]
    }
  }
}
```

| Include key | Emits |
|---|---|
| `classifier` | `prov:wasGeneratedBy <classifier:<engine>>` |
| `confidence` | `prov:value "0.95"^^xsd:decimal` |
| `reasons` | `prov:reason "reason1,reason2"` |
| `timestamp` | `prov:atTime "<runStartTime>"^^xsd:dateTime` |

These quads land in `<instancesBase>/provenance` (or the full IRI when `graph` is `http://`/`https://`-prefixed). When the block is absent or `enabled !== true`, the node returns `skipped`.

## PROV sink

The destination follows the output mode. In dataset mode, lifecycle quads accumulate in `services.dataset` and `rdfjs-finalize` splits the PROV named graph out to the sibling `.prov.<ext>` file. In stream mode, the hooks write to `services.provSink`, which streams the PROV quads to disk alongside the success graph so neither buffer grows unbounded.

The hooks fire exactly once per lifecycle event. The flow-end hook records the run's terminal outcome from `state.lifecycle.variant` onto the run activity. Tests suppress PROV emission with `SquashageRun.forTargetWithNullObserver(...)`, which wires a no-op sink.

## See also

- [DAG](./pipeline) — how nodes flow through the dispatcher.
- [Output](./output) — how `rdfjs-finalize` splits the success + PROV graphs.
