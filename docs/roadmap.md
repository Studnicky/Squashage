---
layout: doc
title: Roadmap
description: Squashage shipped features and planned work for the post-dagonizer release line.
---

# Roadmap

Squashage runs on the native `@studnicky/dagonizer@0.25` engine. A config file is one run: `SquashageRun.forRun(config)` materialises it from authored `src/dag/*.dag.jsonld` documents bound through `dispatcher.registerBundle`. Per-record processing fans out through the native `scatter { dag }` placement and gathers through the native fold (`squashage:record-fold`).

## Shipped

| Feature | Status |
|---|---|
| Single-run DAGs from authored `.dag.jsonld` documents | live (`SquashageRun.forRun`, `DAGDocument.load`) |
| Native `scatter { dag }` per-record fan-out | live |
| Classifier cascade (9 parallel + 2 sequential) | live |
| Conflict resolver (`pickPriority` / `quarantine`) | live |
| Lenient json-tology ABox projection (Generic fallback for unmapped classes) | live (`@studnicky/json-tology@0.26`) |
| Bounded-memory streaming (native fold gather + stream-to-disk) | live (`squashage:record-fold`, `output.mode: 'stream'`) |
| PROV-O activity graph (sibling file per run) | live (`ProvObserver`) |
| Quarantine path (terminal node in the per-record DAG) | live |
| Memory checkpoint / resume | live (`MemoryCheckpointStore`) |
| Async-iterable execution | live (consume `run.execute()` as `AsyncIterable<NodeResult>`) |
| TriG / Turtle / N-Triples / N-Quads / JSON-LD output | live |
| Plugin slot: per-run squash node | live |
| Structured logging (component + operation per line) | live |
| cosmos.gl streaming graph viewer | live (`squashage-dag viz`) |

## Planned

| Feature | Details |
|---|---|
| File-backed `CheckpointStore` | Production-grade resume that survives a process restart. The framework ships `MemoryCheckpointStore`. |
| Contract-derived DAG (FlowDeriver) | Use dagonizer's `FlowDeriver.derive(contracts)` so new classifiers slot in via an `OperationContract` instead of a registration call. |
| HTML output for the failed-records dump | `quarantine/<bucket>/` files are JSON. A self-contained `failed.html` per run would let users grok dropped records without an editor. |
| OpenTelemetry observer | A `ProvObserverInterface` implementation that emits spans alongside (or instead of) PROV-O quads. |

## See also

- [Architecture](./architecture)
- [DAG](./usage/pipeline)
