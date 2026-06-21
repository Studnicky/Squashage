import { NodeStateBase } from '@studnicky/dagonizer';
import type { JsonObjectType, JsonValueType } from '@studnicky/dagonizer/entities';

import type { RecordLocator } from './schemas/RecordLocator.js';
import type { RecordSummary } from './schemas/RecordSummary.js';
import type { DraftLocator } from './schemas/DraftLocator.js';
import type { InducedSchemaSetInterface } from '../induction/SchemaInducer.js';

/**
 * Bootstrap state flowing through the `squashage:bootstrap` DAG.
 *
 * Holds the parent orchestration fields plus every field required by
 * child deep-DAGs (`squashage:induce`, `squashage:refine`, `squashage:run`).
 * Because dagonizer clones the parent state for each deep-DAG child, the child
 * nodes receive a bootstrap-state clone with all necessary fields already
 * present; child nodes access their own fields without knowing the parent type.
 *
 * Result summaries are populated via `stateMapping.output` when each deep-DAG
 * completes:
 *   `induceResult`  — lifted from the induce child state
 *   `refineResult`  — lifted from the refine child state
 *   `buildResult`   — omitted (SquashageRunState has no summary field to lift)
 *
 * V8 monomorphism: property writes occur in the same fixed order in every
 * constructor. Do not introduce conditional spreads.
 */
export class SquashageBootstrapState extends NodeStateBase {
  /** Target identifier (frozen at construction). */
  target: string;

  /** ISO timestamp frozen at construction; matches the dispatcher run id. */
  runStartTime: string;

  // ── Induce-phase result summary ──────────────────────────────────────────

  /** Populated via stateMapping.output after the induce deep-DAG completes. */
  induceResult: { discoveredClasses: string[]; draftsWritten: number } | null;

  // ── Refine-phase result summary ──────────────────────────────────────────

  /** Populated via stateMapping.output after the refine deep-DAG completes. */
  refineResult: { refinedCount: number; passthroughCount: number } | null;

  // ── Build-phase result summary ───────────────────────────────────────────

  /**
   * Always null — SquashageRunState does not expose a compact summary field
   * suitable for lifting. The build phase is confirmed complete by lifecycle.
   */
  buildResult: { recordCount: number; successQuads: number; ontologyQuads: number } | null;

  // ── Fields required by squashage:induce child DAG nodes ──────────────────

  /** Walk-input output; consumed by the induce fan-out. */
  locators: RecordLocator[];

  /** Total records observed across the fan-out (induce path). */
  observedRecords: number;

  /** Discovered class names populated by merge-shape-cache. */
  discoveredClasses: string[];

  /** Induced schema set from induce-schemas (classes + extracted primitives + objects). */
  inducedSchemas: InducedSchemaSetInterface | null;

  /** Number of draft files written by write-drafts. */
  draftsWritten: number;

  // ── Fields required by squashage:refine child DAG nodes ──────────────────

  /** Draft locators produced by walk-drafts; consumed by process-all-drafts. */
  drafts: DraftLocator[];

  /** Number of drafts that matched a refinement file. */
  refinedCount: number;

  /** Number of drafts written as-is (no refinement file found). */
  passthroughCount: number;

  /** Error messages from the refine fan-out (string form for display). */
  runErrors: string[];

  // ── Fields required by squashage:run child DAG nodes ─────────────────────

  /** Record results from the build phase. Populated post-hoc in executeBootstrap from services.recordSummaries. */
  results: RecordSummary[];

  /**
   * Throwaway fan-in accumulator. The `append` fan-in strategy writes
   * dispatched items here during any fan-out; real data flows through services.
   */
  _dispatchedItems: unknown[];

  constructor(target: string, runStartTime: string) {
    super();
    this.target           = target;
    this.runStartTime     = runStartTime;
    this.induceResult     = null;
    this.refineResult     = null;
    this.buildResult      = null;
    this.locators         = [];
    this.observedRecords  = 0;
    this.discoveredClasses = [];
    this.inducedSchemas   = null;
    this.draftsWritten    = 0;
    this.drafts           = [];
    this.refinedCount     = 0;
    this.passthroughCount = 0;
    this.runErrors        = [];
    this.results          = [];
    this._dispatchedItems = [];
  }

