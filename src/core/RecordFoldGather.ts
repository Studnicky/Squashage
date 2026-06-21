/**
 * RecordFoldGather: incremental, bounded gather strategy for the squashage
 * run-scope scatter.
 *
 * Folds each scatter clone's `SquashageRecordState` into BOUNDED accumulators
 * as clones arrive, rather than collecting an unbounded per-record array and
 * processing at finalize.
 *
 *   (a) Outcome counts      — exact `squashedCount`, `quarantinedCount`, `errorCount`.
 *   (b) Per-class counts    — exact `Map<className, count>` (bounded to distinct class names).
 *   (c) Sample ring         — CAPPED FIFO of `RecordSummary` (cap: MAX_SAMPLE_SUMMARIES).
 *   (d) Error rollup        — bounded count + capped sample of distinct messages.
 *
 * Memory stays O(1) with respect to record count. The strategy mirrors all
 * accumulator state into the parent `SquashageRunState` via
 * `accessor.set(...)` after every mutation, so the checkpoint carries the
 * bounded result without retaining per-clone records.
 *
 * Registered as 'squashage:record-fold' at module load. The strategy is a
 * singleton; `initial()` resets all accumulators per execution. Sequential
 * squashage runs are safe because executions run one at a time.
 */

import { GatherStrategies, GatherStrategy } from '@studnicky/dagonizer/core';
import type { GatherConfigType } from '@studnicky/dagonizer/types';
import type { NodeStateInterface } from '@studnicky/dagonizer';
import type { GatherRecordType, StateAccessorInterface } from '@studnicky/dagonizer/contracts';

import type { SquashageRecordState } from '../state/SquashageRecordState.js';
import type { RecordSummary } from '../state/schemas/RecordSummary.js';
import type { RecordErrorRollupType } from '../state/SquashageRunState.js';

// ── Module constants ───────────────────────────────────────────────────────────

const MAX_SAMPLE_SUMMARIES = 200;
const MAX_ERROR_MESSAGES   = 50;

// ── Internal mutable accumulator ──────────────────────────────────────────────

/** Mutable internal accumulator reset by `initial()` on each execution. */
interface FoldAccumulator {
  squashedCount:    number;
  quarantinedCount: number;
  errorCount:       number;
  perClassCounts:   Map<string, number>;
  sampleRing:       RecordSummary[];
  errorRecordCount: number;
  errorMessages:    string[];
  totalQuadCount:   number;
}

// ── RecordFoldGather ──────────────────────────────────────────────────────────

export class RecordFoldGather extends GatherStrategy {
  override readonly name = 'squashage:record-fold';

  /**
   * false → compactable. The gather result is fully in state after each
   * `reduce` call; the engine keeps only bounded bookkeeping at checkpoint
   * rather than retaining every acked clone record.
   */
  override readonly retainsRecordsForFinalize = false;

  // Per-execution accumulator. Reset by initial() before every scatter.
  // Single-instance accumulation is safe: squashage runs executions
  // sequentially so no two scatter runs overlap on the same strategy instance.
  private acc: FoldAccumulator = RecordFoldGather.emptyAccumulator();

  // ── initial: reset accumulators and parent state targets ─────────────────

  override initial(
    _config: GatherConfigType,
    state: NodeStateInterface,
    accessor: StateAccessorInterface,
  ): void {
    this.acc = RecordFoldGather.emptyAccumulator();

    accessor.set(state, 'squashedCount',    0);
    accessor.set(state, 'quarantinedCount', 0);
    accessor.set(state, 'errorCount',       0);
    accessor.set(state, 'perClassCounts',   new Map<string, number>());
    accessor.set(state, 'sampleSummaries',  [] as RecordSummary[]);
    accessor.set(state, 'errorRollup',      RecordFoldGather.emptyRollup());
    accessor.set(state, 'totalQuadCount',   0);
  }

  // ── reduce: per-clone fold ────────────────────────────────────────────────

