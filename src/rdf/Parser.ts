/**
 * @fileoverview Thin wrapper that normalises RDF parsing across n3 (Turtle,
 * TriG, N-Triples, N-Quads) and jsonld (JSON-LD) into a single async
 * `Parser.parse(text, { format })` call.
 *
 * @remarks
 * **v0.x swap point** — In v1.x this entire class body is replaced by a
 * one-liner that delegates to `@semantics/rdf-io`'s reader, which ships its
 * own TypeScript declarations, streaming support, and RDF/XML coverage.
 * Until then, the two OSS packages (`n3`, `jsonld`) are imported here and
 * nowhere else in application code; the ESLint `no-restricted-imports` rule
 * enforces that boundary (see `eslint.config.mjs`).
 *
 * **Callback shape (n3 v2)**:
 * `parser.parse(text, (error, quad, prefixes) => …)`
 * — called once per quad with `(null, quad, undefined)`,
 * — called once at end with `(null, null, prefixes)`,
 * — called once on error with `(error, null, undefined)`.
 * Typed via `@types/n3`; see {@link https://www.npmjs.com/package/@types/n3}.
 *
 * @module rdf/Parser
 * @category RDF
 * @since 2.2.0
 */

import { Parser as N3Parser } from 'n3';
import jsonld from 'jsonld';

import type { Quad } from '@rdfjs/types';
import type { RDFFormat } from './Formats.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Internal options shape for `jsonld.toRDF`, scoped to this module.
 * Defined separately to satisfy `exactOptionalPropertyTypes` — fields are
 * set conditionally rather than spread with potentially-undefined values.
 * `format` is typed as the literal `'application/n-quads'` to satisfy the
 * `Options.ToRdf` constraint from `@types/jsonld`.
 */
interface JsonLdToRdfOptions {
  format?: 'application/n-quads';
  base?:   string;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for {@link Parser.parse}.
 *
 * @example
 * ```ts
 * const opts: ParseOptionsInterface = { format: 'turtle', baseIRI: 'http://example.org/' };
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @group Types
 */
export interface ParseOptionsInterface {
  /** Target RDF serialization format. */
  format:   RDFFormat;
  /** Optional base IRI used to resolve relative IRIs during parsing. */
  baseIRI?: string;
}

/**
 * Result returned by {@link Parser.parse}.
 *
 * @example
 * ```ts
 * const { quads, prefixes } = await Parser.parse(text, { format: 'turtle' });
 * prefixes['ex']; // 'http://example.org/'
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @group Types
 */
export interface ParseResultInterface {
  /** All quads extracted from the input document. */
  quads:    ReadonlyArray<Quad>;
  /** Namespace prefix map declared in the document (empty for N-Triples/N-Quads). */
  prefixes: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * N3 parser format strings keyed by {@link RDFFormat}.
 *
 * N3 uses the last `\w+` in the format string (lower-cased) to detect mode.
 * These values produce the expected behaviour for each v0.x format.
 */
const N3_FORMAT: Readonly<Record<Exclude<RDFFormat, 'jsonld'>, string>> = Object.freeze({
  turtle:   'Turtle',
  trig:     'application/trig',
  ntriples: 'N-Triples',
  nquads:   'N-Quads',
} as const);

// ---------------------------------------------------------------------------
// Parser class
// ---------------------------------------------------------------------------

/**
 * Static-only RDF parser that dispatches across n3 and jsonld based on the
 * requested {@link RDFFormat}.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated.  Application code
 * should never import `n3` or `jsonld` directly; use this class instead.
 *
 * SHACL shape documents (`.ttl` / `.trig` files) are loaded via
 * `Parser.parse(shapesText, { format })`, which is the canonical entry point
 * for any RDF text in the pipeline.
 *
 * @example
 * ```ts
 * const { quads, prefixes } = await Parser.parse(
 *   '@prefix ex: <http://example.org/> . ex:s ex:p "o" .',
 *   { format: 'turtle' },
 * );
 * console.log(quads.length);   // 1
 * console.log(prefixes['ex']); // 'http://example.org/'
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @see {@link ParseOptionsInterface}
 * @see {@link ParseResultInterface}
 * @group Core
 */
export class Parser {
  private constructor() { /* static-only */ }

