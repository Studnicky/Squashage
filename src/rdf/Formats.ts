/**
 * @fileoverview RDF format identifiers, extension/MIME tables, and the
 * {@link Formats} static-utility class for resolving and inspecting them.
 *
 * Five formats are supported in v0.x (Turtle, TriG, N-Triples, N-Quads,
 * JSON-LD).  RDF/XML and N3 output are deferred to v1.x when the semantics
 * workspace is consumed.
 *
 * @module rdf/Formats
 * @since 2.2.0
 */

/**
 * Supported RDF serialization format identifiers for v0.x.
 *
 * @remarks
 * The literal union maps 1-to-1 with the `output.format` config field.
 * RDF/XML (`rdfxml`) and N3 (`n3`) output are omitted in v0.x — no
 * maintained streaming serializer exists for either on npm at this time.
 * They return in v1.x when the `@semantics/rdf-io` workspace is consumed.
 *
 * @example
 * ```ts
 * const fmt: RDFFormat = 'turtle';
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @see {@link Formats}
 * @group Types
 */
export type RDFFormat = 'turtle' | 'trig' | 'ntriples' | 'nquads' | 'jsonld';

/**
 * Default file extension for each supported RDF format.
 *
 * @remarks
 * Used by `Formats.extensionForFormat` and as the fallback when no explicit
 * `output.format` is provided — the extension of the configured output path
 * determines the format.
 *
 * @example
 * ```ts
 * const ext = FILE_EXTENSIONS['turtle']; // '.ttl'
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @see {@link Formats}
 * @group Constants
 */
export const FILE_EXTENSIONS: Readonly<Record<RDFFormat, string>> = Object.freeze({
  turtle:   '.ttl',
  trig:     '.trig',
  ntriples: '.nt',
  nquads:   '.nq',
  jsonld:   '.jsonld',
} as const);

/**
 * MIME type for each supported RDF format.
 *
 * @remarks
 * Used for HTTP content-type negotiation and for labelling output reports.
 * Values follow the IANA registrations as of 2024.
 *
 * @example
 * ```ts
 * const mime = MIME_TYPES['jsonld']; // 'application/ld+json'
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @see {@link Formats}
 * @group Constants
 */
export const MIME_TYPES: Readonly<Record<RDFFormat, string>> = Object.freeze({
  turtle:   'text/turtle',
  trig:     'application/trig',
  ntriples: 'application/n-triples',
  nquads:   'application/n-quads',
  jsonld:   'application/ld+json',
} as const);

/**
 * Ordered list of all supported RDF formats.
 *
 * @remarks
 * Order reflects the v0.x priority used by the output dispatcher: Turtle
 * family first (triple-only before quad-capable), JSON-LD last.
 *
 * @example
 * ```ts
 * for (const fmt of RDF_FORMATS) { /* ... *\/ }
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @see {@link Formats}
 * @group Constants
 */
export const RDF_FORMATS: ReadonlyArray<RDFFormat> = Object.freeze([
  'turtle',
  'trig',
  'ntriples',
  'nquads',
  'jsonld',
] as const);

/**
 * Static-only utility for resolving and inspecting RDF format identifiers.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated.  Format
 * resolution is done by matching a file path's extension against the
 * {@link FILE_EXTENSIONS} table.  MIME and quad-capability look-ups
 * delegate to {@link MIME_TYPES} and a small hard-coded set.
 *
 * Application code should import from this class rather than from the
 * `FILE_EXTENSIONS` / `MIME_TYPES` constants directly so that the v1.x
 * migration to `@semantics/rdf-formats` can be done by changing only this
 * file.
 *
 * @example
 * ```ts
 * const fmt = Formats.formatFromExtension('aonprd.jsonld'); // 'trig'
 * const ext  = Formats.extensionForFormat('jsonld');          // '.jsonld'
 * const mime = Formats.mimeForFormat('nquads');               // 'application/n-quads'
 * const ok   = Formats.supportsQuads('trig');                 // true
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @see {@link FILE_EXTENSIONS}
 * @see {@link MIME_TYPES}
 * @see {@link RDF_FORMATS}
 * @group Core
 */
