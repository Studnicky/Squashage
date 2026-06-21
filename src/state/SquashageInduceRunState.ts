import { NodeStateBase } from '@studnicky/dagonizer';
import type { JsonObjectType, JsonValueType } from '@studnicky/dagonizer/entities';

import type { RecordLocator } from './schemas/RecordLocator.js';
import type { InducedSchemaSetInterface } from '../induction/SchemaInducer.js';

/**
 * Run-wide state flowing through the induce-scope DAG (`squashage:induce`).
 *
 * Produced by `walk-input` into `locators`; populated post-fan-out by
 * `merge-shape-cache`, `induce-schemas`, and `write-drafts`.
 *
 * V8 monomorphism: property writes occur in the same fixed order in every
 * constructor. Do not introduce conditional spreads.
 */
export class SquashageInduceRunState extends NodeStateBase {
  /** Record locators produced by `walk-input`. Consumed by the fan-out. */
  locators: RecordLocator[];

  /**
   * Throwaway fan-in accumulator. The `append` fan-in strategy writes
   * dispatched locators here; the real shape data flows through
   * `SquashageServices.shapeCache`.
   */
  _dispatchedItems: unknown[];

  /** Total records observed across the fan-out (sum of recordCount in shapeCache). */
  observedRecords: number;

  /** Discovered class names (sorted); populated by `merge-shape-cache`. */
  discoveredClasses: string[];

  /** Induced schema set from `induce-schemas` (classes + extracted primitives + objects). */
  inducedSchemas: InducedSchemaSetInterface | null;

  /** Number of draft files written by `write-drafts`. */
  draftsWritten: number;

  /** Target identifier for this run (frozen at construction). */
  target: string;

  /** ISO timestamp frozen at construction; matches the dispatcher run id. */
  runStartTime: string;

  constructor(target: string, runStartTime: string) {
    super();
    this.locators         = [];
    this._dispatchedItems = [];
    this.observedRecords  = 0;
    this.discoveredClasses = [];
    this.inducedSchemas  = null;
    this.draftsWritten   = 0;
    this.target          = target;
    this.runStartTime    = runStartTime;
  }

  override clone() {
    const base = super.clone() as this;
    base.locators          = [...this.locators];
    base._dispatchedItems  = [...this._dispatchedItems];
    base.observedRecords   = this.observedRecords;
    base.discoveredClasses = [...this.discoveredClasses];
    base.inducedSchemas    = this.inducedSchemas;
    base.draftsWritten     = this.draftsWritten;
    base.target            = this.target;
    base.runStartTime      = this.runStartTime;
    return base;
  }

  protected override snapshotData(): JsonObjectType {
    return {
      locators:          this.locators          as unknown as JsonValueType,
      _dispatchedItems:  this._dispatchedItems  as unknown as JsonValueType,
      observedRecords:   this.observedRecords,
      discoveredClasses: this.discoveredClasses as unknown as JsonValueType,
      inducedSchemas:    this.inducedSchemas    as unknown as JsonValueType,
      draftsWritten:     this.draftsWritten,
      target:            this.target,
      runStartTime:      this.runStartTime,
    };
  }

  protected override restoreData(snap: JsonObjectType): void {
    const locators = snap['locators'];
    if (Array.isArray(locators)) this.locators = locators as unknown as RecordLocator[];

    const dispatched = snap['_dispatchedItems'];
    if (Array.isArray(dispatched)) this._dispatchedItems = dispatched as unknown[];

    const observedRecords = snap['observedRecords'];
    if (typeof observedRecords === 'number') this.observedRecords = observedRecords;

    const discoveredClasses = snap['discoveredClasses'];
    if (Array.isArray(discoveredClasses)) this.discoveredClasses = discoveredClasses as string[];

    const inducedSchemas = snap['inducedSchemas'];
    if (inducedSchemas !== null && typeof inducedSchemas === 'object' && !Array.isArray(inducedSchemas)) {
      this.inducedSchemas = inducedSchemas as unknown as InducedSchemaSetInterface;
    }

    const draftsWritten = snap['draftsWritten'];
    if (typeof draftsWritten === 'number') this.draftsWritten = draftsWritten;

    const target = snap['target'];
    if (typeof target === 'string') this.target = target;

    const runStartTime = snap['runStartTime'];
    if (typeof runStartTime === 'string') this.runStartTime = runStartTime;
  }
}
