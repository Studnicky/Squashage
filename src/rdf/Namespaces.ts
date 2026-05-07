/**
 * @fileoverview Namespace Proxy factory, IRI utilities, and standard prefix table.
 *
 * This module is the v0.x wrapper around `@rdfjs/namespace`. Application code
 * imports from here — never from `@rdfjs/namespace` directly. The boundary is
 * enforced by the `no-restricted-imports` ESLint rule in `eslint.config.mjs`.
 *
 * @module rdf/Namespaces
 * @since 0.1.0
 */

import type { NamedNode } from '@rdfjs/types';
import namespace from '@rdfjs/namespace';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Proxy returned by {@link Namespaces.for} — any property access appends the
 * property name to the base IRI and returns a `NamedNode`.
 *
 * @remarks
 * A `NamespaceBuilder` is also callable: `builder('term')` returns the same
 * `NamedNode` as `builder.term`.  Both access paths are typed here.
 *
 * @example
 * ```ts
 * const ex = Namespaces.for('http://example.org/');
 * ex.Foo.value   // 'http://example.org/Foo'
 * ex('Bar').value // 'http://example.org/Bar'
 * ```
 *
 * @category RDF
 * @since 0.1.0
 */
export type NamespaceBuilder = ((term: string) => NamedNode) & { readonly [P: string]: NamedNode };

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/**
 * Static factory for namespace Proxies backed by `@rdfjs/namespace`.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated.
 * The returned {@link NamespaceBuilder} Proxy delegates every property lookup
 * and every call to `@rdfjs/data-model`'s `namedNode` factory, so any
 * property access produces a well-formed `NamedNode` whose `.value` is
 * `baseIRI + propertyName`.
 *
 * @example
 * ```ts
 * const EX = Namespaces.for('http://example.org/');
 * EX.Person.value // 'http://example.org/Person'
 * ```
 *
 * @category RDF
 * @since 0.1.0
 */
export class Namespaces {
  private constructor() { /* static-only */ }

  /**
   * Builds a namespace Proxy for the given base IRI.
   *
   * @param baseIRI - Base IRI for the namespace.  Must end with `'/'` or `'#'`.
   * @returns A {@link NamespaceBuilder} Proxy where any property access returns
   *   a `NamedNode` whose `.value` is `baseIRI + property`.
   * @throws {Error} When `baseIRI` does not end with `'/'` or `'#'`.
   *
   * @example
   * ```ts
   * const SCHEMA = Namespaces.for('https://schema.org/');
   * SCHEMA.Person.value // 'https://schema.org/Person'
   * ```
   */
  public static for(baseIRI: string): NamespaceBuilder {
    const last = baseIRI.at(-1);
    if (last !== '/' && last !== '#') {
      throw new Error(
        `Namespaces.for: baseIRI must end with '/' or '#', got: ${JSON.stringify(baseIRI)}`,
      );
    }
    return namespace(baseIRI) as NamespaceBuilder;
  }
}

// ---------------------------------------------------------------------------
// IRIUtils
// ---------------------------------------------------------------------------

/**
 * Static utilities for IRI manipulation.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated.
 * None of these methods perform network I/O or maintain state.
 *
 * @example
 * ```ts
 * IRIUtils.slug('Hello World!')  // 'hello-world'
 * IRIUtils.join('http://x.org/a', 'b') // 'http://x.org/a/b'
 * IRIUtils.isAbsolute('http://x.org') // true
 * IRIUtils.normalize('http://x.org/a/../b') // 'http://x.org/b'
 * ```
 *
 * @category RDF
 * @since 0.1.0
 */
export class IRIUtils {
  private constructor() { /* static-only */ }