export class Formats {
  private constructor() { /* static-only */ }

  /**
   * Resolve an {@link RDFFormat} from a file path's extension.
   *
   * @remarks
   * Extracts the extension via `path.slice(path.lastIndexOf('.'))` and
   * matches it against {@link FILE_EXTENSIONS} after lower-casing.
   * Returns `undefined` for unrecognised extensions.
   *
   * @param path - File path or bare extension string (e.g. `'out.ttl'`).
   * @returns The matching {@link RDFFormat}, or `undefined` if unknown.
   *
   * @example
   * ```ts
   * Formats.formatFromExtension('aonprd.jsonld'); // 'trig'
   * Formats.formatFromExtension('data.TTL');        // 'turtle'
   * Formats.formatFromExtension('data.csv');        // undefined
   * ```
   */
  public static formatFromExtension(path: string): RDFFormat | undefined {
    const dotIdx = path.lastIndexOf('.');
    if (dotIdx === -1) return undefined;
    const ext = path.slice(dotIdx).toLowerCase();
    for (const fmt of RDF_FORMATS) {
      if (FILE_EXTENSIONS[fmt] === ext) return fmt;
    }
    return undefined;
  }

  /**
   * Default extension for a given format (mirrors {@link FILE_EXTENSIONS}).
   *
   * @param format - A supported {@link RDFFormat}.
   * @returns The canonical file extension including the leading dot.
   *
   * @example
   * ```ts
   * Formats.extensionForFormat('jsonld'); // '.jsonld'
   * ```
   */
  public static extensionForFormat(format: RDFFormat): string {
    return FILE_EXTENSIONS[format];
  }

  /**
   * MIME type for a given format (mirrors {@link MIME_TYPES}).
   *
   * @param format - A supported {@link RDFFormat}.
   * @returns The canonical MIME type string.
   *
   * @example
   * ```ts
   * Formats.mimeForFormat('nquads'); // 'application/n-quads'
   * ```
   */
  public static mimeForFormat(format: RDFFormat): string {
    return MIME_TYPES[format];
  }

  /**
   * Whether the given format supports named-graph quads.
   *
   * @remarks
   * Quad-capable formats: `trig`, `nquads`, `jsonld`.
   * Triple-only formats:  `turtle`, `ntriples`.
   *
   * If a target emits named graphs and a triple-only format is requested,
   * the output dispatcher should fail fast unless `output.graph` is set to
   * collapse quads to a single graph.
   *
   * @param format - A supported {@link RDFFormat}.
   * @returns `true` when the format can encode multiple named graphs.
   *
   * @example
   * ```ts
   * Formats.supportsQuads('trig');     // true
   * Formats.supportsQuads('turtle');   // false
   * Formats.supportsQuads('jsonld');   // true
   * ```
   */
  public static supportsQuads(format: RDFFormat): boolean {
    const QUAD_CAPABLE: ReadonlyArray<RDFFormat> = ['trig', 'nquads', 'jsonld'];
    return QUAD_CAPABLE.includes(format);
  }

  /**
   * Type guard narrowing `unknown` to {@link RDFFormat}.
   *
   * @param value - Value to test.
   * @returns `true` when `value` is one of the five supported format strings.
   *
   * @example
   * ```ts
   * Formats.isRdfFormat('turtle');  // true
   * Formats.isRdfFormat('rdfxml');  // false
   * Formats.isRdfFormat(42);        // false
   * ```
   */
  public static isRdfFormat(value: unknown): value is RDFFormat {
    return typeof value === 'string' && (RDF_FORMATS as ReadonlyArray<string>).includes(value);
  }
}
