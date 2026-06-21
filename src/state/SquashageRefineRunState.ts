import { NodeStateBase } from '@studnicky/dagonizer';
import type { JsonObjectType, JsonValueType } from '@studnicky/dagonizer/entities';

import type { DraftLocator } from './schemas/DraftLocator.js';

/**
 * Run-wide state flowing through the refine-scope DAG (`squashage:refine`).
 *
 * Produced by `walk-drafts` into `drafts`; fan-in tallies land in
 * `refinedCount`, `passthroughCount`, and `runErrors`.
 *
 * `runErrors` is a separate string accumulator for CLI display. Node-level
 * errors are collected via `collectError()` per the dagonizer contract, which
 * populates the base-class `errors` accessor. The `runErrors` field holds
 * error *messages* that the CLI can display without inspecting
 * `NodeErrorInterface` fields.
 *
 * V8 monomorphism: property writes occur in the same fixed order in every
 * constructor. Do not introduce conditional spreads.
 */
export class SquashageRefineRunState extends NodeStateBase {
  /** Draft locators produced by `walk-drafts`. Consumed by the fan-out. */
  drafts: DraftLocator[];

  /**
   * Throwaway fan-in accumulator. The `append` fan-in strategy writes
   * dispatched locators here; the real tally flows through
   * `SquashageServices.refineSummaries`.
   */
  _dispatchedItems: unknown[];

  /** Number of drafts that had a matching refinement file and were refined. */
  refinedCount: number;

  /** Number of drafts written as-is (no refinement file found). */
  passthroughCount: number;

  /**
   * Error messages accumulated during the fan-out (string form for CLI display).
   * The dagonizer-level `errors` accessor on the base class holds structured
   * `NodeErrorInterface` objects; this field is a parallel string summary.
   */
  runErrors: string[];

  /** Target identifier for this run (frozen at construction). */
  target: string;

  /** ISO timestamp frozen at construction; matches the dispatcher run id. */
  runStartTime: string;

  constructor(target: string, runStartTime: string) {
    super();
    this.drafts           = [];
    this._dispatchedItems = [];
    this.refinedCount     = 0;
    this.passthroughCount = 0;
    this.runErrors        = [];
    this.target           = target;
    this.runStartTime     = runStartTime;
  }

  override clone() {
    const base = super.clone() as this;
    base.drafts           = [...this.drafts];
    base._dispatchedItems = [...this._dispatchedItems];
    base.refinedCount     = this.refinedCount;
    base.passthroughCount = this.passthroughCount;
    base.runErrors        = [...this.runErrors];
    base.target           = this.target;
    base.runStartTime     = this.runStartTime;
    return base;
  }

  protected override snapshotData(): JsonObjectType {
    return {
      drafts:           this.drafts           as unknown as JsonValueType,
      _dispatchedItems: this._dispatchedItems as unknown as JsonValueType,
      refinedCount:     this.refinedCount,
      passthroughCount: this.passthroughCount,
      runErrors:        this.runErrors         as unknown as JsonValueType,
      target:           this.target,
      runStartTime:     this.runStartTime,
    };
  }

  protected override restoreData(snap: JsonObjectType): void {
    const drafts = snap['drafts'];
    if (Array.isArray(drafts)) this.drafts = drafts as unknown as DraftLocator[];

    const dispatched = snap['_dispatchedItems'];
    if (Array.isArray(dispatched)) this._dispatchedItems = dispatched as unknown[];

    const refinedCount = snap['refinedCount'];
    if (typeof refinedCount === 'number') this.refinedCount = refinedCount;

    const passthroughCount = snap['passthroughCount'];
    if (typeof passthroughCount === 'number') this.passthroughCount = passthroughCount;

    const runErrors = snap['runErrors'];
    if (Array.isArray(runErrors)) this.runErrors = runErrors as string[];

    const target = snap['target'];
    if (typeof target === 'string') this.target = target;

    const runStartTime = snap['runStartTime'];
    if (typeof runStartTime === 'string') this.runStartTime = runStartTime;
  }
}
