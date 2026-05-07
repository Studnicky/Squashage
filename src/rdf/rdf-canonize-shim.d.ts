/**
 * Ambient module shim for `rdf-canonize`.
 *
 * `rdf-canonize` v5.x ships as pure CommonJS JavaScript with no bundled
 * TypeScript declarations and no `@types/rdf-canonize` package is available
 * on npm.  This shim covers the single function squashage uses:
 * `canonize(input, options)` — which accepts an iterable of RDF/JS-shaped
 * quad objects and, with `{ algorithm: 'RDFC-1.0' }`, returns a Promise
 * resolving to a canonical N-Quads **string** (the full dataset serialized
 * in lexicographic order with stable blank-node identifiers).
 *
 * The underlying `rdf-canonize` library accepts any iterable of objects
 * whose term fields (`subject`, `predicate`, `object`, `graph`) carry a
 * `termType` discriminant and a `value` string — i.e. standard RDF/JS
 * `@rdfjs/types` `Quad` values satisfy this contract.
 *
 * This file follows the `*-shim.d.ts` naming convention that the
 * `.gitignore` negation rule (`!src/**\/*-shim.d.ts`) allows to be
 * committed alongside application source.
 *
 * When v1.x swaps to `@semantics/rdf-canonicalize` (which ships its own
 * TypeScript declarations) this shim and the `rdf-canonize` dependency are
 * removed; only `src/rdf/Canonicalize.ts` changes.
 *
 * @since 2.2.0
 */

import type { Quad } from '@rdfjs/types';

/**
 * Options accepted by {@link canonize}.
 *
 * @remarks
 * Only the fields squashage exercises are declared here.  The full option
 * set (e.g. `createMessageDigest`, `canonicalIdMap`, `maxWorkFactor`) is
 * intentionally omitted — add them if needed rather than widening to
 * `Record<string, unknown>`.
 */
interface CanonizeOptions {
  /**
   * Canonicalization algorithm identifier.
   *
   * Use `'RDFC-1.0'` (the URDNA2015 successor standardised by W3C).
   * `'URDNA2015'` is accepted as a deprecated alias in `rdf-canonize` v5
   * but traces a console warning; always prefer `'RDFC-1.0'`.
   */
  algorithm: 'RDFC-1.0' | 'URDNA2015';
}

declare module 'rdf-canonize' {
  /**
   * Asynchronously canonizes an RDF dataset using the specified algorithm.
   *
   * @param input     - Iterable of RDF/JS-compatible quad objects.
   * @param options   - Must include `algorithm: 'RDFC-1.0'`.
   * @returns A Promise resolving to a canonical N-Quads string (all quads
   *          sorted lexicographically, blank nodes renamed to stable `c14nN`
   *          identifiers).
   */
  function canonize(
    input:   Iterable<Quad>,
    options: CanonizeOptions,
  ): Promise<string>;
}
