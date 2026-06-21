import { NodeStateBase } from '@studnicky/dagonizer';
import type { JsonObjectType, JsonValueType } from '@studnicky/dagonizer/entities';

/**
 * Per-draft state flowing through the refine-one deep-DAG
 * (`squashage:refine-one`).
 *
 * Populated by `read-draft` and `read-refinement`; consumed and mutated by
 * `apply-refinement`; written by `write-final`. The `outcome` field is set
 * by `write-final` or `refinement-missing-warn` to indicate the final result.
 *
 * Node-level errors are collected via `collectError()` per the dagonizer
 * contract, accessible via the base-class `errors` getter.
 *
 * V8 monomorphism: property writes occur in the same fixed order in every
 * constructor. Do not introduce conditional spreads.
 */
export class SquashageRefineState extends NodeStateBase {
  /** Absolute path to the draft schema file. */
  draftPath: string;

  /**
   * Absolute path to the refinement file, or `null` when no refinement
   * exists for this class.
   */
  refinementPath: string | null;

  /** Class name (derived from the draft filename). */
  className: string;

  /**
   * Optional subdirectory relative to the finals root where the final schema
   * should be written. Undefined for top-level class schemas; `'primitives'`
   * or `'objects'` for extracted schemas.
   */
  subdir: string | undefined;

  /** Parsed draft schema; populated by `read-draft`. */
  draftJson: JsonObjectType | null;

  /** Parsed refinement document; populated by `read-refinement`. */
  refinementJson: JsonObjectType | null;

  /** Final schema after applying the refinement; populated by `apply-refinement`. */
  finalJson: JsonObjectType | null;

  /**
   * Outcome of this per-draft execution:
   * - `'refined'`      — a refinement file was applied.
   * - `'passthrough'`  — no refinement file; draft written as-is.
   * - `'error'`        — a fatal error occurred (default; overwritten on success).
   */
  outcome: 'refined' | 'passthrough' | 'error';

  constructor(
    draftPath:      string,
    className:      string,
    refinementPath: string | null,
    subdir?:        string,
  ) {
    super();
    this.draftPath      = draftPath;
    this.refinementPath = refinementPath;
    this.className      = className;
    this.subdir         = subdir;
    this.draftJson      = null;
    this.refinementJson = null;
    this.finalJson      = null;
    this.outcome        = 'error';
  }

  override clone() {
    const base = super.clone() as this;
    base.draftPath      = this.draftPath;
    base.refinementPath = this.refinementPath;
    base.className      = this.className;
    base.subdir         = this.subdir;
    base.draftJson      = this.draftJson;
    base.refinementJson = this.refinementJson;
    base.finalJson      = this.finalJson;
    base.outcome        = this.outcome;
    return base;
  }

  protected override snapshotData(): JsonObjectType {
    return {
      draftPath:      this.draftPath,
      refinementPath: this.refinementPath,
      className:      this.className,
      subdir:         this.subdir ?? null,
      draftJson:      (this.draftJson ?? null)      as unknown as JsonValueType,
      refinementJson: (this.refinementJson ?? null) as unknown as JsonValueType,
      finalJson:      (this.finalJson ?? null)      as unknown as JsonValueType,
      outcome:        this.outcome,
    };
  }

  protected override restoreData(snap: JsonObjectType): void {
    const draftPath = snap['draftPath'];
    if (typeof draftPath === 'string') this.draftPath = draftPath;

    const refinementPath = snap['refinementPath'];
    this.refinementPath = typeof refinementPath === 'string' ? refinementPath : null;

    const className = snap['className'];
    if (typeof className === 'string') this.className = className;

    const subdir = snap['subdir'];
    this.subdir = typeof subdir === 'string' ? subdir : undefined;

    const draftJson = snap['draftJson'];
    this.draftJson = isPlainObject(draftJson) ? draftJson : null;

    const refinementJson = snap['refinementJson'];
    this.refinementJson = isPlainObject(refinementJson) ? refinementJson : null;

    const finalJson = snap['finalJson'];
    this.finalJson = isPlainObject(finalJson) ? finalJson : null;

    const outcome = snap['outcome'];
    this.outcome = outcome === 'refined' || outcome === 'passthrough' || outcome === 'error'
      ? outcome
      : 'error';
  }
}

function isPlainObject(value: JsonValueType | undefined): value is JsonObjectType {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