  override clone() {
    const base = super.clone() as this;
    base.target            = this.target;
    base.runStartTime      = this.runStartTime;
    base.induceResult      = this.induceResult === null ? null : { ...this.induceResult };
    base.refineResult      = this.refineResult === null ? null : { ...this.refineResult };
    base.buildResult       = this.buildResult  === null ? null : { ...this.buildResult };
    base.locators          = [...this.locators];
    base.observedRecords   = this.observedRecords;
    base.discoveredClasses = [...this.discoveredClasses];
    base.inducedSchemas    = this.inducedSchemas;
    base.draftsWritten     = this.draftsWritten;
    base.drafts            = [...this.drafts];
    base.refinedCount      = this.refinedCount;
    base.passthroughCount  = this.passthroughCount;
    base.runErrors         = [...this.runErrors];
    base.results           = [...this.results];
    base._dispatchedItems  = [...this._dispatchedItems];
    return base;
  }

  protected override snapshotData(): JsonObjectType {
    return {
      target:            this.target,
      runStartTime:      this.runStartTime,
      induceResult:      this.induceResult      as unknown as JsonValueType,
      refineResult:      this.refineResult      as unknown as JsonValueType,
      buildResult:       this.buildResult       as unknown as JsonValueType,
      locators:          this.locators          as unknown as JsonValueType,
      observedRecords:   this.observedRecords,
      discoveredClasses: this.discoveredClasses as unknown as JsonValueType,
      inducedSchemas:    this.inducedSchemas    as unknown as JsonValueType,
      draftsWritten:     this.draftsWritten,
      drafts:            this.drafts            as unknown as JsonValueType,
      refinedCount:      this.refinedCount,
      passthroughCount:  this.passthroughCount,
      runErrors:         this.runErrors         as unknown as JsonValueType,
      results:           this.results           as unknown as JsonValueType,
      _dispatchedItems:  this._dispatchedItems  as unknown as JsonValueType,
    };
  }

  protected override restoreData(snap: JsonObjectType): void {
    const target = snap['target'];
    if (typeof target === 'string') this.target = target;

    const runStartTime = snap['runStartTime'];
    if (typeof runStartTime === 'string') this.runStartTime = runStartTime;

    const induceResult = snap['induceResult'];
    if (induceResult !== null && typeof induceResult === 'object' && !Array.isArray(induceResult)) {
      this.induceResult = induceResult as { discoveredClasses: string[]; draftsWritten: number };
    } else {
      this.induceResult = null;
    }

    const refineResult = snap['refineResult'];
    if (refineResult !== null && typeof refineResult === 'object' && !Array.isArray(refineResult)) {
      this.refineResult = refineResult as { refinedCount: number; passthroughCount: number };
    } else {
      this.refineResult = null;
    }

    const buildResult = snap['buildResult'];
    if (buildResult !== null && typeof buildResult === 'object' && !Array.isArray(buildResult)) {
      this.buildResult = buildResult as { recordCount: number; successQuads: number; ontologyQuads: number };
    } else {
      this.buildResult = null;
    }

    const locators = snap['locators'];
    if (Array.isArray(locators)) this.locators = locators as unknown as RecordLocator[];

    const observedRecords = snap['observedRecords'];
    if (typeof observedRecords === 'number') this.observedRecords = observedRecords;

    const discoveredClasses = snap['discoveredClasses'];
    if (Array.isArray(discoveredClasses)) this.discoveredClasses = discoveredClasses as string[];

    const inducedSchemas = snap['inducedSchemas'];
    if (inducedSchemas !== null && typeof inducedSchemas === 'object' && !Array.isArray(inducedSchemas)) {
      this.inducedSchemas = inducedSchemas as unknown as InducedSchemaSetInterface;
    } else {
      this.inducedSchemas = null;
    }

    const draftsWritten = snap['draftsWritten'];
    if (typeof draftsWritten === 'number') this.draftsWritten = draftsWritten;

    const drafts = snap['drafts'];
    if (Array.isArray(drafts)) this.drafts = drafts as unknown as DraftLocator[];

    const refinedCount = snap['refinedCount'];
    if (typeof refinedCount === 'number') this.refinedCount = refinedCount;

    const passthroughCount = snap['passthroughCount'];
    if (typeof passthroughCount === 'number') this.passthroughCount = passthroughCount;

    const runErrors = snap['runErrors'];
    if (Array.isArray(runErrors)) this.runErrors = runErrors as string[];

    const results = snap['results'];
    if (Array.isArray(results)) this.results = results as unknown as RecordSummary[];

    const dispatched = snap['_dispatchedItems'];
    if (Array.isArray(dispatched)) this._dispatchedItems = dispatched as unknown[];
  }
}
