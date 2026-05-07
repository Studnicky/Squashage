/**
 * Ambient module shim for `jsonld`.
 *
 * `jsonld` v9.x ships as pure JavaScript with no bundled TypeScript
 * declarations and no community `@types/jsonld` package covers v9.
 * This shim covers the one surface squashage uses: `jsonld.toRDF()` with
 * `{ format: 'application/n-quads' }` returns a Promise<string>.
 *
 * This file follows the `*-shim.d.ts` naming convention that the `.gitignore`
 * negation rule (`!src/**\/*-shim.d.ts`) allows to be committed.
 *
 * When v1.x swaps to `@semantics/rdf-io` (which ships its own declarations)
 * this file and the corresponding `jsonld` dependency are removed.
 *
 * @since 2.2.0
 */

declare module 'jsonld' {
  /** Options accepted by {@link jsonld.toRDF}. */
  interface ToRdfOptions {
    /** Output serialization format.  Pass `'application/n-quads'` to get a string back. */
    format?: string;
    /** Base IRI applied during expansion. */
    base?: string;
  }

  /** Options accepted by {@link jsonld.fromRDF}. */
  interface FromRdfOptions {
    /**
     * Input serialization format.  Pass `'application/n-quads'` when the
     * dataset argument is an N-Quads string.
     */
    format?: string;
    /** Whether to use the RDF 1.1 datatypes rules. */
    useNativeTypes?: boolean;
    /** Whether to use the `@vocab` mapping for predicates. */
    useRdfType?: boolean;
  }

  /** Options accepted by {@link jsonld.compact}. */
  interface CompactOptions {
    /** Base IRI to use during compaction. */
    base?: string;
    /** Whether to compact arrays to single values when appropriate (default: true). */
    compactArrays?: boolean;
  }

  /**
   * Converts a JSON-LD document to RDF.
   *
   * When `options.format` is `'application/n-quads'` the return type is `string`
   * (an N-Quads serialisation).  Otherwise an RDF dataset object is returned.
   */
  function toRDF(input: unknown, options?: ToRdfOptions): Promise<string>;

  /**
   * Converts an RDF dataset to a JSON-LD document.
   *
   * When `dataset` is a string and `options.format` is `'application/n-quads'`
   * the string is interpreted as N-Quads text and the result is a JSON-LD
   * array (expanded form).
   */
  function fromRDF(dataset: unknown, options?: FromRdfOptions): Promise<unknown>;

  /**
   * Compacts a JSON-LD document using the supplied context.
   *
   * @param input   - Expanded JSON-LD document (output of {@link fromRDF}).
   * @param ctx     - Compaction context object.
   * @param options - Optional compaction options.
   * @returns Promise resolving to the compacted JSON-LD document.
   */
  function compact(input: unknown, ctx: unknown, options?: CompactOptions): Promise<Record<string, unknown>>;

  export { toRDF, fromRDF, compact };
}
