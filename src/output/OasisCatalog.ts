/**
 * @fileoverview `OasisCatalog` — pure XML builder for OASIS XML Catalogs 1.1.
 *
 * @remarks
 * Generates conformant OASIS XML Catalog 1.1 documents per the specification:
 * https://www.oasis-open.org/committees/entity/spec-2005-07-15.html
 *
 * The builder is pure — no I/O, no side effects. Call `OasisCatalog.build()`
 * to obtain an XML string; writing to disk is the caller's responsibility.
 *
 * Supported elements:
 * - `<catalog>` root with namespace and `prefer` attribute.
 * - `<uri>` — maps a named-graph IRI to a relative file path.
 * - `<rewriteURI>` — prefix rewrite for namespace-rooted graph families.
 * - `<system>` — maps a system-ID to a local file (JSON-LD contexts).
 * - `<public>` — maps a public-ID to a local file (ontology files).
 * - `<systemSuffix>` — suffix-based mapping.
 *
 * All attribute values are XML-escaped. Relative paths use forward slashes.
 *
 * @module output/OasisCatalog
 * @category Output
 * @since 0.7.0
 */

// ---------------------------------------------------------------------------
// Entry types
// ---------------------------------------------------------------------------

/**
 * A `<uri>` catalog entry — maps a named-graph IRI to a relative file path.
 *
 * @category Output
 * @since 0.7.0
 * @group Types
 */
export interface UriEntryInterface {
  readonly kind:  'uri';
  /** The named-graph IRI (the public identifier). */
  readonly name:  string;
  /** Relative path from the catalog to the file (forward slashes). */
  readonly uri:   string;
}

/**
 * A `<rewriteURI>` catalog entry — rewrites an IRI prefix to a local prefix.
 *
 * @category Output
 * @since 0.7.0
 * @group Types
 */
export interface RewriteUriEntryInterface {
  readonly kind:          'rewriteURI';
  readonly uriStartString: string;
  readonly rewritePrefix:  string;
}

/**
 * A `<system>` catalog entry — maps a system-ID to a local file.
 *
 * @category Output
 * @since 0.7.0
 * @group Types
 */
export interface SystemEntryInterface {
  readonly kind:     'system';
  readonly systemId: string;
  readonly uri:      string;
}

/**
 * A `<public>` catalog entry — maps a public-ID to a local file.
 *
 * @category Output
 * @since 0.7.0
 * @group Types
 */
export interface PublicEntryInterface {
  readonly kind:     'public';
  readonly publicId: string;
  readonly uri:      string;
}

/**
 * A `<systemSuffix>` catalog entry — maps files by suffix.
 *
 * @category Output
 * @since 0.7.0
 * @group Types
 */
export interface SystemSuffixEntryInterface {
  readonly kind:           'systemSuffix';
  readonly systemIdSuffix: string;
  readonly uri:            string;
}

/**
 * Union of all supported catalog entry types.
 *
 * @category Output
 * @since 0.7.0
 * @group Types
 */
export type CatalogEntryInterface =
  | UriEntryInterface
  | RewriteUriEntryInterface
  | SystemEntryInterface
  | PublicEntryInterface
  | SystemSuffixEntryInterface;

// ---------------------------------------------------------------------------
// BuildOptions
// ---------------------------------------------------------------------------

/**
 * Options controlling the structure of the generated catalog document.
 *
 * @category Output
 * @since 0.7.0
 * @group Types
 */
export interface CatalogBuildOptionsInterface {
  /** `prefer` attribute on the root `<catalog>` element. Default: `'public'`. */
  readonly prefer?: 'public' | 'system' | undefined;
}

// ---------------------------------------------------------------------------
// OasisCatalog class
// ---------------------------------------------------------------------------

/** OASIS XML Catalogs 1.1 namespace URI. */
const OASIS_NS = 'urn:oasis:names:tc:entity:xmlns:xml:catalog';

