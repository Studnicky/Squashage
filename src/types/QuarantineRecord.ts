import type { ClassificationEvidence as ClassificationEvidenceInterface } from '../state/schemas/ClassificationEvidence.js';
import type { InputSource as InputSourceInterface } from '../state/schemas/InputSource.js';

export type { ClassificationEvidenceInterface, InputSourceInterface };

/**
 * Destination bucket for a quarantined record.
 *
 * @remarks
 * Each bucket maps to a subdirectory under `<outDir>/<target>/quarantine/` and
 * to a specific failure mode in the pipeline:
 *
 * - `unknown` — classification did not pick any class; expected, not a failure.
 * - `conflicts` — cascade returned multiple equally specific candidates.
 * - `projection` — `json:read` parse failure or a `squash:*` task threw.
 * - `output` — `rdfjs:finalize` validation failure; always a single file per run.
 *
 * @category Quarantine
 * @since 2.1.0
 * @see {@link QuarantineRecordInterface}
 * @group Types
 */
export type QuarantineBucket = 'unknown' | 'conflicts' | 'projection' | 'output';

/**
 * Serialized representation of a single quarantined pipeline record.
 *
 * @remarks
 * Written to disk as `<id>.json` under the bucket directory, except for the
 * `output` bucket which always writes `validation.report.json`.
 * The `id` is a SHA-1 of `${source.path}#${recordIndex}` and must be
 * supplied by the caller before passing the record to {@link QuarantineWriter.write}.
 *
 * @example
 * ```ts
 * const record: QuarantineRecordInterface = {
 *   id: 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3',
 *   target: 'aonprd',
 *   bucket: 'unknown',
 *   source: { target: 'aonprd', path: 'feat-power-attack.json' },
 *   input: { name: 'Power Attack' },
 *   classification: null,
 *   timestamp: new Date().toISOString(),
 * };
 * ```
 *
 * @category Quarantine
 * @since 2.1.0
 * @see {@link QuarantineBucket}
 * @group Types
 */
export interface QuarantineRecordInterface {
  /** SHA-1 of `${source.path}#${recordIndex}`, supplied by the caller. */
  readonly id:             string;
  /** Squashage target identifier for the record. */
  readonly target:         string;
  /** Destination bucket that categorises the failure mode. */
  readonly bucket:         QuarantineBucket;
  /** Source metadata identifying the originating input JSON file. */
  readonly source:         InputSourceInterface;
  /** Parsed input JSON record, or `null` if unavailable at quarantine time. */
  readonly input:          Record<string, unknown> | null;
  /** Classification result at the time of quarantine, or `null` if unclassified. */
  readonly classification: ClassificationEvidenceInterface | null;
  /** All candidates the cascade considered (present for `conflicts` bucket). */
  readonly candidates?:    ReadonlyArray<ClassificationEvidenceInterface>;
  /** Error that triggered quarantine, if any. */
  readonly error?:         { name: string; message: string; stack?: string };
  /** ISO 8601 timestamp when the record was quarantined. */
  readonly timestamp:      string;
}

/**
 * Per-run count of quarantined records by bucket.
 *
 * @remarks
 * Returned by {@link QuarantineWriter.summary} after all records are written.
 * Consumed by `rdfjs:finalize` to include in the output report and to derive
 * the process exit code via {@link QuarantineWriter.exitCodeFor}.
 *
 * @category Quarantine
 * @since 2.1.0
 * @see {@link QuarantineWriter}
 * @group Types
 */
export interface QuarantineSummaryInterface {
  /** Records quarantined because no class was selected. */
  readonly unknown:    number;
  /** Records quarantined because the cascade found multiple equally specific candidates. */
  readonly conflicts:  number;
  /** Records quarantined due to a parse or projection task failure. */
  readonly projection: number;
  /** Output validation failures; at most one per run. */
  readonly output:     number;
}