  override reduce(
    _config: GatherConfigType,
    batch: Parameters<GatherStrategy['reduce']>[1],
    state: NodeStateInterface,
    accessor: StateAccessorInterface,
  ): void {
    for (const item of batch) {
      const record: GatherRecordType = item.state;
      const cloneState = record.cloneState as SquashageRecordState;

      const summary = RecordFoldGather.buildSummary(cloneState);

      this.foldOutcome(summary);
      this.foldClassName(summary);
      this.foldSampleRing(summary);
      this.foldErrors(cloneState);
      this.acc.totalQuadCount += cloneState.squashedQuads.length;

      RecordFoldGather.mirrorToState(this.acc, state, accessor);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Derive the outcome from clone state, mirroring `recordSummaryCollectNode`. */
  private static buildSummary(cloneState: SquashageRecordState): RecordSummary {
    let outcome: RecordSummary['outcome'];
    if (cloneState.quarantineBucket !== null)    outcome = 'quarantined';
    else if (cloneState.classification !== null) outcome = 'squashed';
    else                                         outcome = 'error';

    return {
      recordPath: cloneState.recordPath,
      recordLine: cloneState.recordLine,
      outcome,
      ...(cloneState.classification !== null
        ? {
            className:  cloneState.classification.type,
            confidence: cloneState.classification.confidence,
          }
        : {}),
      quadCount: cloneState.squashedQuads.length,
      ...(cloneState.quarantineBucket !== null
        ? { quarantineBucket: cloneState.quarantineBucket }
        : {}),
      ...(cloneState.errors[0] !== undefined
        ? { errorMessage: cloneState.errors[0].message }
        : {}),
    };
  }

  /** Increment the outcome counter for this summary. */
  private foldOutcome(summary: RecordSummary): void {
    if (summary.outcome === 'squashed')    this.acc.squashedCount++;
    else if (summary.outcome === 'quarantined') this.acc.quarantinedCount++;
    else                                   this.acc.errorCount++;
  }

  /** Increment the per-class counter when the summary has a className. */
  private foldClassName(summary: RecordSummary): void {
    if (summary.className === undefined) return;
    const existing = this.acc.perClassCounts.get(summary.className) ?? 0;
    this.acc.perClassCounts.set(summary.className, existing + 1);
  }

  /** Push to the FIFO sample ring; evict oldest entry when at cap. */
  private foldSampleRing(summary: RecordSummary): void {
    this.acc.sampleRing.push(summary);
    if (this.acc.sampleRing.length > MAX_SAMPLE_SUMMARIES) {
      this.acc.sampleRing.shift();
    }
  }

  /**
   * Fold errors from the clone state into the bounded error rollup.
   * Counts every record that had at least one error. Captures a capped set
   * of distinct messages so repeated identical errors do not inflate the sample.
   */
  private foldErrors(cloneState: SquashageRecordState): void {
    if (cloneState.errors.length === 0) return;
    this.acc.errorRecordCount++;
    for (const err of cloneState.errors) {
      const msg = err.message;
      if (
        this.acc.errorMessages.length < MAX_ERROR_MESSAGES &&
        !this.acc.errorMessages.includes(msg)
      ) {
        this.acc.errorMessages.push(msg);
      }
    }
  }

  /** Write all accumulator fields into the parent state via the accessor. */
  private static mirrorToState(
    acc: FoldAccumulator,
    state: NodeStateInterface,
    accessor: StateAccessorInterface,
  ): void {
    accessor.set(state, 'squashedCount',    acc.squashedCount);
    accessor.set(state, 'quarantinedCount', acc.quarantinedCount);
    accessor.set(state, 'errorCount',       acc.errorCount);
    accessor.set(state, 'perClassCounts',   acc.perClassCounts);
    accessor.set(state, 'sampleSummaries',  acc.sampleRing);
    accessor.set(state, 'errorRollup',      RecordFoldGather.rollupFromAcc(acc));
    accessor.set(state, 'totalQuadCount',   acc.totalQuadCount);
  }

  private static rollupFromAcc(acc: FoldAccumulator): RecordErrorRollupType {
    return {
      errorRecordCount: acc.errorRecordCount,
      sampleMessages:   [...acc.errorMessages],
    };
  }

  private static emptyAccumulator(): FoldAccumulator {
    return {
      squashedCount:    0,
      quarantinedCount: 0,
      errorCount:       0,
      perClassCounts:   new Map(),
      sampleRing:       [],
      errorRecordCount: 0,
      errorMessages:    [],
      totalQuadCount:   0,
    };
  }

  private static emptyRollup(): RecordErrorRollupType {
    return { errorRecordCount: 0, sampleMessages: [] };
  }
}

// ── Module-load registration ──────────────────────────────────────────────────

GatherStrategies.register(new RecordFoldGather());
// GatherStrategies.resolve('squashage:record-fold') now works in any scatter placement.
