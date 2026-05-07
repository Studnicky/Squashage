/**
 * @fileoverview Programmatic RDF graph construction with a fluent subject/add/graph API.
 *
 * @remarks
 * `GraphBuilder` is the v0.x wrapper over the quad-building ergonomics vendored from
 * `semantics/rdf-builder/src/GraphBuilder.ts`.  Application code and plugins import
 * this class — never the semantics workspace directly.  At v1.x the implementation
 * below swaps to `import { GraphBuilder } from '@semantics/rdf-builder'` and only
 * this file changes.
 *
 * The public surface is intentionally minimal for v0.x:
 * - {@link GraphBuilder.constructor} — validated base-IRI guard
 * - {@link GraphBuilder.subject} — open a subject term
 * - {@link GraphBuilder.add} — attach a predicate-object pair
 * - {@link GraphBuilder.graph} — switch the active named graph
 * - {@link GraphBuilder.addTo} — flush pending quads into an external `DatasetCore`
 * - {@link GraphBuilder.build} — materialize all pending quads and return the count
 *
 * Divergences from the semantics vendor source flagged for v1.x reconciliation:
 * - `build()` here returns `number` (the count emitted); the vendor returns `Quad[]`.
 * - `add()` unifies the vendor's `property()` / `propertyLiteral()` / `propertyIRI()`
 *   family into a single method accepting RDF/JS terms or a plain string (as literal).
 * - `addTo(dataset)` is a squashage-specific method that the vendor does not have.
 * - `graph()` switching is a squashage-specific method; the vendor targets triple-only
 *   (default-graph) builds.
 * - The vendor's `blankNode()`, `linkTo()`, `prefix()`, `prefixes()`, `serialize()`,
 *   `writeToFile()`, `toCanonical()`, `type()`, `propertyBoolean()`, `propertyDateTime()`,
 *   `propertyNumber()`, `propertyLiteral()`, `propertyIRI()`, `dataset()`, `iterQuads()`,
 *   `clear()`, `getBaseIRI()`, `getCurrentSubject()` are deferred to v1.x.
 *
 * All factory calls go through `dataFactory` from `./DataFactory.js`.
 *
 * @module rdf/GraphBuilder
 * @category RDF
 * @since 2.2.0
 * @see {@link https://rdf.js.org/dataset-spec/ | RDF/JS Dataset spec}
 */

import type { BlankNode, DatasetCore, DefaultGraph, Literal, NamedNode, Quad } from '@rdfjs/types';

import { dataFactory } from './DataFactory.js';
import { IRIUtils } from './Namespaces.js';

// ---------------------------------------------------------------------------
// GraphBuilder
// ---------------------------------------------------------------------------

/**
 * Fluent RDF graph builder for programmatic quad construction.
 *
 * @remarks
 * Plugins and built-in tasks use `GraphBuilder` to emit quads into the
 * run-wide `DatasetCore` held on `state.context.dataset`.  The builder is
 * available on `state.context.builder` pre-configured with the target's base
 * IRI.
 *
 * The builder accumulates quads in an internal buffer.  Call {@link build} to
 * flush them into the configured dataset (set via {@link addTo}), or call
 * {@link addTo} mid-chain to target a dataset and then {@link build} to
 * materialize.
 *
 * Subject IRIs that are not absolute are resolved against `baseIRI` using
 * `new URL(ref, base).href` semantics.  Predicate strings that are not
 * absolute are resolved the same way.
 *
 * @example
 * ```ts
 * import { Dataset } from './Dataset.js';
 * import { dataFactory } from './DataFactory.js';
 * import { GraphBuilder } from './GraphBuilder.js';
 *
 * const dataset = Dataset.empty();
 * const g = dataFactory.namedNode('https://squashage.dev/graph/aonprd/feat');
 *
 * const count = new GraphBuilder('https://squashage.dev/vocabulary/aonprd#')
 *   .addTo(dataset)
 *   .graph(g)
 *   .subject('power-attack')
 *   .add('https://schema.org/name', 'Power Attack')
 *   .add('https://schema.org/identifier', dataFactory.literal('750'))
 *   .build();
 *
 * console.log(count); // 2
 * console.log(dataset.size); // 2
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @see {@link DatasetCore}
 */
export class GraphBuilder {
  readonly #baseIRI: string;
  readonly #quads:   Quad[] = [];

