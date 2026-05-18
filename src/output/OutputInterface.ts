/**
 * @fileoverview Core output abstractions: error record, report, and the
 * writeable-file contract that `FileOutput` satisfies.
 *
 * @remarks
 * `OutputInterface` is the stable contract consumed by `rdfjs:finalize`.
 * `FileOutput` is the v0.x implementation; future implementations (e.g.
 * streaming, graph-store) will satisfy the same interface without requiring
 * changes to the finalize task.
 *
 * `OutputReportInterface` mirrors the JSON that lands in
 * `<outDir>/<target>/output.report.json` after every run.
 *
 * @module output/OutputInterface
 * @category Output
 * @since 2.2.0
 */

import type { Quad } from '@rdfjs/types';
import type { RDFFormat } from '../rdf/Formats.js';
import type { BucketReportInterface } from './Bucketer.js';

export type { BucketReportInterface };

// ---------------------------------------------------------------------------
// OutputErrorInterface
// ---------------------------------------------------------------------------

/**
 * A single structured error captured during an output lifecycle stage.
 *
 * @remarks
 * The `stage` field identifies which step of `FileOutput`'s lifecycle the
 * error occurred in so callers can route to the appropriate remediation
 * procedure without parsing the free-form `message`.
 *
 * @example
 * ```ts
 * const err: OutputErrorInterface = {
 *   stage:   'validate',
 *   message: 'SHACL validation failed — 2 constraint violations',
 * };
 * ```
 *
 * @category Output
 * @since 2.2.0
 * @see {@link OutputReportInterface}
 * @group Types
 */
export interface OutputErrorInterface {
  /** Lifecycle stage where the error occurred. */
  readonly stage:   'open' | 'write' | 'serialize' | 'canonicalize' | 'validate' | 'finalize';
  /** Human-readable description of the error. */
  readonly message: string;
}

// ---------------------------------------------------------------------------
// OutputReportInterface
// ---------------------------------------------------------------------------

/**
 * Structured summary of a single file-output operation, written to
 * `<outDir>/<target>/output.report.json` after every run.
 *
 * @remarks
 * The report is produced by {@link OutputInterface.close} regardless of
 * whether the write succeeded or failed.  On failure, `errors` is non-empty
 * and `bytesWritten` may be 0.
 *
 * @example
 * ```ts
 * const report: OutputReportInterface = {
 *   path:         './graphs/aonprd.jsonld',
 *   format:       'trig',
 *   quadCount:    1234,
 *   graphCount:   3,
 *   durationMs:   87,
 *   bytesWritten: 45632,
 *   errors:       [],
 * };
 * ```
 *
 * @category Output
 * @since 2.2.0
 * @see {@link OutputInterface}
 * @see {@link OutputErrorInterface}
 * @group Types
 */
export interface OutputReportInterface {
  /** Absolute or relative path of the output file that was written (or would have been written in dryRun). */
  readonly path:         string;
  /** RDF serialization format used. */
  readonly format:       RDFFormat;
  /** Total number of quads in the serialized dataset (after canonicalization and graph rewriting). */
  readonly quadCount:    number;
  /** Number of distinct graphs (named + default graph counted as one each). */
  readonly graphCount:   number;
  /** Wall-clock duration from {@link OutputInterface.open} to {@link OutputInterface.close}, in milliseconds. */
  readonly durationMs:   number;
  /** Byte length of the UTF-8 serialized document; `0` when `dryRun` is active. */
  readonly bytesWritten: number;
  /** Structured errors captured during the output lifecycle; empty on success. */
  readonly errors:       ReadonlyArray<OutputErrorInterface>;
  /**
   * Per-bucket report entries when `output.bucketing.enabled === true`.
   *
   * @remarks
   * When bucketing is off, this field is absent. When on, each entry describes
   * one output file keyed by graph IRI (or the default/overflow sentinel).
   * The top-level `path` field is the bucket-root directory path.
   */
  readonly buckets?:     ReadonlyArray<BucketReportInterface>;
}

// ---------------------------------------------------------------------------
// OutputInterface
// ---------------------------------------------------------------------------

/**
 * Contract for a single-run RDF file output sink.
 *
 * @remarks
 * The lifecycle is strictly ordered: `open()` → one or more `writeBatch()` →
 * `close()`.  Implementations must be single-use — do not call `open()` twice
 * on the same instance.
 *
 * `rdfjs:finalize` is the canonical caller.  It instantiates one
 * `FileOutput`, drains `ctx.dataset` via `writeBatch`, and calls `close()` to
 * obtain the report.
 *
 * @example
 * ```ts
 * const out: OutputInterface = new FileOutput(config, runDir);
 * await out.open();
 * await out.writeBatch(ctx.dataset);
 * const report = await out.close();
 * ```
 *
 * @category Output
 * @since 2.2.0
 * @see {@link OutputReportInterface}
 * @group Core
 */
export interface OutputInterface {
  /** Destination file path (resolved from config). */
  readonly path:   string;
  /** Resolved RDF serialization format. */
  readonly format: RDFFormat;

  /**
   * Initializes the output sink; creates any required parent directories.
   *
   * @remarks
   * Must be called exactly once before any `writeBatch` call.
   * Records the start timestamp used to compute `durationMs` in the report.
   *
   * @returns Resolves when initialization is complete.
   * @throws {FileOutputError} On directory creation failure.
   */
  open(): Promise<void>;

  /**
   * Accepts a batch of quads into the output buffer.
   *
   * @remarks
   * In `mode === 'dataset'` (default), quads are collected in memory and
   * serialized atomically in `close()`.  In `mode === 'stream'`, the same
   * collect-and-serialize behaviour is used in v0.x — streaming is deferred
   * to v1.x as a performance optimization.
   *
   * @param quads - Iterable of RDF/JS quads to buffer.
   * @returns Resolves when the batch has been accepted.
   */
  writeBatch(quads: Iterable<Quad>): Promise<void>;

  /**
   * Finalizes the output: applies optional transforms, serializes, writes
   * atomically, and returns the output report.
   *
   * @remarks
   * The full close sequence (when all options are active):
   * 1. `canonicalize` → replace buffer with canonical quads.
   * 2. `graph` rewrite → assign all quads to the target named graph.
   * 3. `validate` → run SHACL gate; on failure emit quarantine artifacts and throw.
   * 4. `dryRun` → skip the write, return report with `bytesWritten: 0`.
   * 5. Serialize to string.
   * 6. Atomic write: `<path>.tmp` → fsync → rename to `<path>`.
   *
   * @returns The structured output report.
   * @throws {FileOutputError} On serialization or I/O failure.
   */
  close(): Promise<OutputReportInterface>;
}