  /**
   * Parses an RDF document and returns all quads and declared prefix bindings.
   *
   * @remarks
   * - **Turtle / TriG / N-Triples / N-Quads** — delegated to n3's callback
   *   API, wrapped in a Promise so errors propagate correctly.
   * - **JSON-LD** — the document is first expanded to N-Quads via
   *   `jsonld.toRDF`, then re-parsed through the N-Quads path (recursive
   *   call).  JSON-LD documents do not declare Turtle-style prefixes, so
   *   `prefixes` is always `{}` for this format.
   *
   * @param text    - Raw RDF document text.
   * @param options - Parse options including the required `format`.
   * @returns A promise resolving to all parsed quads and prefix bindings.
   * @throws {Error} When the document is syntactically invalid.
   *
   * @example Turtle
   * ```ts
   * const { quads, prefixes } = await Parser.parse(
   *   '@prefix ex: <http://example.org/> . ex:s ex:p "o" .',
   *   { format: 'turtle' },
   * );
   * ```
   *
   * @example JSON-LD
   * ```ts
   * const { quads } = await Parser.parse(
   *   JSON.stringify({ '@id': 'http://example.org/s', 'http://example.org/p': 'o' }),
   *   { format: 'jsonld' },
   * );
   * ```
   */
  public static async parse(text: string, options: ParseOptionsInterface): Promise<ParseResultInterface> {
    if (options.format === 'jsonld') {
      return Parser.parseJsonLd(text, options);
    }
    return Parser.parseN3(text, options);
  }

  // ---------------------------------------------------------------------------
  // Private dispatch helpers
  // ---------------------------------------------------------------------------

  /**
   * Parses N3-family formats (Turtle, TriG, N-Triples, N-Quads) via n3's
   * callback API, wrapped in a Promise.
   */
  private static parseN3(text: string, options: ParseOptionsInterface): Promise<ParseResultInterface> {
    const n3Format = N3_FORMAT[options.format as Exclude<RDFFormat, 'jsonld'>];

    return new Promise<ParseResultInterface>((resolve, reject) => {
      const parserOptions: { format?: string; baseIRI?: string } = { format: n3Format };
      if (options.baseIRI !== undefined) parserOptions.baseIRI = options.baseIRI;
      const parser = new N3Parser(parserOptions);
      const quads: Quad[] = [];
      const prefixes: Record<string, string> = {};

      // n3 calls callback(null, quad, undefined) per quad and callback(null, null, prefixes)
      // at end-of-document. @types/n3 ParseCallback types error and quad as non-nullable;
      // the double cast satisfies strict-null checks while preserving runtime correctness.
      type N3Callback = Parameters<typeof parser.parse>[1];
      parser.parse(text, ((error: Error | null, quad: Quad | null, parsedPrefixes: Record<string, string> | undefined) => {
        if (error !== null) {
          reject(error);
          return;
        }

        if (quad !== null) {
          quads.push(quad);
          return;
        }

        // quad is null → end-of-document signal; parsedPrefixes carries the map.
        Object.assign(prefixes, parsedPrefixes ?? {});
        resolve({ quads, prefixes });
      }) as unknown as N3Callback);
    });
  }

  /**
   * Parses a JSON-LD document by converting it to N-Quads via `jsonld.toRDF`,
   * then re-parsing through {@link parseN3}.
   *
   * @remarks
   * JSON-LD does not declare Turtle-style prefix bindings, so `prefixes` is
   * always `{}` for this path.
   */
  private static async parseJsonLd(text: string, options: ParseOptionsInterface): Promise<ParseResultInterface> {
    const doc = JSON.parse(text) as Parameters<typeof jsonld.toRDF>[0];
    const toRdfOpts: JsonLdToRdfOptions = { format: 'application/n-quads' };
    if (options.baseIRI !== undefined) toRdfOpts.base = options.baseIRI;
    // When options.format is 'application/n-quads', jsonld.toRDF returns a string
    // at runtime. @types/jsonld types the return as RdfOrString (object | string);
    // the double cast is safe because n-quads output is always a string.
    const nq = await jsonld.toRDF(doc, toRdfOpts) as unknown as string;
    const parseOpts: ParseOptionsInterface = { format: 'nquads' };
    if (options.baseIRI !== undefined) parseOpts.baseIRI = options.baseIRI;
    return Parser.parse(nq, parseOpts);
  }
}
