/**
 * Ambient module shim for `n3`.
 *
 * `n3` v2.x ships as pure JavaScript with no bundled TypeScript declarations
 * and no `@types/n3` package is available.  This shim covers the surface
 * squashage uses: the named `Parser` and `Writer` exports and the types they
 * consume/return.
 *
 * The `Quad` produced by N3 satisfies `@rdfjs/types` `Quad`; we type the
 * callback accordingly so callers receive properly typed terms.
 *
 * This file follows the `*-shim.d.ts` naming convention that the `.gitignore`
 * negation rule (`!src/**\/*-shim.d.ts`) allows to be committed.
 *
 * When v1.x swaps to `@semantics/rdf-io` (which ships its own declarations)
 * this file and the corresponding `n3` dependency are removed.
 *
 * @since 2.2.0
 */

import type { Quad } from '@rdfjs/types';

declare module 'n3' {
  /** Named-node value string to prefix IRI string. */
  type Prefixes = Record<string, string>;

  /** Callback signature used by {@link Parser.parse} when a callback is supplied. */
  type ParseCallback = (
    error:    Error | null,
    quad:     Quad  | null,
    prefixes: Prefixes | undefined,
  ) => void;

  /** Options accepted by the {@link Parser} constructor. */
  interface ParserOptions {
    format?:           string;
    baseIRI?:          string;
    blankNodePrefix?:  string;
  }

  /** Options accepted by the {@link Writer} constructor. */
  interface WriterOptions {
    /** N3 format string (e.g. `'Turtle'`, `'application/trig'`, `'N-Quads'`). */
    format?:   string;
    /** Prefix map to emit `@prefix` / `PREFIX` declarations. */
    prefixes?: Prefixes;
  }

  /**
   * Callback shape used by {@link Writer.end}.
   *
   * Called once with `(null, result)` on success or `(error, '')` on failure.
   */
  type WriterEndCallback = (error: Error | null, result: string) => void;

  class Parser {
    constructor(options?: ParserOptions);
    /**
     * Parses N3/Turtle/TriG/N-Triples/N-Quads text.
     *
     * When `callback` is supplied parsing is asynchronous: `callback` is
     * called once per quad, then once with `(null, null, prefixes)` on
     * completion, or once with `(error, null, undefined)` on failure.
     */
    parse(input: string, callback: ParseCallback): void;
    /** Synchronous form — returns all quads; throws on error. */
    parse(input: string): Quad[];
  }

  class Writer {
    constructor(options?: WriterOptions);
    /** Appends a single quad to the serialized output. */
    addQuad(quad: Quad): void;
    /**
     * Finalises the serialized output.
     *
     * When no output stream is passed to the constructor the accumulated string
     * is delivered to `done` as the second argument.
     */
    end(done?: WriterEndCallback): void;
  }
}
