---
layout: doc
title: Roadmap
description: Squashage shipped features and planned work for the post-dagonizer release line.
---

# Roadmap

Squashage runs on `@noocodex/dagonizer`. The legacy `Pipeline` + `TaskRegistry` + `SquashageOrchestrator` machinery is gone; all execution flows through a single `SquashageDagonizer` instance per target with two registered DAGs.

## Shipped

| Feature | Status |
|---|---|
| Run-scope + per-record DAGs | live (`SquashageRun.forTarget`) |
| Eight parallel classifier nodes + two sequential | live |
| Conflict resolver (`pickPriority` / `quarantine`) | live |
| PROV-O activity graph (sibling file per run) | live (`ProvObserver`) |
| Quarantine path (terminal node in the per-record DAG) | live |
| Memory checkpoint / resume | live (`@noocodex/dagonizer/checkpoint` + `MemoryCheckpointStore`) |
| Async-iterable execution | live (consume `run.execute()` as `AsyncIterable<NodeResult>`) |
| TriG / Turtle / N-Triples / N-Quads / JSON-LD output | live |
| Plugin slot: per-target squash node | live |
| Structured logging (component + operation per line) | live |
| Optional json-tology ontology engine | live (`services.ontology`) |

## Planned

| Feature | Details |
|---|---|
| File-backed `CheckpointStore` | Production-grade resume that survives a process restart. Today the framework only ships `MemoryCheckpointStore`. |
| Native streaming output | `rdfjs-finalize` collects the full dataset in memory before writing. A streaming writer (one quad at a time, fed by the async-iterator over `run.execute()`) would unbound the memory profile for very large runs. |
| Direct port of `ShaclShapeClassifier` | Today the new `ShaclShapeClassifierNode` delegates to a trimmed legacy class. Replace with a clean port that uses `services.factory` / `services.dataset` directly. |
| Contract-derived DAG (FlowDeriver) | Use dagonizer's `FlowDeriver.derive(contracts)` so new classifiers slot in via an `OperationContract` instead of a registration call. |
| HTML output for the failed-records dump | `quarantine/<bucket>/` files are JSON today. A self-contained `failed.html` per run would let users grok dropped records without an editor. |
| OpenTelemetry observer | A `ProvObserverInterface` implementation that emits spans alongside (or instead of) PROV-O quads. |

## See also

- [Architecture](./architecture)
- [DAG](./usage/pipeline)
