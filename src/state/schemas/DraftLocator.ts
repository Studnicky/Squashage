/**
 * DraftLocator — identifies one draft schema file on disk.
 *
 * Produced by the `walk-drafts` node and consumed by `process-all-drafts`
 * (the refine fan-out) to dispatch `squashage:refine-one` per draft.
 */
export interface DraftLocator {
  /** Absolute path to the `<className>.draft.json` file. */
  readonly draftPath:      string;
  /** Class name derived from the filename (strip `.draft.json` suffix). */
  readonly className:      string;
  /**
   * Absolute path to the corresponding `<className>.refine.json` file, or
   * `null` when no refinement file exists for this class.
   */
  readonly refinementPath: string | null;
  /**
   * Optional subdirectory relative to the finals root where the final schema
   * should be written. Undefined for top-level class schemas; `'primitives'`
   * or `'objects'` for extracted schemas.
   */
  readonly subdir?: string;
}
