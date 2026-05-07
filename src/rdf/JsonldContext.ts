/**
 * @fileoverview `JsonldContext` — deterministic JSON-LD `@context` builder.
 *
 * @remarks
 * Derives a compaction context from a quad stream and the run's resolved
 * prefix-base pairs. The context is built by:
 *   1. Seeding well-known prefixes (`rdf:`, `xsd:`) plus every (prefix, base) pair
 *      from `prefixes` (instances, graphs, vocabulary).
 *   2. Walking every quad predicate to determine its compact term (longest-prefix
 *      match), inferred `@type` (when consistent across all uses), and whether
 *      `@container: @set` is needed (≥2 distinct objects per (subject, graph) pair).
 *   3. Emitting one context entry per term, sorted lex-asc for deterministic output.
 *
 * **Longest-prefix match** — implemented as a linear scan over all seeded
 * (base → prefix-label) pairs, tracking the longest matching base per predicate
 * IRI. Linear scan is O(P·Q) where P = number of prefix entries (typically < 10)
 * and Q = number of distinct predicate IRIs; adequate for v0.x dataset sizes.
 *
 * **Term collision** — if two distinct predicate IRIs compact to the same
 * (`prefix:local`) term, both are kept fully-qualified and a warn is logged.
 *
 * @module rdf/JsonldContext
 * @category RDF
 * @since 2.2.0
 */

import { readFile } from 'node:fs/promises';

import type { Quad } from '@rdfjs/types';
import type { PrefixResolutionInterface } from '../classification/PrefixResolver.js';
import { Logger } from '../modules/logger/logger.js';

const logger = Logger.forComponent('JsonldContext');

// ---------------------------------------------------------------------------
// Well-known prefix seeds
// ---------------------------------------------------------------------------

/** Always-seeded prefix → base pairs. */
const WELL_KNOWN_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['rdf',  'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
  ['xsd',  'http://www.w3.org/2001/XMLSchema#'],
  ['rdfs', 'http://www.w3.org/2000/01/rdf-schema#'],
];

