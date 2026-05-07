/**
 * @fileoverview Serialization and structural validation for `OutputReportInterface`.
 *
 * @remarks
 * `OutputReport` is a static-only utility class.  It is not a domain entity —
 * it owns no state — but it is the canonical operator for the
 * `OutputReportInterface` JSON encoding, per the domain-method-over-free-helpers
 * rule.  All call sites that need to persist or restore an output report use
 * `OutputReport.toJson` and `OutputReport.fromJson`.
 *
 * The file written next to each run is `output.report.json`.
 *
 * @module output/OutputReport
 * @category Output
 * @since 2.2.0
 */

import type { OutputReportInterface, OutputErrorInterface } from './OutputInterface.js';
import type { RDFFormat } from '../rdf/Formats.js';
import { Formats } from '../rdf/Formats.js';

/** Filename written under `<outDir>/<target>/output.report.json`. */
export const OUTPUT_REPORT_FILENAME = 'output.report.json' as const;

// ---------------------------------------------------------------------------
// Internal structural validation helpers
// ---------------------------------------------------------------------------

/** Valid lifecycle stage values, kept in sync with `OutputErrorInterface`. */
const VALID_STAGES = new Set<string>([
  'open', 'write', 'serialize', 'canonicalize', 'validate', 'finalize',
]);

/**
 * Returns `true` when `v` is a structurally valid `OutputErrorInterface`.
 */
function isOutputError(v: unknown): v is OutputErrorInterface {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj['stage']   === 'string' && VALID_STAGES.has(obj['stage']) &&
    typeof obj['message'] === 'string'
  );
}

/**
 * Returns `true` when `v` is a structurally valid `OutputReportInterface`.
 */
function isOutputReport(v: unknown): v is OutputReportInterface {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj['path']         === 'string' &&
    typeof obj['format']       === 'string' && Formats.isRdfFormat(obj['format']) &&
    typeof obj['quadCount']    === 'number' &&
    typeof obj['graphCount']   === 'number' &&
    typeof obj['durationMs']   === 'number' &&
    typeof obj['bytesWritten'] === 'number' &&
    Array.isArray(obj['errors']) &&
    (obj['errors'] as unknown[]).every(isOutputError)
  );
}

// ---------------------------------------------------------------------------
// OutputReport class
// ---------------------------------------------------------------------------

/**
 * Static-only operator for `OutputReportInterface` JSON encoding.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated.  Call sites that
 * persist or restore output reports use `OutputReport.toJson` and
 * `OutputReport.fromJson` rather than calling `JSON.stringify` / `JSON.parse`
 * directly.
 *
 * The canonical filename written per run is exported as
 * {@link OUTPUT_REPORT_FILENAME} (`output.report.json`).
 *
 * @example
 * ```ts
 * const json = OutputReport.toJson(report);
 * await fs.writeFile(path.join(outDir, target, OUTPUT_REPORT_FILENAME), json, 'utf8');
 *
 * const restored = OutputReport.fromJson(await fs.readFile(path, 'utf8'));
 * ```
 *
 * @category Output
 * @since 2.2.0
 * @see {@link OutputReportInterface}
 * @see {@link OUTPUT_REPORT_FILENAME}
 * @group Core
 */
export class OutputReport {
  private constructor() { /* static-only */ }

  /**
   * Serializes an `OutputReportInterface` to a canonical JSON string.
   *
   * @remarks
   * Pretty-printed with 2-space indentation.  The key order matches the field
   * declaration order in `OutputReportInterface` to aid human readability.
   *
   * @param report - The output report to serialize.
   * @returns A UTF-8 JSON string suitable for writing to `output.report.json`.
   *
   * @example
   * ```ts
   * const json = OutputReport.toJson(report);
   * // '{\n  "path": "...",\n  "format": "turtle",\n  ...\n}'
   * ```
   */
  public static toJson(report: OutputReportInterface): string {
    const obj = {
      path:         report.path,
      format:       report.format as RDFFormat,
      quadCount:    report.quadCount,
      graphCount:   report.graphCount,
      durationMs:   report.durationMs,
      bytesWritten: report.bytesWritten,
      errors:       report.errors,
    };
    return JSON.stringify(obj, null, 2);
  }

  /**
   * Parses and structurally validates a JSON string as an `OutputReportInterface`.
   *
   * @remarks
   * Performs structural validation: checks that every required field is
   * present with the correct primitive type, that `format` is a known
   * `RDFFormat`, and that each entry in `errors` carries a valid `stage`
   * and a string `message`.  Does not re-validate the file at the reported
   * `path` or check numeric ranges.
   *
   * @param text - UTF-8 JSON string, typically read from `output.report.json`.
   * @returns The parsed and validated `OutputReportInterface`.
   * @throws {SyntaxError} When `text` is not valid JSON.
   * @throws {TypeError} When the parsed value fails structural validation.
   *
   * @example
   * ```ts
   * const report = OutputReport.fromJson(
   *   await fs.readFile('output.report.json', 'utf8'),
   * );
   * console.log(report.quadCount);
   * ```
   */
  public static fromJson(text: string): OutputReportInterface {
    const parsed: unknown = JSON.parse(text);
    if (!isOutputReport(parsed)) {
      throw new TypeError(
        'OutputReport.fromJson: parsed value does not satisfy OutputReportInterface — ' +
        'check that path, format, quadCount, graphCount, durationMs, bytesWritten, and errors are present and correctly typed.',
      );
    }
    return parsed;
  }
}
