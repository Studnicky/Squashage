/**
 * @fileoverview `Bucketer` — pure static class for named-graph classification
 * and filename derivation in the bucketing output path.
 *
 * @remarks
 * `Bucketer` is stateless and performs no I/O. It classifies a set of quads
 * into per-bucket groups and derives deterministic output filenames for each
 * bucket based on the configured strategy.
 *
 * **Filename derivation pipeline (per-graph-iri strategy):**
 * 1. Default graph → `bucketing.defaultGraphFilename` (default `"default"`).
 * 2. Named graph → decode URI, strip scheme + authority, normalise path
 *    segments to a slug (alphanumeric, dots, hyphens only), truncate to 128
 *    chars, append `-<sha1[0:6]>` on collision or empty slug.
 * 3. Append file extension from `Formats.extensionForFormat(format)`.
 *
 * **per-config-bucket strategy:** the `buckets` map (graphIRI → stem) is used
 * directly; unrecognised graphs route to `__other`, are dropped, or fail per
 * `bucketing.onUnmapped`.
 *
 * @module output/Bucketer
 * @category Output
 * @since 0.7.0
 */

import { createHash }   from 'node:crypto';
import { join }         from 'node:path';
import type { Quad }    from '@rdfjs/types';
import type { RDFFormat } from '../rdf/Formats.js';
import { Formats }      from '../rdf/Formats.js';
import { Logger }       from '../modules/logger/logger.js';

const log = Logger.forComponent('Bucketer');

// ---------------------------------------------------------------------------
// Bucketing config type (subset used by Bucketer — avoids importing the full
// OutputConfigInterface so this module stays pure).
// ---------------------------------------------------------------------------

/**
 * Minimal bucketing config surface consumed by {@link Bucketer}.
 *
 * @category Output
 * @since 0.7.0
 * @group Types
 */
export interface BucketingConfigInterface {
  readonly enabled:               boolean;
  readonly strategy?:             'per-graph-iri' | 'per-config-bucket';
  readonly defaultGraphFilename?: string | undefined;
  readonly defaultGraphCatalogIri?: string | undefined;
  readonly buckets?:              Readonly<Record<string, string>> | undefined;
  readonly onUnmapped?:           'other' | 'drop' | 'fail' | undefined;
  readonly maxOpenFiles?:         number | undefined;
}

// ---------------------------------------------------------------------------
// BucketReportInterface
// ---------------------------------------------------------------------------

/**
 * Per-bucket report entry in {@link OutputReportInterface.buckets}.
 *
 * @category Output
 * @since 0.7.0
 * @group Types
 */
export interface BucketReportInterface {
  /** Bucket key: the graph IRI string, or `'__default__'` for default graph, or `'__other__'` for unmapped. */
  readonly bucketKey:    string;
  /** Absolute path written, or `null` when the bucket was empty. */
  readonly path:         string | null;
  /** Graph IRI, or `null` for the default graph. */
  readonly graphIri:     string | null;
  /** Filename stem derived for this bucket (no extension). */
  readonly stem:         string;
  /** RDF format used. */
  readonly format:       RDFFormat;
  /** Number of quads in this bucket. */
  readonly quadCount:    number;
  /** Bytes written, or `0` when empty. */
  readonly bytesWritten: number;
}

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

/** Internal constant for the default-graph bucket key. */
export const DEFAULT_GRAPH_KEY = '__default__' as const;
/** Internal constant for the unmapped-graphs overflow bucket key. */
export const OTHER_BUCKET_KEY  = '__other__' as const;

/** The built stem + full filename for one bucket. */
export interface BucketFilenameInterface {
  /** Filename stem without extension. */
  readonly stem:     string;
  /** Full filename including extension. */
  readonly filename: string;
  /** Full absolute path (bucketDir/filename). */
  readonly path:     string;
}

// ---------------------------------------------------------------------------
// Bucketer class
// ---------------------------------------------------------------------------

/**
 * Static-only utility for named-graph classification and filename derivation.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated. No I/O is
 * performed — the class is pure, deterministic, and safe to call in tests
 * without touching the filesystem.
 *
 * @example
 * ```ts
 * const groups = Bucketer.classify(quads, bucketing);
 * for (const [key, groupQuads] of groups) {
 *   const file = Bucketer.filenameFor(key, format, bucketing, bucketDir);
 *   await writeFile(file.path, serialize(groupQuads));
 * }
 * ```
 *
 * @category Output
 * @since 0.7.0
 * @see {@link BucketingConfigInterface}
 * @group Core
 */
