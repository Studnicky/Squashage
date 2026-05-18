/**
 * @fileoverview Thin wrapper that funnels RDF Dataset Canonicalization through
 * a single `Canonicalize.run(quads)` call, isolating `rdf-canonize` from the
 * rest of the application.
 *
 * @remarks
 * **What it does** — `Canonicalize.run` invokes the RDFC-1.0 algorithm
 * (the W3C-standardized successor to URDNA2015) on a set of RDF/JS quads,
 * producing a deterministic dataset in which:
 * - blank-node identifiers are replaced by stable `c14nN` identifiers
 *   derived from the graph structure rather than from creation order, and
 * - the resulting quads are sorted in lexicographic N-Quads order.
 *
 * The v0.x implementation is a two-step round-trip:
 * 1. `rdf-canonize.canonize(quads, { algorithm: 'RDFC-1.0' })` → N-Quads
 *    string (canonical serialization).
 * 2. `Parser.parse(nq, { format: 'nquads' })` → `Quad[]` (re-parsed into
 *    RDF/JS `@rdfjs/types` Quad objects via n3).
 *
 * **v0.x → v1.x swap point** — In v1.x this entire class body is replaced by
 * a one-liner that delegates to `@semantics/rdf-canonicalize`:
 * ```ts
 * const { canonicalized } = await canonicalize(quads, { outputFormat: 'dataset' });
 * return canonicalized;
 * ```
 * Until then, `rdf-canonize` is imported here and nowhere else in application
 * code; the ESLint `no-restricted-imports` rule enforces that boundary (see
 * `eslint.config.mjs`).  The `src/rdf/**` glob is excluded from that rule so
 * this wrapper can consume the underlying package.
 *
 * @module rdf/Canonicalize
 * @category RDF
 * @since 2.2.0
 */

import type { Quad } from '@rdfjs/types';
import { canonize } from 'rdf-canonize';

import { Parser } from './Parser.js';

// ---------------------------------------------------------------------------
// Canonicalize class
// ---------------------------------------------------------------------------

/**
 * Static-only wrapper for RDF Dataset Canonicalization (RDFC-1.0).
 *
 * @remarks
 * All methods are static; the class cannot be instantiated.  Application code
 * should never import `rdf-canonize` directly; use this class instead.
 *
 * The public surface — `Canonicalize.run(quads): Promise<ReadonlyArray<Quad>>`
 * — is stable across the v0.x → v1.x migration.  When the `@semantics/*`
 * workspace publishes, only this class body changes; callers are unaffected.
 *
 * @example
 * ```ts
 * import { Canonicalize } from '../rdf/Canonicalize.js';
 *
 * const canonical = await Canonicalize.run(quads);
 * // canonical: ReadonlyArray<Quad> — sorted, stable blank-node identifiers
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @see {@link Parser}
 * @group Core
 */
export class Canonicalize {
  private constructor() { /* static-only */ }

  /**
   * Run RDFC-1.0 (URDNA2015 successor) over the input quads and return a
   * deterministic, canonicalized `Quad[]` — the same dataset re-parsed from
   * its canonical N-Quads serialization.
   *
   * @remarks
   * **Algorithm** — RDFC-1.0 is the W3C RDF Dataset Canonicalization
   * algorithm standardized at https://www.w3.org/TR/rdf-canon/.  It produces
   * a bijective mapping from blank-node identifiers to stable `c14nN` labels
   * derived entirely from graph structure, making the output byte-identical
   * regardless of the blank-node identifiers or quad ordering in the input.
   *
   * **Empty input** — passing an empty array returns an empty array without
   * invoking `rdf-canonize`.
   *
   * **v0.x implementation** — delegates to `rdf-canonize.canonize` (BSD-3
   * licensed, published OSS) then re-parses the resulting N-Quads string
   * through `Parser.parse` (which uses `n3`) to produce standard RDF/JS
   * `Quad` objects.
   *
   * @param quads - Input RDF/JS quads.  May be empty.  Order and blank-node
   *   identifier naming do not affect the output.
   * @returns A Promise resolving to a canonicalized `ReadonlyArray<Quad>` in
   *   lexicographic N-Quads order with stable blank-node identifiers.
   * @throws {Error} When `rdf-canonize` encounters an unrecoverable
   *   canonicalization error (e.g. work-factor limit exceeded for pathological
   *   blank-node graphs).
   *
   * @example Basic usage
   * ```ts
   * const result = await Canonicalize.run([quad1, quad2]);
   * ```
   *
   * @example Empty input
   * ```ts
   * const result = await Canonicalize.run([]);
   * result.length; // 0
   * ```
   */
  public static async run(quads: ReadonlyArray<Quad>): Promise<ReadonlyArray<Quad>> {
    if (quads.length === 0) {
      return [];
    }

    const nq = await canonize([...quads], { algorithm: 'RDFC-1.0' });

    if (nq.length === 0) {
      return [];
    }

    const { quads: out } = await Parser.parse(nq, { format: 'nquads' });
    return out;
  }
}