/**
 * Static-only builder for OASIS XML Catalog 1.1 documents.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated. No I/O is
 * performed — the class is pure, deterministic, and safe to call in tests
 * without touching the filesystem.
 *
 * @example
 * ```ts
 * const xml = OasisCatalog.build([
 *   { kind: 'uri', name: 'https://example.org/graph/feats', uri: './graph-feats.trig' },
 *   { kind: 'rewriteURI', uriStartString: 'https://example.org/graph/', rewritePrefix: './' },
 * ], { prefer: 'public' });
 * await fs.writeFile('./aonprd.catalog.xml', xml, 'utf8');
 * ```
 *
 * @category Output
 * @since 0.7.0
 * @see {@link CatalogEntryInterface}
 * @group Core
 */
export class OasisCatalog {
  private constructor() { /* static-only */ }

  /**
   * Builds an OASIS XML Catalog 1.1 document string from a list of entries.
   *
   * @remarks
   * The document is well-formed XML with:
   * - XML declaration (`<?xml version="1.0" encoding="UTF-8"?>`)
   * - `<catalog>` root element in the OASIS namespace
   * - One child element per entry
   *
   * All attribute values are XML-escaped. Entries are emitted in the order
   * provided.
   *
   * @param entries - Ordered list of catalog entries to include.
   * @param options - Optional build options.
   * @returns A UTF-8 XML string.
   *
   * @example
   * ```ts
   * const xml = OasisCatalog.build([
   *   { kind: 'uri', name: 'https://example.org/graph/a', uri: './graph-a.trig' },
   * ]);
   * ```
   */
  public static build(
    entries: ReadonlyArray<CatalogEntryInterface>,
    options: CatalogBuildOptionsInterface = {},
  ): string {
    const prefer = options.prefer ?? 'public';
    const lines: string[] = [];

    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push(`<catalog xmlns="${OasisCatalog.escape(OASIS_NS)}" prefer="${OasisCatalog.escape(prefer)}">`);

    for (const entry of entries) {
      lines.push(`  ${OasisCatalog.#renderEntry(entry)}`);
    }

    lines.push('</catalog>');
    return lines.join('\n') + '\n';
  }

  /**
   * XML-escapes a string for use in an attribute value or text content.
   *
   * @remarks
   * Escapes `&`, `<`, `>`, `"`, and `'`. Safe to use in both attribute
   * values (double-quoted) and text content.
   *
   * @param value - The raw string to escape.
   * @returns The XML-safe string.
   *
   * @example
   * ```ts
   * OasisCatalog.escape('https://example.org/graph/a&b'); // 'https://example.org/graph/a&amp;b'
   * OasisCatalog.escape('"quoted"'); // '&quot;quoted&quot;'
   * ```
   */
  public static escape(value: string): string {
    return value
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&apos;');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Renders a single catalog entry to its XML element string.
   */
  static #renderEntry(entry: CatalogEntryInterface): string {
    switch (entry.kind) {
      case 'uri':
        return `<uri name="${OasisCatalog.escape(entry.name)}" uri="${OasisCatalog.escape(entry.uri)}"/>`;

      case 'rewriteURI':
        return `<rewriteURI uriStartString="${OasisCatalog.escape(entry.uriStartString)}" rewritePrefix="${OasisCatalog.escape(entry.rewritePrefix)}"/>`;

      case 'system':
        return `<system systemId="${OasisCatalog.escape(entry.systemId)}" uri="${OasisCatalog.escape(entry.uri)}"/>`;

      case 'public':
        return `<public publicId="${OasisCatalog.escape(entry.publicId)}" uri="${OasisCatalog.escape(entry.uri)}"/>`;

      case 'systemSuffix':
        return `<systemSuffix systemIdSuffix="${OasisCatalog.escape(entry.systemIdSuffix)}" uri="${OasisCatalog.escape(entry.uri)}"/>`;
    }
  }
}
