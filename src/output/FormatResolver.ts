/**
 * @fileoverview Resolves a concrete `RDFFormat` from an `OutputConfigInterface`,
 * applying explicit override before falling back to extension-based detection.
 *
 * @remarks
 * `FormatResolver` owns the format-resolution logic so that `FileOutput`,
 * `rdfjs:finalize`, and the CLI `--format` flag all use the same code path.
 * It delegates to {@link Formats} and throws {@link OutputConfigError} rather
 * than returning `undefined` — call sites receive a valid `RDFFormat` or an
 * actionable error.
 *
 * @module output/FormatResolver
 * @category Output
 * @since 2.2.0
 */

import type { OutputConfigInterface } from '../config/OutputConfig.js';
import type { RDFFormat } from '../rdf/Formats.js';
import { Formats } from '../rdf/Formats.js';
import { OutputConfigError } from '../errors/OutputConfigError.js';

// ---------------------------------------------------------------------------
// FormatResolver class
// ---------------------------------------------------------------------------

/**
 * Static-only resolver that derives the {@link RDFFormat} for a given
 * `OutputConfigInterface`.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated.  Resolution is
 * ordered:
 *
 * 1. If `output.format` is set, validate it via {@link Formats.isRdfFormat}
 *    and return it directly.
 * 2. Otherwise derive the format from `output.path`'s extension via
 *    {@link Formats.formatFromExtension}.
 * 3. If neither resolves, throw {@link OutputConfigError}.
 *
 * @example
 * ```ts
 * // Explicit format wins
 * const fmt = FormatResolver.resolve({ kind: 'file', path: './out.trig', format: 'turtle' });
 * // fmt === 'turtle'
 *
 * // Extension fallback
 * const fmt2 = FormatResolver.resolve({ kind: 'file', path: './out.ttl' });
 * // fmt2 === 'turtle'
 * ```
 *
 * @category Output
 * @since 2.2.0
 * @see {@link Formats}
 * @see {@link OutputConfigError}
 * @group Core
 */
export class FormatResolver {
  private constructor() { /* static-only */ }

  /**
   * Resolves the {@link RDFFormat} for the given output config.
   *
   * @remarks
   * When `output.format` is present it is validated via
   * {@link Formats.isRdfFormat} before being returned — the schema already
   * restricts values to the five v0.x formats, but the guard here keeps the
   * method safe against programmatic callers that bypass AJV.
   *
   * When `output.format` is absent, the path extension is matched against
   * {@link FILE_EXTENSIONS} via {@link Formats.formatFromExtension}.  For
   * example, `"./out/aonprd.jsonld"` resolves to `"jsonld"`.
   *
   * @param output - Validated output config from the squashage target.
   * @returns The resolved {@link RDFFormat}.
   * @throws {OutputConfigError} When the explicit format value is unrecognised,
   *   or when neither `format` nor a recognisable extension is present.
   *
   * @example Explicit format
   * ```ts
   * FormatResolver.resolve({ kind: 'file', path: './out.data', format: 'nquads' });
   * // 'nquads'
   * ```
   *
   * @example Extension fallback
   * ```ts
   * FormatResolver.resolve({ kind: 'file', path: './graphs/aonprd.jsonld' });
   * // 'jsonld'
   * ```
   *
   * @example Error on missing
   * ```ts
   * FormatResolver.resolve({ kind: 'file', path: './graphs/aonprd.csv' });
   * // throws OutputConfigError
   * ```
   */
  public static resolve(output: OutputConfigInterface): RDFFormat {
    if (output.format !== undefined) {
      if (!Formats.isRdfFormat(output.format)) {
        throw OutputConfigError.create(
          `Unrecognised RDF format "${output.format}" — supported values: turtle, trig, ntriples, nquads, jsonld.`,
          { metadata: { format: output.format, path: output.path } },
        );
      }
      return output.format;
    }

    const fromExt = Formats.formatFromExtension(output.path);
    if (fromExt !== undefined) {
      return fromExt;
    }

    throw OutputConfigError.create(
      `Cannot resolve RDFFormat from path "${output.path}" — provide \`format\` explicitly.`,
      { metadata: { path: output.path } },
    );
  }
}
