# Native streaming migration — eliminate the services-sink/accumulation hacks

Goal: project the full corpus at **default Node heap** (bounded RSS), by replacing
squashage's bespoke accumulation with dagonizer's native streaming scatter/gather,
mirroring `~/Workspace/Dagonizer/examples/the-cartographer` (`InsightsFoldGather`,
`streaming-bounded.smoke.ts`, `ObservedCartographer`) and cartographus's
stream-to-disk writer.

## Principle
Per-record data must be either (a) **streamed to disk** (the RDF output — O(1) memory,
O(N) disk) or (b) **folded into bounded state** (counts/samples/rollups — O(1) memory).
Nothing per-record may accumulate unbounded in memory.

## Hacks → native replacements

| Hack (eliminate) | Native replacement |
|---|---|
| `services.recordSummaries` (unbounded array of 13,653) + `gather: { strategy: 'discard' }` + `record-summary-collect` node | a custom **compactable** `GatherStrategy` (`retainsRecordsForFinalize=false`) that folds each clone's `RecordSummary` into **bounded** `SquashageRunState` fields (outcome counts, per-class counts, capped sample ring, error rollup) — the `InsightsFoldGather` pattern |
| `services.dataset` accumulating all ABox quads (squashNode/ontologyProjection dual-write) | ABox quads stream to the per-record disk writer only; `services.dataset` holds only bounded TBox/SHACL |
| `ProvObserver` `#dataset.add(...)` per node×record | PROV streams to a sidecar disk writer (open up front, close at finalize); observer never accumulates in memory |
| `walkInput` materializing all locators into `state.locators` (array) | streaming `AsyncIterable` source (`state.useStreamingSource`); the scatter consumes items as a stream |
| `SquashageRun.execute()` awaits (drains) | consume via `for await (const stage of execution)` (drives streaming) |

## Waves (sprout-then-swap; gate each on `npm run check`; final gate = full corpus at DEFAULT heap)

1. **Fold gather + bounded state (sprout).** New `core/RecordFoldGather.ts` (`extends GatherStrategy`, name `squashage:record-fold`, `retainsRecordsForFinalize=false`); `initial` seeds bounded accumulators, `reduce` folds each clone's `RecordSummary` (outcome/class counts, capped sample, error rollup) into `SquashageRunState`. Register via `GatherStrategies.register`. Add the bounded fields to `SquashageRunState`. Tests. Do NOT swap the scatter yet.
2. **Streaming source (sprout).** `walkInput` yields locators as an `AsyncIterable`; add `state.useStreamingSource`. Scatter reads the streaming source.
3. **Observer streaming (sprout).** `ProvObserver` streams PROV quads to a sidecar writer (`services.openProvWriter`, mirror `openRecordWriter`); `rdfjs-finalize` closes it; no `#dataset.add` accumulation.
4. **ABox dataset elimination (sprout).** `squashNode`/`ontologyProjection` write ABox only to the streaming record writer; drop the `services.dataset` dual-write; `rdfjs-finalize` reads only bounded TBox/SHACL from `dataset`.
5. **Swap orchestrator.** Run scatter `gather: { strategy: 'squashage:record-fold' }`; delete `recordSummaryCollectNode` + `services.recordSummaries`; CLI reads folded counts from state; streaming source + streaming output are the run default. Regenerate authored DAGs.
6. **Validate.** Full corpus at DEFAULT heap (no `--max-old-space-size`): bounded peak RSS (well under 4 GB), `lifecycle: completed`, identical output (~6M ABox quads + PROV sidecar), quarantine 5. Mirror `streaming-bounded.smoke.ts` with a small/large RSS-ratio assertion.

## Reference files (read before each wave)
- `~/Workspace/Dagonizer/examples/the-cartographer/core/InsightsFoldGather.ts` — compactable fold gather.
- `~/Workspace/Dagonizer/examples/the-cartographer/__smoke__/streaming-bounded.smoke.ts` — bounded-heap proof + assertion style.
- `~/Workspace/Dagonizer/examples/the-cartographer/dag.ts` — `.scatter(..., gather:{strategy})` over an `AsyncIterable` source.
- `~/Workspace/Dagonizer/examples/the-cartographer/ObservedCartographer.ts` — observer that logs, never accumulates.
- cartographus `ShardStreamWriter` (`~/Workspace/noocodec/packages/cartographus/src/store/ShardStreamWriter.ts`) — stream-to-disk writer pattern (the analog for ABox + PROV writers).