  #currentSubject: NamedNode | BlankNode | undefined;
  #currentGraph:   NamedNode | DefaultGraph;
  #dataset:        DatasetCore | undefined;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /**
   * Create a new `GraphBuilder` anchored to `baseIRI`.
   *
   * @remarks
   * The `baseIRI` is used as the resolution base for any relative subject or
   * predicate string passed to {@link subject} or {@link add}.  It must end
   * with `'/'` or `'#'` so that simple local names resolve unambiguously.
   *
   * @param baseIRI - Absolute IRI ending with `'/'` or `'#'`.
   * @throws {Error} When `baseIRI` does not end with `'/'` or `'#'`.
   *
   * @example
   * ```ts
   * // Valid — trailing slash
   * const b1 = new GraphBuilder('https://squashage.dev/instance/aonprd/');
   *
   * // Valid — trailing hash
   * const b2 = new GraphBuilder('https://example.org/ontology#');
   *
   * // Throws — no trailing delimiter
   * new GraphBuilder('https://example.org'); // Error
   * ```
   *
   * @category RDF
   * @since 2.2.0
   */
  constructor(baseIRI: string) {
    const last = baseIRI.at(-1);
    if (last !== '/' && last !== '#') {
      throw new Error(
        `GraphBuilder: baseIRI must end with '/' or '#' for proper IRI resolution. Got: ${JSON.stringify(baseIRI)}`,
      );
    }
    this.#baseIRI      = baseIRI;
    this.#currentGraph = dataFactory.defaultGraph();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Set the `DatasetCore` that {@link build} will flush quads into.
   *
   * @remarks
   * The dataset is stored by reference; quads are written to it when
   * {@link build} is called, not immediately.  `addTo` may be called at any
   * point in the chain — before or after {@link subject} and {@link add} calls.
   *
   * @param dataset - The `DatasetCore` instance to receive quads on {@link build}.
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * import { Dataset } from './Dataset.js';
   *
   * const ds = Dataset.empty();
   * new GraphBuilder('https://example.org/')
   *   .addTo(ds)
   *   .subject('foo')
   *   .add('https://schema.org/name', 'Foo')
   *   .build();
   *
   * console.log(ds.size); // 1
   * ```
   *
   * @category RDF
   * @since 2.2.0
   */
  public addTo(dataset: DatasetCore): GraphBuilder {
    this.#dataset = dataset;
    return this;
  }

  /**
   * Begin a subject statement at the given IRI or `NamedNode`.
   *
   * @remarks
   * When `iri` is a string:
   * - If it is already an absolute IRI (contains a scheme), it is used verbatim.
   * - Otherwise it is treated as a local name and resolved against `baseIRI`
   *   using `new URL(localName, baseIRI).href`.
   *
   * Subsequent calls to {@link add} will use this subject until the next
   * `subject()` call.
   *
   * @param iri - A local name, an absolute IRI string, or a `NamedNode`.
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * const b = new GraphBuilder('https://example.org/');
   *
   * // Local name — resolves to 'https://example.org/foo'
   * b.subject('foo');
   *
   * // Absolute IRI string — used verbatim
   * b.subject('https://other.org/bar');
   *
   * // NamedNode — used directly
   * import { dataFactory } from './DataFactory.js';
   * b.subject(dataFactory.namedNode('https://example.org/baz'));
   * ```
   *
   * @category RDF
   * @since 2.2.0
   */
  public subject(iri: string | NamedNode): GraphBuilder {
    if (typeof iri === 'string') {
      this.#currentSubject = dataFactory.namedNode(this.#resolveIRI(iri));
    } else {
      this.#currentSubject = iri;
    }
    return this;
  }

  /**
   * Add a predicate-object pair to the current subject in the current graph.
   *
   * @remarks
   * `predicate` follows the same resolution rules as {@link subject}: a string
   * without a scheme is resolved against `baseIRI`; an absolute IRI string or
   * `NamedNode` is used verbatim.
   *
   * `object` behaviour:
   * - `NamedNode`, `Literal`, or `BlankNode` — used directly (type information preserved).
   * - `string` — always treated as a plain `xsd:string` literal.
   *
   * The quad is buffered internally until {@link build} is called.
   *
   * @param predicate - Predicate as a local name, absolute IRI string, or `NamedNode`.
   * @param object    - Object as an RDF/JS term or a plain string (becomes literal).
   * @returns `this` for chaining.
   * @throws {Error} When {@link subject} has not been called before `add`.
   *
   * @example
   * ```ts
   * new GraphBuilder('https://example.org/')
   *   .subject('foo')
   *   .add('https://schema.org/name', 'Foo bar')          // xsd:string literal
   *   .add('https://schema.org/sameAs', dataFactory.namedNode('https://wikidata.org/entity/Q1'))
   *   .build();
   * ```
   *
   * @category RDF
   * @since 2.2.0
   */
  public add(
    predicate: string | NamedNode,
    object:    NamedNode | Literal | BlankNode | string,
  ): GraphBuilder {
    if (this.#currentSubject === undefined) {
      throw new Error(
        'GraphBuilder.add: no current subject — call subject() before add()',
      );
    }

    const predicateNode: NamedNode =
      typeof predicate === 'string'
        ? dataFactory.namedNode(this.#resolveIRI(predicate))
        : predicate;

    const objectTerm: NamedNode | Literal | BlankNode =
      typeof object === 'string'
        ? dataFactory.literal(object)
        : object;

    this.#quads.push(
      dataFactory.quad(this.#currentSubject, predicateNode, objectTerm, this.#currentGraph),
    );

    return this;
  }

  /**
   * Switch the named graph for subsequent quads.
   *
   * @remarks
   * All quads emitted after this call (until the next `graph()` call) will use
   * the specified graph term.  Pass `dataFactory.defaultGraph()` to revert to
   * the default graph.
   *
   * Quads already buffered before this call are not affected.
   *
   * @param namedGraph - The `NamedNode` or `DefaultGraph` to use for subsequent quads.
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * import { dataFactory } from './DataFactory.js';
   *
   * const g1 = dataFactory.namedNode('https://example.org/graph/one');
   * const g2 = dataFactory.namedNode('https://example.org/graph/two');
   *
   * new GraphBuilder('https://example.org/')
   *   .graph(g1)
   *   .subject('foo')
   *   .add('https://schema.org/name', 'Foo')  // quad in g1
   *   .graph(g2)
   *   .subject('bar')
   *   .add('https://schema.org/name', 'Bar')  // quad in g2
   *   .build();
   * ```
   *
   * @category RDF
   * @since 2.2.0
   */
  public graph(namedGraph: NamedNode | DefaultGraph): GraphBuilder {
    this.#currentGraph = namedGraph;
    return this;
  }

  /**
   * Materialize all pending quads into the configured dataset and return the count emitted.
   *
   * @remarks
   * Flushes the internal quad buffer into the `DatasetCore` set via {@link addTo}.
   * Each quad is added via `dataset.add(quad)`.  After this call the internal
   * buffer is cleared, so subsequent calls to `build()` emit only quads added
   * since the last `build()`.
   *
   * If no dataset has been set via {@link addTo}, the quads are discarded and
   * the count of buffered quads is still returned (useful for testing quad
   * construction logic without a dataset).
   *
   * @returns The number of quads flushed in this call.
   *
   * @example
   * ```ts
   * import { Dataset } from './Dataset.js';
   *
   * const ds = Dataset.empty();
   * const count = new GraphBuilder('https://example.org/')
   *   .addTo(ds)
   *   .subject('foo')
   *   .add('https://schema.org/name', 'Foo')
   *   .build();
   *
   * console.log(count);   // 1
   * console.log(ds.size); // 1
   * ```
   *
   * @category RDF
   * @since 2.2.0
   */
  public build(): number {
    const count = this.#quads.length;

    if (this.#dataset !== undefined) {
      for (const quad of this.#quads) {
        this.#dataset.add(quad);
      }
    }

    this.#quads.length = 0;
    return count;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve a local name or IRI string to an absolute IRI.
   *
   * @remarks
   * When the input is already an absolute IRI (detected via {@link IRIUtils.isAbsolute}),
   * it is returned verbatim.  Otherwise it is resolved against `baseIRI` using
   * `new URL(ref, base).href` per RFC 3986 §5.2.
   *
   * @param nameOrIRI - A local name or absolute IRI string.
   * @returns The resolved absolute IRI.
   */
  #resolveIRI(nameOrIRI: string): string {
    if (IRIUtils.isAbsolute(nameOrIRI)) {
      return nameOrIRI;
    }
    return new URL(nameOrIRI, this.#baseIRI).href;
  }
}