  /**
   * Converts an arbitrary string to a URL-safe slug.
   *
   * @param s - Input string to slugify.
   * @returns Lowercase string with non-alphanumeric runs replaced by `'-'`,
   *   leading and trailing hyphens trimmed.
   *
   * @example
   * ```ts
   * IRIUtils.slug('Hello World!')  // 'hello-world'
   * IRIUtils.slug('  foo--bar  ') // 'foo-bar'
   * ```
   */
  public static slug(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Joins a base IRI and a fragment, ensuring exactly one `'/'` or `'#'`
   * boundary between them.
   *
   * @param base - Base IRI.
   * @param frag - Fragment to append.
   * @returns `base + frag` when `base` already ends with `'/'` or `'#'`;
   *   otherwise `base + '/' + frag`.
   *
   * @example
   * ```ts
   * IRIUtils.join('http://x.org/',  'a') // 'http://x.org/a'
   * IRIUtils.join('http://x.org#',  'a') // 'http://x.org#a'
   * IRIUtils.join('http://x.org',   'a') // 'http://x.org/a'
   * ```
   */
  public static join(base: string, frag: string): string {
    const last = base.at(-1);
    return (last === '/' || last === '#') ? `${base}${frag}` : `${base}/${frag}`;
  }

  /**
   * Returns `true` when the IRI contains a scheme component.
   *
   * @param iri - IRI string to test.
   * @returns `true` if `iri` starts with a scheme such as `http:`, `urn:`,
   *   `file:`, etc.
   *
   * @example
   * ```ts
   * IRIUtils.isAbsolute('http://example.org') // true
   * IRIUtils.isAbsolute('relative/path')       // false
   * ```
   */
  public static isAbsolute(iri: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(iri);
  }

  /**
   * Normalises an IRI by running it through the `URL` constructor.
   *
   * @param iri - Absolute IRI to normalise.
   * @returns The serialised form of the parsed URL (percent-encoding
   *   normalised, path segments resolved).
   * @throws {TypeError} When `iri` is not a valid absolute URL.
   *
   * @example
   * ```ts
   * IRIUtils.normalize('HTTP://Example.ORG/a/../b') // 'http://example.org/b'
   * ```
   */
  public static normalize(iri: string): string {
    return new URL(iri).href;
  }
}

// ---------------------------------------------------------------------------
// BaseIRIResolver
// ---------------------------------------------------------------------------

/**
 * RFC 3986 reference resolution via the platform `URL` constructor.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated.
 * Resolution follows the same algorithm as browsers and Node's `URL` — a
 * relative reference is resolved against the base IRI according to RFC 3986
 * §5.2.
 *
 * @example
 * ```ts
 * BaseIRIResolver.resolve('http://x.org/a/b', 'c')     // 'http://x.org/a/c'
 * BaseIRIResolver.resolve('http://x.org/a/b', '../d')  // 'http://x.org/d'
 * BaseIRIResolver.resolve('http://x.org/a/b', 'http://y.org/z') // 'http://y.org/z'
 * ```
 *
 * @category RDF
 * @since 0.1.0
 */
export class BaseIRIResolver {
  private constructor() { /* static-only */ }

  /**
   * Resolves `ref` against `base` using RFC 3986 reference resolution.
   *
   * @param base - Absolute base IRI.
   * @param ref  - IRI reference (absolute or relative) to resolve.
   * @returns The resolved absolute IRI string.
   * @throws {Error} When `base` is not a valid absolute URL or resolution
   *   fails for any reason.
   *
   * @example
   * ```ts
   * BaseIRIResolver.resolve('http://x.org/a/b', 'c')    // 'http://x.org/a/c'
   * BaseIRIResolver.resolve('http://x.org/',    '#foo') // 'http://x.org/#foo'
   * ```
   */
  public static resolve(base: string, ref: string): string {
    try {
      return new URL(ref, base).href;
    } catch (err) {
      throw new Error(
        `BaseIRIResolver.resolve: cannot resolve ${JSON.stringify(ref)} against ${JSON.stringify(base)}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}

// STANDARD_PREFIXES was previously exported from this module (W4 placeholder).
// The canonical export has been moved to src/rdf/Vocab.ts, which is the single
// authoritative source consumed by the serializer.  Import from there instead:
//   import { STANDARD_PREFIXES } from './Vocab.js';
