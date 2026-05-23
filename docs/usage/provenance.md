---
layout: doc
title: Provenance (PROV-O graph)
description: ProvObserver writes one prov:Activity per node execution into a dedicated PROV-O named graph; rdfjs-finalize emits it to a sibling file alongside the success graph.
---

# Provenance (PROV-O graph)

Every Squashage run emits PROV-O activity quads describing what happened: the run itself, every per-node execution, every termination outcome. The graph lands in its own named graph (`urn:squashage:prov:<runStartTime>`) and `rdfjs-finalize` serializes it to a sibling file next to the success graph.

This is detached observation: `SquashageDagonizer` forwards its five lifecycle hooks to a swappable `ProvObserver` instance. Tests can substitute `NullObserver`; consumers who want to push events somewhere else (OpenTelemetry, an event bus, an analytics sink) implement `ProvObserverInterface` and inject their own.

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

## Per-record output-provenance (legacy hook)

A separate `output-provenance` node also runs inside the per-record DAG (between `squash` and end). It writes per-record `prov:Activity` quads scoped to each record's subject, controlled by `targets[].output.provenance`:

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

## Custom observers

Implement `ProvObserverInterface` and pass it to `SquashageRun.forTarget({ observer })`:

```ts
import type { ProvObserverInterface } from '@studnicky/squashage/observer/ProvObserverInterface';

class StdoutObserver implements ProvObserverInterface {
  recordFlowStart(dag) { process.stdout.write(`flow-start ${dag}\n`); }
  recordFlowEnd(dag, kind) { process.stdout.write(`flow-end ${dag} ${kind}\n`); }
  recordNodeStart(name) { process.stdout.write(`> ${name}\n`); }
  recordNodeEnd(name, output) { process.stdout.write(`< ${name} → ${output}\n`); }
  recordError(name, err) { process.stderr.write(`! ${name}: ${err.message}\n`); }
}

await SquashageRun.forTarget({ ...opts, observer: new StdoutObserver() });
```

The dispatcher invokes the observer exactly once per lifecycle event. Observers should not throw — they're behind a try/catch, but throws are recorded into state and may flip the run to `failed`.

## See also

- [DAG](./pipeline) — how nodes flow through the dispatcher.
- [Output](./output) — how `rdfjs-finalize` splits the success + PROV graphs.
