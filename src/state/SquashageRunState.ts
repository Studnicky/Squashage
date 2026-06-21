import { NodeStateBase } from '@studnicky/dagonizer';
import type { JsonObjectType, JsonValueType } from '@studnicky/dagonizer/entities';

import type { RecordLocator } from './schemas/RecordLocator.js';
import type { RecordSummary } from './schemas/RecordSummary.js';

/**
 * Bounded error rollup accumulated by `RecordFoldGather`.
 *
 * Tracks distinct error messages (capped at `MAX_ERROR_SAMPLES`) plus an
 * exact total count. Memory stays O(1) regardless of record count.
 */
export type RecordErrorRollupType = {
  /** Exact count of records that carried at least one error. */
  readonly errorRecordCount: number;
  /** Capped sample of distinct error messages (first MAX_ERROR_SAMPLES seen). */
  readonly sampleMessages: readonly string[];
};

/**
 * Run-wide state flowing through the run-scope DAG (`squashage:run`).
 *
 * Produced by `walk-input` into `locators`; the fan-out fan-in appends
 * throwaway items into `_dispatchedItems` (never read — the real per-record
 * data flows through `SquashageServices.recordSummaries`).
 *
 * The bounded fold fields (`squashedCount`, `quarantinedCount`, `errorCount`,
 * `perClassCounts`, `sampleSummaries`, `errorRollup`) are populated
 * incrementally by `RecordFoldGather` as each scatter clone completes. They
 * provide O(1) checkpoint state; callers read them instead of
 * `SquashageServices.recordSummaries` once the gather strategy is wired.
 *
 * V8 monomorphism: property writes occur in the same fixed order in every
 * constructor. Do not introduce conditional spreads.
 */
export class SquashageRunState extends NodeStateBase {
  /** Record locators produced by `walk-input`. Consumed by the fan-out. */
  locators: RecordLocator[];

  /**
   * Throwaway fan-in accumulator. The `append` fan-in strategy writes
   * dispatched locators here; the real summaries live in
   * `SquashageServices.recordSummaries`.
   */
  _dispatchedItems: unknown[];

  /** Target identifier for this run (frozen at construction). */
  target: string;

  /** ISO timestamp frozen at construction; matches the dispatcher run id. */
  runStartTime: string;

  // ── Bounded fold accumulators (written by RecordFoldGather) ───────────────

  /** Exact count of records that completed with outcome 'squashed'. */
  squashedCount: number;

  /** Exact count of records that completed with outcome 'quarantined'. */
  quarantinedCount: number;

  /** Exact count of records that completed with outcome 'error'. */
  errorCount: number;

  /**
   * Exact per-className squash counts.
   * Keys are classifier class names (e.g. 'feat', 'spell'); values are exact counts.
   * Bounded to the number of distinct class names seen; empty until RecordFoldGather runs.
   */
  perClassCounts: Map<string, number>;

  /**
   * Capped FIFO ring of `RecordSummary` objects.
   * At most MAX_SAMPLE_SUMMARIES entries; oldest entries are evicted once the
   * cap is reached. Bounded regardless of run size.
   */
  sampleSummaries: RecordSummary[];

  /**
   * Bounded error rollup: exact count of records with errors plus a capped
   * sample of distinct messages. Populated by RecordFoldGather.
   */
  errorRollup: RecordErrorRollupType;

  /**
   * Exact total quad count accumulated from all squashed record clones.
   * Populated by RecordFoldGather during the scatter gather phase.
   */
  totalQuadCount: number;

  constructor(target: string, runStartTime: string) {
    super();
    this.locators         = [];
    this._dispatchedItems = [];
    this.target           = target;
    this.runStartTime     = runStartTime;
    this.squashedCount    = 0;
    this.quarantinedCount = 0;
    this.errorCount       = 0;
    this.perClassCounts   = new Map();
    this.sampleSummaries  = [];
    this.errorRollup      = { errorRecordCount: 0, sampleMessages: [] };
    this.totalQuadCount   = 0;
  }

  override clone() {
    const base = super.clone() as this;
    base.locators         = [...this.locators];
    base._dispatchedItems = [...this._dispatchedItems];
    base.target           = this.target;
    base.runStartTime     = this.runStartTime;
    base.squashedCount    = this.squashedCount;
    base.quarantinedCount = this.quarantinedCount;
    base.errorCount       = this.errorCount;
    base.perClassCounts   = new Map(this.perClassCounts);
    base.sampleSummaries  = [...this.sampleSummaries];
    base.errorRollup      = {
      errorRecordCount: this.errorRollup.errorRecordCount,
      sampleMessages:   [...this.errorRollup.sampleMessages],
    };
    base.totalQuadCount   = this.totalQuadCount;
    return base;
  }

  protected override snapshotData(): JsonObjectType {
    return {
      locators:         this.locators         as unknown as JsonValueType,
      _dispatchedItems: this._dispatchedItems as unknown as JsonValueType,
      target:           this.target,
      runStartTime:     this.runStartTime,
      squashedCount:    this.squashedCount,
      quarantinedCount: this.quarantinedCount,
      errorCount:       this.errorCount,
      perClassCounts:   Object.fromEntries(this.perClassCounts) as unknown as JsonValueType,
      sampleSummaries:  this.sampleSummaries  as unknown as JsonValueType,
      errorRollup:      this.errorRollup      as unknown as JsonValueType,
      totalQuadCount:   this.totalQuadCount,
    };
  }

  protected override restoreData(snap: JsonObjectType): void {
    const locators = snap['locators'];
    if (Array.isArray(locators)) this.locators = locators as unknown as RecordLocator[];
    const dispatched = snap['_dispatchedItems'];
    if (Array.isArray(dispatched)) this._dispatchedItems = dispatched as unknown[];
    const target = snap['target'];
    if (typeof target === 'string') this.target = target;
    const runStartTime = snap['runStartTime'];
    if (typeof runStartTime === 'string') this.runStartTime = runStartTime;

    const squashed = snap['squashedCount'];
    if (typeof squashed === 'number') this.squashedCount = squashed;
    const quarantined = snap['quarantinedCount'];
    if (typeof quarantined === 'number') this.quarantinedCount = quarantined;
    const errors = snap['errorCount'];
    if (typeof errors === 'number') this.errorCount = errors;

    const perClass = snap['perClassCounts'];
    if (isPlainObject(perClass)) {
      this.perClassCounts = new Map(
        Object.entries(perClass as Record<string, unknown>).flatMap(([k, v]) =>
          typeof v === 'number' ? [[k, v]] : [],
        ),
      );
    }

    const samples = snap['sampleSummaries'];
    if (Array.isArray(samples)) this.sampleSummaries = samples as unknown as RecordSummary[];

    const totalQuadCount = snap['totalQuadCount'];
    if (typeof totalQuadCount === 'number') this.totalQuadCount = totalQuadCount;

    const rollup = snap['errorRollup'];
    if (isPlainObject(rollup)) {
      const rollupObj = rollup as Record<string, unknown>;
      const count = rollupObj['errorRecordCount'];
      const msgs  = rollupObj['sampleMessages'];
      this.errorRollup = {
        errorRecordCount: typeof count === 'number' ? count : 0,
        sampleMessages:   Array.isArray(msgs) ? (msgs as string[]) : [],
      };
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
