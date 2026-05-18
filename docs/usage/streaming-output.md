---
layout: doc
title: Streaming Output
description: Squashage streaming output mode — encoding stream eliminates in-memory quad accumulation. File handle opened once; each quad serialised immediately, supporting datasets of millions of triples.
---

# Streaming Output

The default output mode (`encoding: atomic`) loads all quads into an in-memory dataset, runs optional post-processing (RDFC-1.0 canonicalization, SHACL validation), then writes the output file in a single atomic operation. For small and medium datasets this is fine. For very large datasets it is not: 486,000 Veekun learnsets times 4 quads per record is 1.9 million quads in RAM before a single byte hits disk.

`encoding: stream` eliminates that ceiling. The orchestrator opens a file handle once before per-record dispatch, and each time a plugin calls `dataset.add(quad)`, the quad is serialized immediately to the file and counted. No RAM accumulation. The file grows as records are processed.

---

## Plugin contract

`rdfjs:stream` is a built-in pipeline task registered alongside `rdfjs:finalize`. The orchestrator selects it when `output.encoding === 'stream'`. It opens a streaming file handle during `onRunStart`, wraps `ctx.dataset` with a write-through proxy during per-record dispatch, then finalizes the stream during `onRunEnd`.

See [Context silo](../context-silo) for the full lifecycle phase protocol.

## Problem framing

486K learnsets x 4 quads = ~2M quads stored in one `DatasetCore` before `rdfjs:finalize` runs. At ~400 bytes per quad (IRI overhead included), that is ~800MB of RDF in process memory before a single byte is written to disk. With concurrent workers, the actual peak is higher. The process OOMs.

`encoding: stream` rewires the pipeline so the quad serializer sits on the `dataset.add` call path. Quads flow: plugin emits quad, proxy intercepts, line is serialized to file. No accumulation.

---

## When to use streaming vs atomic

| Situation | Recommended encoding |
|-----------|----------------------|
| Dataset fits comfortably in RAM | `atomic` (default) |
| Canonicalization or SHACL validation required | `atomic` (these need the full graph) |
| JSON-LD output required | `atomic` (compaction needs the full graph) |
| Dataset is very large (Veekun-scale, 100K+ records) | `stream` |
| Downstream consumer reads N-Quads or N-Triples line-by-line | `stream` |
| Provenance or ontology:emit tasks are in the pipeline | `atomic` (these scan the dataset at the end) |

---

## Format compatibility matrix

| Format | Streaming compatible | Notes |
|--------|---------------------|-------|
| `ntriples` | Yes | One `<s> <p> <o> .` line per quad |
| `nquads` | Yes | One `<s> <p> <o> <g> .` line per quad |
| `turtle` | Yes | `@prefix` block written at open; one triple per line |
| `trig` | Yes | `@prefix` block written at open; one quad per line |
| `jsonld` | **No** | JSON-LD compaction requires the full expanded graph at once |

Config validation rejects `encoding: stream` combined with `format: jsonld` or `canonicalize: true` at load time.

---

## Configuration

```json
{
  "targets": {
    "veekun": {
      "input": "./data/veekun",
      "pipeline": ["json:read", "squash:veekun", "rdfjs:stream"],
      "output": {
        "kind":         "file",
        "path":         "./graphs/veekun.nq",
        "format":       "nquads",
        "encoding":     "stream"
      }
    }
  }
}
```

The only change from the default config is `"encoding": "stream"`. The orchestrator selects `rdfjs:stream` instead of `rdfjs:finalize` as the end-of-run task.

### dropInMemory

By default, quads are written to the stream AND retained in the in-memory `DatasetCore`. Downstream tasks that scan the dataset (provenance, ontology:emit) continue to work.

When the in-memory dataset is not needed, set `dropInMemory: true`. Quads flow to the file only; the `DatasetCore` stays empty. RSS growth is bounded by the orchestrator overhead, not the quad count.

```json
"output": {
  "kind":         "file",
  "path":         "./graphs/veekun.nq",
  "format":       "nquads",
  "encoding":     "stream",
  "dropInMemory": true
}
```

**Warning**: with `dropInMemory: true`, any task that reads from `ctx.dataset` after the per-record phase (provenance, ontology:emit) will see an empty store. Remove those tasks from the pipeline or keep `dropInMemory: false`.

---

## State machine

```
orchestrator starts
       |
       v
openStreamingOutput(ctx)
  - opens file handle
  - writes @prefix header (turtle/trig only)
  - wraps ctx.dataset with write-through proxy
       |
       v
per-record dispatch (ConcurrentPipeline)
  for each record:
    json:read  -->  plugin: dataset.add(quad)
                        |
                        +-- proxy.add(quad) triggered
                        |     |
                        |     +-- writer.enqueueQuad(quad) -> line appended to file
                        |     |
                        |     +-- [if !dropInMemory] inner.add(quad) -> in-memory store
                        |
                        next()
       |
       v
rdfjs:stream task (synthetic finalize state)
  - awaits all pending writes
  - writer.close() -> stream end + flush
  - writes output.report.json
```

---

## Edge cases

**`encoding: stream` + `canonicalize: true`**: rejected at config load with an error. RDFC-1.0 canonicalization needs the full graph to assign stable blank-node labels. There is no way to canonicalize quads that have not yet arrived.

**`encoding: stream` + `format: jsonld`**: rejected at config load with an error. JSON-LD compaction (`jsonld.compact`) needs the full expanded graph to apply the context. Use N-Quads streaming output and compact externally if needed.

**`encoding: stream` + `dropInMemory: true` + `output:provenance` in pipeline**: allowed (not a config error), but a `logger.warn` is emitted. The provenance task reads `ctx.dataset` at end-of-run to emit PROV-O quads; with `dropInMemory: true` it sees an empty store and emits nothing. Remove `output:provenance` from the pipeline or use `dropInMemory: false`.

**Concurrent writes**: the write-through proxy enqueues writes on a serial promise chain (`#pendingWrites`). With concurrency > 1, multiple records may call `dataset.add` concurrently, but each write is appended serially via the chain. Quad order in the file reflects arrival order, not record order. N-Quads is unordered by spec so this is correct.

---

## Worked example: large NDJSON input + streaming N-Quads output

```json
{
  "input": {
    "basePath": "./data/veekun",
    "format":   "jsonl"
  },
  "targets": {
    "veekun-learnsets": {
      "input":    "./data/veekun/learnsets.jsonl",
      "pipeline": ["json:read", "squash:learnset", "rdfjs:stream"],
      "graphs": {
        "learnsets": "https://pokedex.example.org/graph/learnsets"
      },
      "output": {
        "kind":         "file",
        "path":         "./graphs/veekun-learnsets.nq",
        "format":       "nquads",
        "encoding":     "stream",
        "dropInMemory": true
      }
    }
  }
}
```

With 486,000 JSONL records and 4 quads per record:

- Atomic mode: ~800MB of quads in RAM before write.
- Stream mode: quads written as they arrive; RSS dominated by orchestrator overhead (~20KB per state), not quad accumulation.

The output file grows incrementally during the run. If the process is interrupted, the partial file is left in place (no `.tmp` rename dance because there is no atomic write). Restart from the beginning to produce a complete file.
