/**
 * Ambient type shim for `rdf-canonize`.
 *
 * `rdf-canonize` v5.x ships as CommonJS with no bundled TypeScript
 * declarations and no `@types/rdf-canonize` package is available on npm.
 * This shim covers the single function squashage uses:
 * `canonize(input, options)` — which accepts an iterable of RDF/JS-shaped
 * quad objects and, with `{ algorithm: 'RDFC-1.0' }`, returns a Promise
 * resolving to a canonical N-Quads **string** (the full dataset serialized
 * in lexicographic order with stable blank-node identifiers).
 *
 * The shim uses `declare module 'rdf-canonize'` so that a standard
 * `import canonize from 'rdf-canonize'` statement resolves to the declared
 * default export. `esModuleInterop` and `allowSyntheticDefaultImports`
 * (both enabled in tsconfig.json) handle the CJS-to-default interop at
 * runtime.
 *
 * This file follows the `-shim.d.ts` naming convention that the
 * `.gitignore` negation rule allows to be committed alongside application
 * source. It is included via the matching glob in `tsconfig.json`.
 *
 * When v1.x swaps to `@semantics/rdf-canonicalize` (which ships its own
 * TypeScript declarations) this shim and the `rdf-canonize` dependency are
 * removed; only `src/rdf/Canonicalize.ts` changes.
 *
 * @since 2.2.0
 */

declare module 'rdf-canonize' {
  import type { Quad } from '@rdfjs/types';

  /**
   * Options accepted by {@link canonize}.
   *
   * @remarks
   * Only the fields squashage exercises are declared here. The full option
   * set (e.g. `createMessageDigest`, `canonicalIdMap`, `maxWorkFactor`) is
   * intentionally omitted — add them if needed rather than widening to
   * `Record<string, unknown>`.
   */
  export interface CanonizeOptions {
    /**
     * Canonicalization algorithm identifier.
     *
     * Use `'RDFC-1.0'` (the URDNA2015 successor standardised by W3C).
     * `'URDNA2015'` is accepted as a deprecated alias in `rdf-canonize` v5
     * but traces a console warning; always prefer `'RDFC-1.0'`.
     */
    algorithm: 'RDFC-1.0' | 'URDNA2015';
  }

  /**
   * Asynchronously canonizes an RDF dataset using the specified algorithm.
   *
   * @param input     - Iterable of RDF/JS-compatible quad objects.
   * @param options   - Must include `algorithm: 'RDFC-1.0'`.
   * @returns A Promise resolving to a canonical N-Quads string (all quads
   *          sorted lexicographically, blank nodes renamed to stable `c14nN`
   *          identifiers).
   */
  export function canonize(
    input:   Iterable<Quad>,
    options: CanonizeOptions,
  ): Promise<string>;

  const _default: { canonize: typeof canonize };
  export default _default;
}
