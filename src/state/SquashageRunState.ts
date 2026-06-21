import { NodeStateBase } from '@studnicky/dagonizer';
import type { JsonObjectType, JsonValueType } from '@studnicky/dagonizer/entities';

import type { RecordLocator } from './schemas/RecordLocator.js';

/**
 * Run-wide state flowing through the run-scope DAG (`squashage:run`).
 *
 * Produced by `walk-input` into `locators`; the fan-out fan-in appends
 * throwaway items into `_dispatchedItems` (never read — the real per-record
 * data flows through `SquashageServices.recordSummaries`).
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

  constructor(target: string, runStartTime: string) {
    super();
    this.locators         = [];
    this._dispatchedItems = [];
    this.target           = target;
    this.runStartTime     = runStartTime;
  }

  override clone() {
    const base = super.clone() as this;
    base.locators         = [...this.locators];
    base._dispatchedItems = [...this._dispatchedItems];
    base.target           = this.target;
    base.runStartTime     = this.runStartTime;
    return base;
  }

  protected override snapshotData(): JsonObjectType {
    return {
      locators:         this.locators         as unknown as JsonValueType,
      _dispatchedItems: this._dispatchedItems as unknown as JsonValueType,
      target:           this.target,
      runStartTime:     this.runStartTime,
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
  }
}