export class Bucketer {
  private constructor() { /* static-only */ }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Classifies quads into per-bucket groups.
   *
   * @remarks
   * Returns a `Map` keyed by bucket key string:
   * - Named graph → the graph IRI string.
   * - Default graph → `DEFAULT_GRAPH_KEY` (`"__default__"`).
   * - Unmapped graph (per-config-bucket strategy) → `OTHER_BUCKET_KEY`
   *   (`"__other__"`), dropped (empty), or a thrown {@link Error} depending on
   *   `bucketing.onUnmapped`.
   *
   * @param quads     - Quads to classify.
   * @param bucketing - Validated bucketing config.
   * @returns Map from bucket key to array of quads.
   * @throws {Error} When `onUnmapped === 'fail'` and an unmapped graph is found.
   */
  public static classify(
    quads:     ReadonlyArray<Quad>,
    bucketing: BucketingConfigInterface,
  ): Map<string, Quad[]> {
    const groups = new Map<string, Quad[]>();
    const strategy = bucketing.strategy ?? 'per-graph-iri';

    for (const quad of quads) {
      const key = Bucketer.#bucketKeyFor(quad, bucketing, strategy);
      if (key === null) continue; // dropped

      let bucket = groups.get(key);
      if (bucket === undefined) {
        bucket = [];
        groups.set(key, bucket);
      }
      bucket.push(quad);
    }

    log.debug('classify', 'Classified quads into buckets', {
      totalQuads:   quads.length,
      bucketCount:  groups.size,
      strategy,
    });

    return groups;
  }

  /**
   * Derives the bucket filename (stem, full filename, absolute path) for one
   * bucket key.
   *
   * @param bucketKey  - The key returned by {@link Bucketer.classify}.
   * @param format     - The output RDF format.
   * @param bucketing  - Validated bucketing config.
   * @param bucketDir  - Absolute path to the bucket root directory.
   * @param allKeys    - All bucket keys in this run (used for collision detection in
   *   per-graph-iri strategy). Pass the full key set from `classify()` results.
   * @returns The derived filename information.
   */
  public static filenameFor(
    bucketKey: string,
    format:    RDFFormat,
    bucketing: BucketingConfigInterface,
    bucketDir: string,
    allKeys:   ReadonlySet<string>,
  ): BucketFilenameInterface {
    const stem = Bucketer.#stemFor(bucketKey, bucketing, allKeys);
    const ext  = Formats.extensionForFormat(format);
    const filename = `${stem}${ext}`;
    const path = join(bucketDir, filename);

    return { stem, filename, path };
  }

  /**
   * Derives just the stem (no extension, no directory) for a bucket key.
   *
   * @remarks
   * Useful for building the catalog IRI → path mapping without needing the
   * full bucket dir.
   *
   * @param bucketKey  - The bucket key.
   * @param bucketing  - Validated bucketing config.
   * @param allKeys    - All bucket keys (for collision detection).
   * @returns The filename stem string.
   */
  public static stemFor(
    bucketKey: string,
    bucketing: BucketingConfigInterface,
    allKeys:   ReadonlySet<string>,
  ): string {
    return Bucketer.#stemFor(bucketKey, bucketing, allKeys);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Determines the bucket key for a single quad.
   *
   * Returns `null` when the quad should be dropped (onUnmapped === 'drop').
   * Throws when the quad is unmapped and onUnmapped === 'fail'.
   */
  static #bucketKeyFor(
    quad:      Quad,
    bucketing: BucketingConfigInterface,
    strategy:  'per-graph-iri' | 'per-config-bucket',
  ): string | null {
    const term = quad.graph;

    // Default graph
    if (term.termType === 'DefaultGraph') {
      return DEFAULT_GRAPH_KEY;
    }

    const iri = term.value;

    if (strategy === 'per-config-bucket') {
      const buckets = bucketing.buckets ?? {};
      if (Object.prototype.hasOwnProperty.call(buckets, iri)) {
        return iri;
      }
      // Not in map
      const onUnmapped = bucketing.onUnmapped ?? 'other';
      if (onUnmapped === 'fail') {
        throw new Error(
          `Bucketer: graph IRI "${iri}" is not mapped in bucketing.buckets and onUnmapped is "fail"`,
        );
      }
      if (onUnmapped === 'drop') {
        log.warn('classify', 'Dropping quad with unmapped graph IRI', { iri });
        return null;
      }
      // 'other'
      return OTHER_BUCKET_KEY;
    }

    // per-graph-iri: key is the IRI itself
    return iri;
  }

