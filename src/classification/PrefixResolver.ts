/**
 * @fileoverview `PrefixResolver` — deterministic prefix→base derivation for Squashage targets.
 *
 * @remarks
 * Resolves the three prefix-base pairs (`instances`, `graphs`, `vocabulary`) that
 * every Squashage target needs to project records into RDF. The resolver is a pure,
 * deterministic, I/O-free function: the same `(target, targetConfig, sampleSource)`
 * triple always yields the same `PrefixResolutionInterface`.
 *
 * Priority order (evaluated per pair):
 * 1. Explicit user override in `targetConfig.ontology.prefixes`.
 * 2. Derived from `sampleSource` (URL host for instance base; synthetic
 *    `https://squashage.dev/…` for graph and vocabulary when not in config).
 * 3. Synthetic fallback with a logger warning when no derivation is possible.
 *
 * @module classification/PrefixResolver
 * @category Classification
 * @since 0.1.0
 */

import type { InputSourceInterface }   from '../types/PipelineState.js';
import type { TargetConfigInterface }  from '../config/SquashageConfig.js';
import { OutputConfigError }           from '../errors/OutputConfigError.js';
import { Logger }                      from '../modules/logger/logger.js';

const logger = Logger.forComponent('PrefixResolver');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single prefix→base pair as Squashage understands it.
 *
 * @category Classification
 * @since 0.1.0
 * @see {@link PrefixResolutionInterface}
 * @group Types
 */
export interface PrefixBaseInterface {
  /**
   * Short label for use as a SPARQL/Turtle prefix (e.g. `'aonprd'`, `'aonprdg'`).
   * Always lowercase alphanumeric plus hyphens; never empty.
   */
  readonly prefix: string;
  /** IRI base ending in `/` or `#`. */
  readonly base:   string;
}

/**
 * The three prefix-base pairs every target needs to project records into RDF.
 *
 * @remarks
 * Produced by {@link PrefixResolver.resolve} and placed on
 * `PipelineContextInterface.prefixes` before the per-record pipeline executes.
 * Tasks read this to mint instance IRIs, named-graph IRIs, and vocabulary IRIs
 * in a consistent, config-driven way.
 *
 * @example
 * ```ts
 * const res = PrefixResolver.resolve('aonprd', targetConfig, sampleSource);
 * // res.instances  → { prefix: 'aonprd',  base: 'https://2e.aonprd.com/' }
 * // res.graphs     → { prefix: 'aonprdg', base: 'https://squashage.dev/graph/aonprd/' }
 * // res.vocabulary → { prefix: 'aonprd',  base: 'https://squashage.dev/vocabulary/aonprd#' }
 * // res.source     → 'derived'
 * ```
 *
 * @category Classification
 * @since 0.1.0
 * @see {@link PrefixResolver}
 * @group Types
 */