/** Datatypes that should NOT produce an explicit `@type` in the context (plain default). */
const PLAIN_DATATYPES = new Set<string>([
  'http://www.w3.org/2001/XMLSchema#string',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString',
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A minimal JSON-LD `@context` document, ready to pass to `jsonld.compact`.
 *
 * @category RDF
 * @since 2.2.0
 * @group Types
 */
export type JsonldContextDocInterface = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Accumulated statistics about a single predicate across all quads. */
interface TermStatsInterface {
  /** Full predicate IRI (used as fallback key on collision). */
  readonly predicateIri: string;
  /** Whether every observed object is a NamedNode. */
  allNamedNode: boolean;
  /** Consistent literal datatype across all objects; `null` if mixed or absent. */
  consistentDatatype: string | null;
  /**
   * Whether `consistentDatatype` has seen any inconsistency.
   * Once `true`, we stop tracking the datatype.
   */
  datatypeInconsistent: boolean;
  /**
   * Per (subject+graph composite key) → set of object-key strings.
   * Used to detect ≥2 distinct objects for the same (subject, graph) pair.
   */
  readonly subjectGraphObjects: Map<string, Set<string>>;
}

// ---------------------------------------------------------------------------
// JsonldContext
// ---------------------------------------------------------------------------

/**
 * Static-only class that builds and loads JSON-LD compaction contexts.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated.
 *
 * @example Auto-build
 * ```ts
 * const ctx = JsonldContext.build(quads, prefixes);
 * // ctx = { "@context": { rdf: '...', xsd: '...', name: { '@id': 'vocab:name' } } }
 * ```
 *
 * @example Load from path
 * ```ts
 * const ctx = await JsonldContext.loadFromPath('/path/to/context.jsonld');
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @group Core
 */
export class JsonldContext {
  private constructor() { /* static-only */ }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Auto-build a compaction context from a quad stream and the run's prefixes.
   *
   * @remarks
   * **Algorithm (deterministic)**:
   * 1. Seed with `rdf:`, `xsd:`, `rdfs:` plus every (prefix, base) from `prefixes`
   *    (instances, graphs, vocabulary).
   * 2. Walk every quad. For each predicate IRI determine its namespace via
   *    longest-prefix match against the seeded prefixes.
   * 3. Track per term: object termType, consistent literal datatype, and whether
   *    any (subject, graph) pair has ≥2 distinct objects.
   * 4. Emit each term once in the context. Sort all keys lex-asc.
   *
   * **Prefix seeds** appear directly in the `@context` as simple string values
   * (i.e. `"xsd": "http://www.w3.org/2001/XMLSchema#"`) so compacted output can
   * use CURIE-style references.
   *
   * @param quads    - Quad array to analyse.
   * @param prefixes - Resolved prefix-base pairs from the run.
   * @returns Compaction context document (pass directly to `jsonld.compact`).
   */
  static build(
    quads:    ReadonlyArray<Quad>,
    prefixes: PrefixResolutionInterface,
  ): JsonldContextDocInterface {
    // Step 1 — Seed the prefix map (label → base).
    const seedMap = JsonldContext.#buildSeedMap(prefixes);

    // Step 2+3 — Walk quads; accumulate per-term stats.
    //
    // termKey → TermStatsInterface
    // termKey is the compacted form (e.g. "vocab:name") or the full IRI if
    // no prefix matches.
    const termStats = new Map<string, TermStatsInterface>();
    // full predicate IRI → termKey (reverse map for collision detection)
    const iriToTermKey = new Map<string, string>();
    // full predicate IRI → termKey collision: IRIs that must stay fully-qualified
    const collided = new Set<string>();

    for (const quad of quads) {
      const predicateIri = quad.predicate.value;
      if (collided.has(predicateIri)) continue;

      // Determine term key for this predicate.
      let termKey: string;
      if (iriToTermKey.has(predicateIri)) {
        termKey = iriToTermKey.get(predicateIri)!;
      } else {
        termKey = JsonldContext.#compactIri(predicateIri, seedMap);

        // Check for collision: another IRI already mapped to this termKey.
        const existingStats = termStats.get(termKey);
        if (existingStats !== undefined && existingStats.predicateIri !== predicateIri) {
          // Collision: two distinct predicate IRIs compact to the same term.
          logger.warn(
            'build',
            'Term collision detected — keeping both predicates fully-qualified',
            { termKey, iri1: existingStats.predicateIri, iri2: predicateIri },
          );
          // Remove the previously registered term.
          termStats.delete(termKey);
          collided.add(existingStats.predicateIri);
          collided.add(predicateIri);
          iriToTermKey.set(predicateIri, predicateIri);
          // Update the prior IRI's mapping to its full IRI (it now uses the full IRI as key).
          iriToTermKey.set(existingStats.predicateIri, existingStats.predicateIri);
          continue;
        }

        iriToTermKey.set(predicateIri, termKey);
      }

      // Get or create stats entry.
      let stats = termStats.get(termKey);
      if (stats === undefined) {
        stats = {
          predicateIri,
          allNamedNode:          true,
          consistentDatatype:    null,
          datatypeInconsistent:  false,
          subjectGraphObjects:   new Map(),
        };
        termStats.set(termKey, stats);
      }

      // Update type inference.
      const obj = quad.object;
      if (obj.termType !== 'NamedNode') {
        stats.allNamedNode = false;
      }

      if (obj.termType === 'Literal' && !stats.datatypeInconsistent) {
        const dt = obj.datatype?.value ?? 'http://www.w3.org/2001/XMLSchema#string';
        if (stats.consistentDatatype === null) {
          // First observation.
          stats.consistentDatatype = dt;
        } else if (stats.consistentDatatype !== dt) {
          // Mixed datatypes — mark inconsistent.
          stats.datatypeInconsistent = true;
          stats.consistentDatatype   = null;
        }
      } else if (obj.termType !== 'Literal') {
        // Non-literal present alongside potential literals → inconsistent datatype.
        // (allNamedNode was already set to false above if mixed, so this handles
        //  the case where we had a NamedNode and then see a Literal.)
        if (stats.consistentDatatype !== null || !stats.datatypeInconsistent) {
          // If we previously saw a Literal, now a non-Literal: mixed.
          // But we only do this if we have prior consistent datatype — otherwise
          // the stats.allNamedNode = false already guards the @type inference.
        }
      }

      // Update @set inference: count distinct objects per (subject, graph) pair.
      const subjectGraphKey = `${quad.subject.value}\x00${quad.graph.value}`;
      let objectSet = stats.subjectGraphObjects.get(subjectGraphKey);
      if (objectSet === undefined) {
        objectSet = new Set<string>();
        stats.subjectGraphObjects.set(subjectGraphKey, objectSet);
      }
      objectSet.add(JsonldContext.#objectKey(quad));
    }

    // Step 4 — Build the @context document.
    const ctx: Record<string, unknown> = {};

    // Emit prefix-seed entries as simple IRI strings (enables CURIE resolution).
    for (const [label, base] of seedMap) {
      ctx[label] = base;
    }

    // Emit one entry per compacted term.
    for (const [termKey, stats] of termStats) {
      if (collided.has(stats.predicateIri)) continue;

      const entry: Record<string, unknown> = { '@id': termKey };

      if (stats.allNamedNode) {
        entry['@type'] = '@id';
      } else if (
        !stats.datatypeInconsistent &&
        stats.consistentDatatype !== null &&
        !PLAIN_DATATYPES.has(stats.consistentDatatype)
      ) {
        // All literals share one non-plain datatype.
        entry['@type'] = JsonldContext.#compactIri(stats.consistentDatatype, seedMap);
      }

      // @set detection: any (subject, graph) pair with ≥2 distinct objects.
      const hasMultiValue = [...stats.subjectGraphObjects.values()]
        .some(objectSet => objectSet.size >= 2);
      if (hasMultiValue) {
        entry['@container'] = '@set';
      }

      ctx[termKey] = entry;
    }

    // Sort keys lex-asc for deterministic byte output.
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(ctx).sort()) {
      sorted[key] = ctx[key];
    }

    return { '@context': sorted };
  }

  /**
   * Load a context from a path (resolved by the caller; this method just reads
   * the file and JSON-parses it).
   *
   * @remarks
   * Used when the user supplies `output.jsonldContext: '<path>'`.
   *
   * @param absolutePath - Absolute path to the context JSON file.
   * @returns Parsed context document.
   * @throws When the file cannot be read or its content is not valid JSON.
   */
  static async loadFromPath(absolutePath: string): Promise<JsonldContextDocInterface> {
    const text = await readFile(absolutePath, 'utf8');
    return JSON.parse(text) as JsonldContextDocInterface;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Builds the prefix seed map (label → base IRI) from well-known prefixes plus
   * the run's resolved prefix-base pairs.
   *
   * @param prefixes - Run-resolved prefix pairs.
   * @returns Ordered map of prefix-label → base-IRI (well-known first, then run prefixes).
   */
  static #buildSeedMap(prefixes: PrefixResolutionInterface): Map<string, string> {
    const map = new Map<string, string>();

    // Well-known seeds first.
    for (const [label, base] of WELL_KNOWN_PREFIXES) {
      map.set(label, base);
    }

    // Run prefixes: instances, graphs, vocabulary.
    // Later entries overwrite earlier entries if the same label appears; the
    // run config is authoritative for collisions with well-known prefixes.
    const pairs = [
      prefixes.instances,
      prefixes.graphs,
      prefixes.vocabulary,
    ];
    for (const { prefix, base } of pairs) {
      if (prefix.length > 0 && base.length > 0) {
        map.set(prefix, base);
      }
    }

    return map;
  }

  /**
   * Compacts a full IRI to a prefixed form using longest-prefix match.
   *
   * @remarks
   * Linear scan over all seeded (label → base) pairs. For each pair where
   * `iri.startsWith(base)`, records the one with the longest base as the winner.
   * Returns the full IRI when no prefix matches.
   *
   * @param iri     - Full IRI to compact.
   * @param seedMap - Seeded prefix map (label → base).
   * @returns Compacted IRI (`prefix:local`) or the original IRI.
   */
  static #compactIri(iri: string, seedMap: Map<string, string>): string {
    let bestLabel = '';
    let bestBase  = '';

    for (const [label, base] of seedMap) {
      if (iri.startsWith(base) && base.length > bestBase.length) {
        bestLabel = label;
        bestBase  = base;
      }
    }

    if (bestBase.length === 0) {
      // No prefix match — return the full IRI.
      return iri;
    }

    const local = iri.slice(bestBase.length);
    if (local.length === 0) {
      // IRI equals the base exactly — keep fully-qualified to avoid an empty local.
      return iri;
    }

    return `${bestLabel}:${local}`;
  }

  /**
   * Produces a stable string key for an RDF term (for distinct-object counting).
   *
   * @param quad - The quad whose object is to be keyed.
   * @returns A stable string representing the object term.
   */
  static #objectKey(quad: Quad): string {
    const obj = quad.object;
    switch (obj.termType) {
      case 'NamedNode':
        return `n:${obj.value}`;
      case 'Literal': {
        const dt  = obj.datatype?.value ?? '';
        const lng = obj.language ?? '';
        return `l:${obj.value}|${dt}|${lng}`;
      }
      case 'BlankNode':
        return `b:${obj.value}`;
      default:
        return `?:${obj.value}`;
    }
  }
}