  /**
   * Derives the filename stem for a given bucket key.
   */
  static #stemFor(
    bucketKey: string,
    bucketing: BucketingConfigInterface,
    allKeys:   ReadonlySet<string>,
  ): string {
    const strategy = bucketing.strategy ?? 'per-graph-iri';

    // Default graph
    if (bucketKey === DEFAULT_GRAPH_KEY) {
      return bucketing.defaultGraphFilename ?? 'default';
    }

    // Overflow bucket
    if (bucketKey === OTHER_BUCKET_KEY) {
      return '__other';
    }

    // per-config-bucket: use the mapped stem
    if (strategy === 'per-config-bucket') {
      const buckets = bucketing.buckets ?? {};
      const mapped  = buckets[bucketKey];
      if (mapped !== undefined && mapped.length > 0) {
        return mapped;
      }
      // Fallback to IRI slug if no mapping found (shouldn't happen if classify ran first)
      return Bucketer.#slugifyIri(bucketKey, allKeys);
    }

    // per-graph-iri: slugify
    return Bucketer.#slugifyIri(bucketKey, allKeys);
  }

  /**
   * Converts a graph IRI to a safe filename stem.
   *
   * Pipeline:
   * 1. `decodeURIComponent` (best-effort; on `URIError` use raw).
   * 2. Parse as URL, take `pathname` if parseable; else use full IRI.
   * 3. Drop trailing `/`; strip leading `/`.
   * 4. Replace fragments (`#`) and queries (`?`) as part of the path.
   * 5. Replace non-alphanumeric (except `.`, `-`) with `-`.
   * 6. Collapse runs of `-` and trim leading/trailing.
   * 7. Truncate to 128 chars.
   * 8. Append `-<sha1[0:6]>` when the same slug (case-insensitive) appears
   *    more than once in `allKeys`, or when the slug would be empty.
   */
  static #slugifyIri(iri: string, allKeys: ReadonlySet<string>): string {
    // Step 1 — decode
    let decoded: string;
    try {
      decoded = decodeURIComponent(iri);
    } catch {
      decoded = iri;
    }

    // Step 2 — extract path segment
    let path: string;
    try {
      const url = new URL(decoded);
      // Include both pathname and fragment; drop query as `?` becomes `-` below
      path = url.pathname + (url.hash.length > 1 ? url.hash.slice(1) : '');
    } catch {
      path = decoded;
    }

    // Step 3 — strip trailing slash + leading slash
    path = path.replace(/\/+$/, '').replace(/^\/+/, '');

    // Step 4+5 — replace unsafe chars with `-`
    let slug = path.replace(/[^a-zA-Z0-9._-]/g, '-');

    // Step 6 — collapse runs, trim
    slug = slug.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');

    // Step 7 — truncate
    if (slug.length > 128) slug = slug.slice(0, 128);

    // Step 8 — add hash suffix when empty or when there is a collision potential
    if (slug.length === 0 || Bucketer.#hasCollision(iri, allKeys)) {
      const hash = createHash('sha1').update(iri).digest('hex').slice(0, 6);
      slug = slug.length > 0 ? `${slug}-${hash}` : hash;
    }

    return slug;
  }

  /**
   * Returns true when multiple keys in `allKeys` would produce the same slug.
   *
   * @remarks
   * Collision is detected by comparing the slug of `iri` against slugs of all
   * other keys. This is O(n) per bucket but n is typically small (<1000).
   */
  static #hasCollision(iri: string, allKeys: ReadonlySet<string>): boolean {
    if (allKeys.size <= 1) return false;

    // Derive slug for this IRI without collision-suffix (base slug)
    const thisSlug = Bucketer.#baseSlug(iri);
    if (thisSlug.length === 0) return true; // empty slug always gets suffix

    let count = 0;
    for (const key of allKeys) {
      if (key === DEFAULT_GRAPH_KEY || key === OTHER_BUCKET_KEY) continue;
      if (Bucketer.#baseSlug(key) === thisSlug) {
        count++;
        if (count > 1) return true;
      }
    }
    return false;
  }

  /**
   * Returns the slug for an IRI without the collision-avoidance suffix.
   * Used purely for collision detection.
   */
  static #baseSlug(iri: string): string {
    let decoded: string;
    try { decoded = decodeURIComponent(iri); }
    catch { decoded = iri; }

    let path: string;
    try {
      const url = new URL(decoded);
      path = url.pathname + (url.hash.length > 1 ? url.hash.slice(1) : '');
    } catch {
      path = decoded;
    }

    path = path.replace(/\/+$/, '').replace(/^\/+/, '');
    let slug = path.replace(/[^a-zA-Z0-9._-]/g, '-');
    slug = slug.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
    if (slug.length > 128) slug = slug.slice(0, 128);
    return slug;
  }
}
