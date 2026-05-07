import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Logger } from '../modules/logger/logger.js';
import { QuarantineError } from '../errors/QuarantineError.js';
import type { QuarantineRecordInterface, QuarantineSummaryInterface } from '../types/QuarantineRecord.js';

const logger = Logger.forComponent('QuarantineWriter');

/** Filename used by the `output` bucket regardless of the record id. */
const OUTPUT_REPORT_FILENAME = 'validation.report.json';

/**
 * Singleton-per-run writer that persists quarantined pipeline records to disk
 * under bucketed subdirectories and tracks counts for exit-code derivation.
 *
 * @remarks
 * Create one instance per run via {@link QuarantineWriter.forRun}; do not
 * instantiate directly. Each bucket maps to a directory:
 *
 * ```
 * <rootDir>/<target>/quarantine/unknown/<id>.json
 * <rootDir>/<target>/quarantine/conflicts/<id>.json
 * <rootDir>/<target>/quarantine/projection/<id>.json
 * <rootDir>/<target>/quarantine/output/validation.report.json
 * ```
 *
 * The `output` bucket always overwrites `validation.report.json` (one file per run).
 * All other buckets write `<id>.json` — one file per quarantined record.
 *
 * @example
 * ```ts
 * const qw = QuarantineWriter.forRun('./graphs', 'aonprd');
 * await qw.write({ id: sha1, target: 'aonprd', bucket: 'unknown', ... });
 * const summary = qw.summary();
 * process.exitCode = QuarantineWriter.exitCodeFor(summary, false);
 * ```
 *
 * @category Quarantine
 * @since 2.1.0
 * @see {@link QuarantineRecordInterface}
 * @see {@link QuarantineSummaryInterface}
 * @group Core
 */
export class QuarantineWriter {
  readonly #rootDir: string;
  readonly #target:  string;

  #unknown:    number = 0;
  #conflicts:  number = 0;
  #projection: number = 0;
  #output:     number = 0;

  /**
   * @param rootDir - Output base directory (e.g. `"./graphs"`).
   * @param target  - Target identifier (e.g. `"aonprd"`).
   */
  private constructor(rootDir: string, target: string) {
    this.#rootDir = rootDir;
    this.#target  = target;
  }

  /**
   * Creates a QuarantineWriter scoped to a single pipeline run.
   *
   * @param rootDir - Output base directory; records land under `<rootDir>/<target>/quarantine/`.
   * @param target  - Squashage target identifier.
   * @returns A fresh QuarantineWriter instance with zeroed counters.
   */
  public static forRun(rootDir: string, target: string): QuarantineWriter {
    return new QuarantineWriter(rootDir, target);
  }

  /**
   * Writes a quarantined record to the appropriate bucket directory.
   *
   * @remarks
   * The parent directory is created with `{ recursive: true }` before writing,
   * so callers do not need to pre-create the quarantine tree.
   * The `output` bucket always writes `validation.report.json`, overwriting any
   * previous file from this run. All other buckets write `<record.id>.json`.
   * Increments the internal counter for the record's bucket on success.
   *
   * @param record - Fully populated quarantine record, including caller-supplied `id`.
   * @throws {QuarantineError} When the directory creation or file write fails.
   */
  public async write(record: QuarantineRecordInterface): Promise<void> {
    const bucketDir = join(this.#rootDir, this.#target, 'quarantine', record.bucket);
    const filename  = record.bucket === 'output' ? OUTPUT_REPORT_FILENAME : `${record.id}.json`;
    const filePath  = join(bucketDir, filename);

    logger.debug('write', 'Writing quarantine record', {
      bucket: record.bucket,
      id:     record.id,
      path:   filePath,
    });

    try {
      await mkdir(bucketDir, { recursive: true });
      await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw QuarantineError.create(
        `Failed to write quarantine record to ${filePath}`,
        { cause, metadata: { bucket: record.bucket, id: record.id, path: filePath } },
      );
    }

    this.#incrementCounter(record.bucket);

    logger.info('write', 'Quarantine record written', {
      bucket: record.bucket,
      id:     record.id,
      path:   filePath,
    });
  }

  /**
   * Returns the cumulative count of quarantined records by bucket for this run.
   *
   * @remarks
   * Reads from internal counters that are incremented inside {@link write}.
   * Safe to call at any point; reflects only records written so far.
   *
   * @returns Immutable snapshot of bucket counts.
   */
  public summary(): QuarantineSummaryInterface {
    logger.debug('summary', 'Reading quarantine summary', {
      unknown:    this.#unknown,
      conflicts:  this.#conflicts,
      projection: this.#projection,
      output:     this.#output,
    });
    return {
      unknown:    this.#unknown,
      conflicts:  this.#conflicts,
      projection: this.#projection,
      output:     this.#output,
    };
  }

  /**
   * Returns `true` if any record landed in a failure bucket.
   *
   * @remarks
   * The `unknown` bucket is not a failure — it is counted as expected. A run
   * is considered failed only if `conflicts`, `projection`, or `output` is
   * non-zero.
   *
   * @returns `true` when at least one failure-bucket record has been written.
   */
  public hasFailures(): boolean {
    const result = this.#conflicts > 0 || this.#projection > 0 || this.#output > 0;
    logger.debug('hasFailures', 'Checking for quarantine failures', {
      conflicts:  this.#conflicts,
      projection: this.#projection,
      output:     this.#output,
      result,
    });
    return result;
  }

  /**
   * Derives the process exit code from a quarantine summary.
   *
   * @remarks
   * Exit code semantics per plan 13:
   * - `0` — build succeeded; every record either projected or quarantined as `unknown`.
   * - `1` — at least one record in `conflicts` or `projection`, OR `rdfjs:finalize` failed.
   * - `2` — config/schema/startup error before any record processed (not produced here;
   *   the caller supplies `outputFailed` to signal a finalize failure).
   *
   * @param summary      - Bucket counts from {@link QuarantineWriter.summary}.
   * @param outputFailed - `true` when `rdfjs:finalize` itself failed (write/validation error
   *                       outside the quarantine path).
   * @returns `0` for clean runs, `1` for any pipeline failure.
   */
  public static exitCodeFor(summary: QuarantineSummaryInterface, outputFailed: boolean): 0 | 1 {
    const hasFailure =
      summary.conflicts  > 0 ||
      summary.projection > 0 ||
      summary.output     > 0 ||
      outputFailed;

    return hasFailure ? 1 : 0;
  }

  /** Increments the counter for the given bucket. */
  #incrementCounter(bucket: QuarantineRecordInterface['bucket']): void {
    const map: Record<string, () => void> = {
      unknown:    () => { this.#unknown    += 1; },
      conflicts:  () => { this.#conflicts  += 1; },
      projection: () => { this.#projection += 1; },
      output:     () => { this.#output     += 1; },
    };
    map[bucket]?.();
  }
}
