/**
 * @fileoverview Parse-round-trip RDF syntax validator.  Delegates to
 * {@link Parser.parse} for each supported {@link RDFFormat}; a clean parse
 * yields `ok: true`, a thrown error yields `ok: false` with the error
 * message (and line/column when the underlying parser exposes them).
 *
 * @remarks
 * **v0.x swap point** — In v1.x this class body is replaced by a one-liner
 * that delegates to `@semantics/rdf-validator`, which ships per-format
 * diagnostic streams.  Until then the round-trip approach is sufficient for
 * post-write sanity checks and unit-level format coverage.
 *
 * **line / column availability** — n3 errors embed location data inside
 * `error.context.line` rather than as direct own properties, so `errors[0].line`
 * and `errors[0].column` are typically `undefined` for n3-backed formats.
 * The fields are present in the interface for v1.x compatibility; callers
 * should treat them as best-effort.
 *
 * @module rdf/SyntaxValidator
 * @category RDF
 * @since 2.2.0
 */

import type { RDFFormat } from './Formats.js';
import { Parser } from './Parser.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single syntax error extracted from a failed parse attempt.
 *
 * @remarks
 * `line` and `column` are populated on a best-effort basis — they are
 * present only when the underlying parser (n3, jsonld) exposes them as
 * direct properties on the thrown error.  n3 v2 stores location inside
 * `error.context.line`; this wrapper does not drill into `context`, so
 * `line` and `column` are typically `undefined` for N3-family formats.
 *
 * @example
 * ```ts
 * const { errors } = await SyntaxValidator.validate(bad, { format: 'turtle' });
 * console.log(errors[0]?.message); // "Unexpected "X" on line 1."
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @group Types
 */
export interface SyntaxErrorInterface {
  /** Human-readable description of the parse failure. */
  readonly message: string;
  /** 1-based source line number, when available. */
  readonly line?:   number;
  /** 1-based source column number, when available. */
  readonly column?: number;
}

/**
 * Result returned by {@link SyntaxValidator.validate}.
 *
 * @remarks
 * `ok` is `true` when the document parses without error; `errors` is
 * always empty in that case.  On failure `ok` is `false` and `errors`
 * contains exactly one entry carrying the parse error details.
 *
 * @example
 * ```ts
 * const result = await SyntaxValidator.validate(text, { format: 'turtle' });
 * if (!result.ok) {
 *   console.error(result.errors[0]?.message);
 * }
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @group Types
 */
export interface SyntaxValidationResultInterface {
  /** `true` when the document is syntactically valid. */
  readonly ok:     boolean;
  /** Errors collected during the parse attempt (empty on success). */
  readonly errors: ReadonlyArray<SyntaxErrorInterface>;
}

// ---------------------------------------------------------------------------
// SyntaxValidator class
// ---------------------------------------------------------------------------

/**
 * Static-only RDF syntax validator that uses a parse round-trip to detect
 * syntax errors in serialized RDF documents.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated.  Validation is
 * performed by calling {@link Parser.parse} inside a try/catch.  A clean
 * parse signals a valid document; a thrown error is normalized into a
 * {@link SyntaxValidationResultInterface} with `ok: false`.
 *
 * This is the canonical entry point for optional post-write sanity checks
 * and for validating user-supplied shape documents before passing them to
 * {@link ShaclGate}.
 *
 * @example
 * ```ts
 * const result = await SyntaxValidator.validate(
 *   '@prefix ex: <http://example.org/> . ex:s ex:p "o" .',
 *   { format: 'turtle' },
 * );
 * console.log(result.ok);     // true
 * console.log(result.errors); // []
 * ```
 *
 * @example Invalid document
 * ```ts
 * const result = await SyntaxValidator.validate('NOT VALID', { format: 'turtle' });
 * console.log(result.ok);              // false
 * console.log(result.errors[0]?.message); // "Unexpected "NOT" on line 1."
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @see {@link Parser}
 * @see {@link SyntaxValidationResultInterface}
 * @group Core
 */
export class SyntaxValidator {
  private constructor() { /* static-only */ }

  /**
   * Validate a serialized RDF document by attempting to parse it with the
   * format's parser.  Returns `ok: true` on a clean parse; `ok: false` with
   * errors extracted from the thrown error otherwise.
   *
   * @remarks
   * Line and column numbers are surfaced when the underlying parser exposes
   * them as direct own properties on the thrown error.  n3 v2 encodes
   * location in `error.context.line` rather than `error.line`, so those
   * fields are typically `undefined` for Turtle, TriG, N-Triples, and
   * N-Quads.  The error `message` always contains human-readable context
   * including the approximate line number for n3 errors.
   *
   * @param text    - Raw serialized RDF document text to validate.
   * @param options - Options including the required `format` identifier.
   * @returns A promise resolving to the validation result.
   *
   * @example Turtle — valid
   * ```ts
   * const r = await SyntaxValidator.validate(
   *   '@prefix ex: <http://example.org/> . ex:s ex:p "o" .',
   *   { format: 'turtle' },
   * );
   * // r.ok === true, r.errors === []
   * ```
   *
   * @example Turtle — invalid
   * ```ts
   * const r = await SyntaxValidator.validate('NOT TURTLE', { format: 'turtle' });
   * // r.ok === false, r.errors[0].message !== ''
   * ```
   */
  public static async validate(
    text:    string,
    options: { format: RDFFormat },
  ): Promise<SyntaxValidationResultInterface> {
    try {
      await Parser.parse(text, { format: options.format });
      return { ok: true, errors: [] };
    } catch (err) {
      const e = err as Error & { line?: number; column?: number };
      // Build the entry incrementally to satisfy exactOptionalPropertyTypes:
      // optional properties may only be set to a defined value, never to
      // `undefined` directly.
      const errEntry: { message: string; line?: number; column?: number } = {
        message: e.message,
        ...(e.line   !== undefined ? { line:   e.line   } : {}),
        ...(e.column !== undefined ? { column: e.column } : {}),
      };
      return { ok: false, errors: [errEntry] };
    }
  }
}