export interface PrefixResolutionInterface {
  /** Identifier namespace for instance IRIs (e.g. `https://2e.aonprd.com/`). */
  readonly instances:  PrefixBaseInterface;
  /** Named-graph IRI namespace (e.g. `https://squashage.dev/graph/aonprd/`). */
  readonly graphs:     PrefixBaseInterface;
  /** Vocabulary namespace for emitted predicates and class IRIs. */
  readonly vocabulary: PrefixBaseInterface;
  /**
   * Provenance of the resolved pairs — for evidence/logging.
   *
   * - `'config'`   — all three pairs came from `targetConfig.ontology.prefixes` / `baseIri`.
   * - `'derived'`  — at least one pair was derived from `sampleSource`; none fell back.
   * - `'fallback'` — at least one pair fell back to the synthetic `https://squashage.dev/…` namespace.
   */
  readonly source: 'config' | 'derived' | 'fallback';
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Common TLD segments dropped during the host-label heuristic.
 *
 * @internal
 */
const COMMON_TLDS = new Set<string>([
  'com', 'net', 'org', 'io', 'dev', 'app',
  'co', 'uk', 'us', 'ca',
]);

/**
 * Host labels that are too generic to use as a prefix even if they pass the
 * TLD filter (short numeric prefixes, generic sub-domain names).
 *
 * @internal
 */
const TRIVIAL_LABELS = new Set<string>(['www', 'm', '2e', '1e', '3e']);

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Internal result type carrying provenance alongside the resolved pair.
 *
 * @internal
 */
interface InternalPairResult extends PrefixBaseInterface {
  readonly provenance: 'config' | 'derived' | 'fallback';
}

// ---------------------------------------------------------------------------
// PrefixResolver
// ---------------------------------------------------------------------------

/**
 * Resolves the three prefix-base pairs a Squashage target needs for IRI projection.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated. Each call to
 * {@link PrefixResolver.resolve} is pure and deterministic — no I/O, no
 * randomness, no mutable module state.
 *
 * **Resolution priority (per pair)**:
 * 1. Explicit `targetConfig.ontology.prefixes` entry.
 * 2. Derived from `sampleSource` URL / path hint.
 * 3. Synthetic `https://squashage.dev/…` fallback.
 *
 * @example
 * ```ts
 * const result = PrefixResolver.resolve('aonprd', targetConfig, sampleSource);
 * console.log(result.instances.base); // 'https://2e.aonprd.com/'
 * ```
 *
 * @category Classification
 * @since 0.1.0
 * @see {@link PrefixResolutionInterface}
 * @group Core
 */
export class PrefixResolver {
  private constructor() { /* static-only */ }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Resolve the three prefix-base pairs a target needs.
   *
   * @remarks
   * Priority order per pair:
   * 1. `targetConfig.ontology.prefixes[<role>]` if explicitly supplied.
   * 2. Derived from `sampleSource` — instance base from URL origin or
   *    `_source.target` host; graph base as
   *    `https://squashage.dev/graph/<target>/`; vocabulary base as
   *    `https://squashage.dev/vocabulary/<target>#`.
   * 3. Fallback to a synthetic anonymous namespace with a logger warning.
   *
   * Deterministic — same target/config/sampleSource always returns the same result.
   *
   * @param target       - Target identifier from the squashage config.
   * @param targetConfig - Per-target config; `ontology.prefixes` is the user override map.
   * @param sampleSource - Optional first record's `_source` block; used for URL derivation.
   * @returns Resolved prefix-base pairs with provenance.
   * @throws {OutputConfigError} When `target` sanitizes to an empty slug.
   */
  public static resolve(
    target:       string,
    targetConfig: TargetConfigInterface,
    sampleSource: InputSourceInterface | undefined,
  ): PrefixResolutionInterface {
    logger.debug('resolve', 'Resolving prefixes', { target });

    const slug           = PrefixResolver.#sanitize(target);
    const ontology       = targetConfig.ontology as Readonly<Record<string, unknown>> | undefined;
    const configPrefixes = PrefixResolver.#extractConfigPrefixes(ontology);
    const baseIri        = typeof ontology?.['baseIri'] === 'string' ? ontology['baseIri'] : undefined;

    let usedDerived  = false;
    let usedFallback = false;

    // ── instances ────────────────────────────────────────────────────────────
    const instanceResult = PrefixResolver.#resolveInstances(
      slug, configPrefixes, sampleSource,
    );
    if (instanceResult.provenance === 'derived')  usedDerived  = true;
    if (instanceResult.provenance === 'fallback') usedFallback = true;

    // ── graphs ───────────────────────────────────────────────────────────────
    const graphResult = PrefixResolver.#resolveGraphs(slug, configPrefixes);
    if (graphResult.provenance === 'derived')  usedDerived  = true;
    if (graphResult.provenance === 'fallback') usedFallback = true;

    // ── vocabulary ───────────────────────────────────────────────────────────
    const vocabResult = PrefixResolver.#resolveVocabulary(slug, configPrefixes, baseIri);
    if (vocabResult.provenance === 'derived')  usedDerived  = true;
    if (vocabResult.provenance === 'fallback') usedFallback = true;

    // ── source provenance ─────────────────────────────────────────────────────
    const source: PrefixResolutionInterface['source'] =
      usedFallback ? 'fallback' :
      usedDerived  ? 'derived'  :
      'config';

    const resolution: PrefixResolutionInterface = {
      instances:  { prefix: instanceResult.prefix, base: instanceResult.base },
      graphs:     { prefix: graphResult.prefix,    base: graphResult.base    },
      vocabulary: { prefix: vocabResult.prefix,    base: vocabResult.base   },
      source,
    };

    logger.info('resolve', 'Prefixes resolved', {
      target,
      source,
      instanceBase:   resolution.instances.base,
      graphBase:      resolution.graphs.base,
      vocabularyBase: resolution.vocabulary.base,
    });

    return resolution;
  }

  // ---------------------------------------------------------------------------
  // Private: per-pair resolvers
  // ---------------------------------------------------------------------------

