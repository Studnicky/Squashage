/**
 * @fileoverview RDF-star utilities for quoted-triple construction and format detection.
 *
 * @remarks
 * Provides two static helpers used by the `output:provenance` task when
 * `encoding: "rdf-star"` is active:
 *
 * - `RdfStar.quoteQuad(dataFactory, subject, predicate, object)` -- constructs a
 *   quoted triple (a `Quad` term used as the *subject* of another `Quad`).
 * - `RdfStar.isSupported(serializerFormat)` -- returns `true` for the three
 *   RDF-star-capable n3.js format strings (`application/trig-star`,
 *   `text/turtle-star`, `application/n-quads-star`).
 *
 * The n3.js v2 library (installed as `n3`) supports RDF-star by accepting a
 * `Quad` term as the subject argument of `DataFactory.quad()`. The resulting
 * `Quad` object has `termType === 'Quad'` and is serialised as `<< ... >>` in
 * TriG-star / Turtle-star output.
 *
 * This module is the only place in application code that constructs quoted
 * triples. All other code uses the RDF/JS data model via `DataFactory`.
 *
 * @module rdf/RdfStar
 * @category RDF
 * @since 0.5.0
 */

import type { NamedNode, BlankNode, Quad } from '@rdfjs/types';
import { dataFactory } from './DataFactory.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * The set of n3.js format strings that support RDF-star serialization.
 *
 * @internal
 */
const RDF_STAR_FORMATS: ReadonlySet<string> = new Set([
  'application/trig-star',
  'text/turtle-star',
  'application/n-quads-star',
]);

// ---------------------------------------------------------------------------
// RdfStar class
// ---------------------------------------------------------------------------

/**
 * Static-only helper for RDF-star quoted-triple construction and format detection.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated. Application code
 * that needs to emit provenance via quoted triples calls these helpers rather
 * than constructing `Quad`-as-subject terms inline.
 *
 * @example Construct a quoted triple and wrap it in a provenance quad
 * ```ts
 * import { RdfStar } from '../rdf/RdfStar.js';
 * import { dataFactory } from '../rdf/DataFactory.js';
 *
 * const quoted   = RdfStar.quoteQuad(dataFactory, subject, rdfType, classNode);
 * const provQuad = dataFactory.quad(quoted, assertedBy, classifierNode);
 * dataset.add(provQuad);
 * ```
 *
 * @example Format detection
 * ```ts
 * RdfStar.isSupported('application/trig-star');    // true
 * RdfStar.isSupported('application/trig');          // false
 * RdfStar.isSupported('application/n-triples');     // false
 * ```
 *
 * @category RDF
 * @since 0.5.0
 * @group Core
 */
export class RdfStar {
  private constructor() { /* static-only */ }

  /**
   * Returns `true` when the given n3.js format string supports RDF-star
   * quoted-triple serialization.
   *
   * @remarks
   * The recognised format strings are:
   * - `'application/trig-star'` -- TriG-star (preferred for quad-capable output)
   * - `'text/turtle-star'` -- Turtle-star (triple-only, no named graphs)
   * - `'application/n-quads-star'` -- N-Quads-star (line-based, no prefixes)
   *
   * Plain `'application/trig'`, `'Turtle'`, `'N-Triples'`, `'N-Quads'`, and
   * `'application/n-triples'` are NOT RDF-star-capable and return `false`.
   *
   * @param serializerFormat - A format string as accepted by `n3.Writer({ format })`.
   * @returns `true` when the format can serialise quoted triples.
   *
   * @example
   * ```ts
   * RdfStar.isSupported('application/trig-star');   // true
   * RdfStar.isSupported('application/n-triples');   // false
   * ```
   */
  public static isSupported(serializerFormat: string): boolean {
    return RDF_STAR_FORMATS.has(serializerFormat);
  }

  /**
   * Constructs a quoted triple -- a `Quad` term (RDF-star subject) from the
   * given subject, predicate, and object.
   *
   * @remarks
   * The returned value is a standard RDF/JS `Quad` (with `termType === 'Quad'`)
   * that n3.js accepts as the `subject` argument of a containing quad. The
   * default graph is used as the graph component of the inner quoted triple
   * (per the RDF-star specification: quoted triples have no graph component).
   *
   * Only `NamedNode` and `BlankNode` are valid as the subject of a quoted triple
   * per the RDF-star data model. This helper enforces that at the TypeScript
   * call site.
   *
   * @param subject   - Subject term of the quoted triple.
   * @param predicate - Predicate term of the quoted triple.
   * @param object    - Object term of the quoted triple (NamedNode or BlankNode).
   * @returns A `Quad` shaped term suitable for use as the subject of another quad.
   *
   * @example
   * ```ts
   * const quoted = RdfStar.quoteQuad(subject, rdfType, classNode);
   * // quoted.termType === 'Quad'
   * // quoted.subject === subject, quoted.predicate === rdfType, quoted.object === classNode
   * ```
   */
  public static quoteQuad(
    subject:   NamedNode | BlankNode,
    predicate: NamedNode,
    object:    NamedNode | BlankNode,
  ): Quad {
    return dataFactory.quad(subject, predicate, object) as Quad;
  }
}