  /**
   * Resolves the instance prefix-base pair.
   *
   * @param slug           - Sanitized target slug.
   * @param configPrefixes - Parsed config prefix map (IRI→prefix label).
   * @param sampleSource   - Optional sample record source.
   * @returns Pair with provenance tag.
   */
  static #resolveInstances(
    slug:           string,
    configPrefixes: Map<string, string>,
    sampleSource:   InputSourceInterface | undefined,
  ): InternalPairResult {
    // 1. Config: find the first entry whose base is a scheme+host origin IRI
    //    (ends with `/` and has no path segments beyond the root).
    for (const [base, prefix] of configPrefixes) {
      if (PrefixResolver.#isOriginBase(base)) {
        logger.debug('resolve', 'Instance base from config', { base, prefix });
        return { prefix, base, provenance: 'config' };
      }
    }

    // 2. Derive from sampleSource URL hints.
    if (sampleSource !== undefined) {
      const url = PrefixResolver.#extractUrl(sampleSource);
      if (url !== undefined) {
        const base   = `${url.protocol}//${url.host}/`;
        const prefix = PrefixResolver.#hostToPrefix(url.host);
        if (prefix !== undefined) {
          logger.debug('derive', 'Instance base derived from URL', { base, prefix, url: url.href });
          return { prefix, base, provenance: 'derived' };
        }
      }
    }

    // 3. Fallback.
    logger.warn('fallback', 'Instance base falling back to synthetic namespace', { slug });
    return {
      prefix:     slug,
      base:       `https://squashage.dev/instance/${slug}/`,
      provenance: 'fallback',
    };
  }

  /**
   * Resolves the named-graph prefix-base pair.
   *
   * @param slug           - Sanitized target slug.
   * @param configPrefixes - Parsed config prefix map (IRI→prefix label).
   * @returns Pair with provenance tag.
   */
  static #resolveGraphs(
    slug:           string,
    configPrefixes: Map<string, string>,
  ): InternalPairResult {
    // 1. Config: look for an entry whose prefix label ends with `g`
    //    (conventional graph-namespace suffix) or base contains `/graph/`.
    const graphSlug = `${slug}g`;
    for (const [base, prefix] of configPrefixes) {
      if (prefix === graphSlug || base.includes('/graph/')) {
        logger.debug('resolve', 'Graph base from config', { base, prefix });
        return { prefix, base, provenance: 'config' };
      }
    }

    // 2+3. No sampleSource derivation for graphs; synthetic fallback.
    return {
      prefix:     graphSlug,
      base:       `https://squashage.dev/graph/${slug}/`,
      provenance: 'fallback',
    };
  }

  /**
   * Resolves the vocabulary prefix-base pair.
   *
   * @param slug           - Sanitized target slug.
   * @param configPrefixes - Parsed config prefix map (IRI→prefix label).
   * @param baseIri        - Optional `targetConfig.ontology.baseIri` override.
   * @returns Pair with provenance tag.
   */
  static #resolveVocabulary(
    slug:           string,
    configPrefixes: Map<string, string>,
    baseIri:        string | undefined,
  ): InternalPairResult {
    // 1a. Explicit baseIri from config.
    if (baseIri !== undefined && baseIri.length > 0) {
      const prefix = PrefixResolver.#prefixFromIriPath(baseIri) ?? slug;
      logger.debug('resolve', 'Vocabulary base from ontology.baseIri', { base: baseIri, prefix });
      return { prefix, base: baseIri, provenance: 'config' };
    }

    // 1b. Config prefix map: first lex-sorted entry whose base ends with `#`.
    const hashEntries = [...configPrefixes.entries()]
      .filter(([base]) => base.endsWith('#'))
      .sort(([a], [b]) => a.localeCompare(b));

    if (hashEntries.length > 0) {
      const [base, prefix] = hashEntries[0]!;
      logger.debug('resolve', 'Vocabulary base from config prefix (hash-terminated)', { base, prefix });
      return { prefix, base, provenance: 'config' };
    }

    // 2+3. No sampleSource derivation for vocabulary; synthetic fallback.
    logger.warn('fallback', 'Vocabulary base falling back to synthetic namespace', { slug });
    return {
      prefix:     slug,
      base:       `https://squashage.dev/vocabulary/${slug}#`,
      provenance: 'fallback',
    };
  }

  // ---------------------------------------------------------------------------
  // Private: utility helpers
  // ---------------------------------------------------------------------------

  /**
   * Sanitizes a raw target string into a prefix-safe slug.
   *
   * @remarks
   * Lowercases, replaces any run of non-`[a-z0-9-]` characters with a single
   * `-`, then trims leading/trailing `-`.
   *
   * @param raw - Raw target identifier (e.g. `'My Target.Name'`).
   * @returns Sanitized lowercase slug (e.g. `'my-target-name'`).
   * @throws {OutputConfigError} When the result is an empty string.
   */
  static #sanitize(raw: string): string {
    const slug = raw
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (slug.length === 0) {
      throw OutputConfigError.create(
        `Target name "${raw}" sanitizes to an empty slug; cannot derive prefixes.`,
        { metadata: { raw } },
      );
    }

    return slug;
  }

  /**
   * Extracts the `targetConfig.ontology.prefixes` map and inverts it to
   * `Map<base, prefix>` for O(1) lookups by IRI base.
   *
   * @param ontology - Raw `targetConfig.ontology` object (may be `undefined`).
   * @returns Inverted map; empty if no prefixes configured.
   */
  static #extractConfigPrefixes(
    ontology: Readonly<Record<string, unknown>> | undefined,
  ): Map<string, string> {
    const map = new Map<string, string>();
    if (ontology === undefined) return map;

    const raw = ontology['prefixes'];
    if (raw === undefined || raw === null || typeof raw !== 'object') return map;

    const prefixes = raw as Readonly<Record<string, unknown>>;
    for (const [label, iri] of Object.entries(prefixes)) {
      if (typeof iri === 'string' && iri.length > 0) {
        map.set(iri, label);
      }
    }
    return map;
  }

  /**
   * Returns `true` when `iri` is a scheme+host origin base with no path segments
   * beyond the root (e.g. `https://example.com/`).
   *
   * @param iri - IRI string to test.
   * @returns `true` when it is an origin base.
   */
  static #isOriginBase(iri: string): boolean {
    try {
      const url = new URL(iri);
      return url.pathname === '/' && url.search === '' && url.hash === '';
    } catch {
      return false;
    }
  }

  /**
   * Extracts a parseable URL from a `InputSourceInterface`'s `path` field.
   *
   * @remarks
   * Checks whether `source.path` begins with `https://` or `http://` (some
   * upstream producers write the source URL directly into `_source.path`).
   *
   * @param source - Record source metadata.
   * @returns Parsed `URL` when found; `undefined` otherwise.
   */
  static #extractUrl(source: InputSourceInterface): URL | undefined {
    const candidate = source.path;
    if (candidate.startsWith('https://') || candidate.startsWith('http://')) {
      try {
        return new URL(candidate);
      } catch {
        // malformed — fall through
      }
    }
    return undefined;
  }

  /**
   * Converts a hostname to a prefix label using the SLD-selection heuristic.
   *
   * @remarks
   * Algorithm:
   * 1. Strip any port number.
   * 2. Split on `.`.
   * 3. Drop segments in {@link COMMON_TLDS}.
   * 4. Drop segments in {@link TRIVIAL_LABELS}.
   * 5. Drop any segment of length ≤ 1.
   * 6. Take the longest remaining label (lowercase).
   * 7. If no candidate survives, return `undefined` (caller falls back).
   *
   * Examples:
   * - `2e.aonprd.com` → drop `com`, drop `2e` → `['aonprd']` → `'aonprd'`
   * - `wiki.bulbagarden.net` → drop `net`, drop `wiki` → `'bulbagarden'`
   * - `www.example.org` → drop `org`, drop `www` → `'example'`
   * - `co.uk` → drop both → `undefined` (caller falls back)
   *
   * @param host - Hostname from a `URL` (may include port).
   * @returns Lowercase prefix label, or `undefined` when the heuristic yields nothing.
   */
  static #hostToPrefix(host: string): string | undefined {
    // Strip port number if present.
    const hostOnly = host.split(':')[0] ?? host;
    const labels   = hostOnly.split('.');

    const candidates = labels.filter(
      label =>
        label.length > 1 &&
        !COMMON_TLDS.has(label) &&
        !TRIVIAL_LABELS.has(label),
    );

    if (candidates.length === 0) return undefined;

    // Take the longest candidate; ties broken by first-encountered (stable order).
    const longest = candidates.reduce<string>(
      (best, cur) => cur.length > best.length ? cur : best,
      '',
    );

    return longest.length > 0 ? longest.toLowerCase() : undefined;
  }

  /**
   * Derives a prefix label from the last non-empty path segment of an IRI.
   *
   * @remarks
   * Used to infer a vocabulary prefix from `targetConfig.ontology.baseIri`.
   * For example `https://squashage.dev/vocabulary/aonprd#` yields `'aonprd'`.
   * Returns `undefined` when no usable segment is found.
   *
   * @param iri - IRI string (e.g. `'https://squashage.dev/vocabulary/aonprd#'`).
   * @returns Lowercase path-segment label, or `undefined`.
   */
  static #prefixFromIriPath(iri: string): string | undefined {
    try {
      const url = new URL(iri);
      const segments = url.pathname.split('/').filter(s => s.length > 0);
      const last = segments[segments.length - 1];
      return last !== undefined && last.length > 0 ? last.toLowerCase() : undefined;
    } catch {
      return undefined;
    }
  }
}
