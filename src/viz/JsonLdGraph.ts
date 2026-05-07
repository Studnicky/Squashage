/**
 * @fileoverview `JsonLdGraph` — pure JSON-LD to graph payload adapter.
 *
 * @remarks
 * Converts a JSON-LD document into a `VizPayloadInterface` suitable for
 * rendering. Expands the document via the `jsonld` library first so that
 * compacted forms (bare CURIE strings for `@type: @id` predicates, prefixed
 * IRIs, etc.) are resolved to canonical `{ "@id": "..." }` objects before
 * the walker runs. No DOM; no library imports beyond `jsonld`.
 *
 * @module viz/JsonLdGraph
 * @category Viz
 * @since 0.2.0
 */

// eslint-disable-next-line no-restricted-imports
import jsonldDefault from 'jsonld';

// jsonld v9 ships no TypeScript declarations; the local @types/jsonld stub
// covers toRDF and expand. The default import is typed via the stub as
// JsonLdApi, but NodeNext CJS interop may widen it — cast to any once here
// so call sites stay clean without per-call suppressions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonld = jsonldDefault as any as { expand: (doc: unknown, opts?: { base?: string }) => Promise<unknown[]> };

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * A single graph node derived from a JSON-LD entity.
 *
 * @category Viz
 * @since 0.2.0
 * @group Types
 */
export interface VizNodeInterface {
  /** Entity `@id` (compacted if possible, else full IRI). */
  readonly id:          string;
  /** Human-readable label (name/title/label literal, or compacted IRI). */
  readonly label:       string;
  /** First `@type` value (full IRI) or `undefined` when untyped. */
  readonly classIri:    string | undefined;
  /** Compacted class label (e.g. `'aonprd:Feat'`) or `undefined`. */
  readonly classLabel:  string | undefined;
  /** Named graph IRI this entity belongs to (for coloring), or `undefined`. */
  readonly graphIri:    string | undefined;
  /** Literal properties keyed by compacted predicate label → array of string values. */
  readonly properties:  Readonly<Record<string, ReadonlyArray<string>>>;
}

/**
 * A directed edge between two graph nodes.
 *
 * @category Viz
 * @since 0.2.0
 * @group Types
 */
export interface VizEdgeInterface {
  /** Synthetic id: `'<source>--<predicate>->><target>'`. */
  readonly id:       string;
  /** Source node id. */
  readonly source:   string;
  /** Target node id. */
  readonly target:   string;
  /** Compacted predicate label. */
  readonly label:    string;
  /** Named graph IRI this edge belongs to, or `undefined`. */
  readonly graphIri: string | undefined;
}

/**
 * Named graph descriptor for legend rendering.
 *
 * @category Viz
 * @since 0.2.0
 * @group Types
 */
export interface VizGraphDescriptorInterface {
  /** Full named-graph IRI. */
  readonly id:    string;
  /** Compacted label (or IRI verbatim when no prefix applies). */
  readonly label: string;
}

/**
 * Complete payload for rendering a squashage JSON-LD as an interactive graph.
 *
 * @category Viz
 * @since 0.2.0
 * @group Types
 */
export interface VizPayloadInterface {
  /** All entity nodes. */
  readonly nodes:    ReadonlyArray<VizNodeInterface>;
  /** All directed edges (object-property references). */
  readonly edges:    ReadonlyArray<VizEdgeInterface>;
  /** Distinct named graphs (for legend). */
  readonly graphs:   ReadonlyArray<VizGraphDescriptorInterface>;
  /** Prefix map from the document's `@context` (prefix → base IRI). */
  readonly prefixes: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Mutable working node during construction. */
interface WorkingNodeInterface {
  id:          string;
  label:       string;
  classIri:    string | undefined;
  classLabel:  string | undefined;
  graphIri:    string | undefined;
  properties:  Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// JsonLdGraph
// ---------------------------------------------------------------------------

/**
 * Static-only adapter that converts a JSON-LD document to a
 * `VizPayloadInterface`.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated.
 *
 * The document is expanded via `jsonld.expand()` before walking so that
 * compacted CURIE-string references (produced by `@type: @id` term
 * definitions) are resolved to unambiguous `{ "@id": "..." }` objects.
 * The prefix map extracted from the original document's `@context` is used
 * for compaction labelling of IRIs in the output payload.
 *
 * @example
 * ```ts
 * const payload = await JsonLdGraph.fromJsonLd(doc);
 * ```
 *
 * @category Viz
 * @since 0.2.0
 * @group Core
 */
export class JsonLdGraph {
  private constructor() { /* static-only */ }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Converts a JSON-LD document to a `VizPayloadInterface`.
   *
   * @remarks
   * Expands the document via `jsonld.expand()` so that every reference is
   * `{ "@id": "..." }` and every literal is `{ "@value": ..., "@type"?: "..." }`.
   * Walks the expanded form to produce nodes and edges.
   *
   * The original document's `@context` is used to extract prefix labels for
   * compaction in the returned payload (node labels, class labels, graph labels,
   * edge labels).
   *
   * Handles two expanded shapes:
   * - Named-graph wrappers: `{ "@id": graphIRI, "@graph": [...entities] }`.
   * - Top-level entity objects with `@id`.
   *
   * Output is deterministic: edges sorted by `(source, label, target)`, node
   * property keys sorted lexicographically.
   *
   * @param doc - Parsed JSON-LD document (any compacted or expanded form).
   * @returns A `VizPayloadInterface` ready for rendering.
   */
  static async fromJsonLd(doc: unknown): Promise<VizPayloadInterface> {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return { nodes: [], edges: [], graphs: [], prefixes: {} };
    }

    const docObj = doc as Record<string, unknown>;

    // Extract prefix map from the original @context (for compaction labelling).
    const prefixes = JsonLdGraph.#extractPrefixes(docObj['@context']);

    // Expand the document to get a canonical form where all references are
    // { "@id": "..." } objects and literals are { "@value": ..., "@type"?: ... }.
    let expanded: unknown[];
    try {
      expanded = await jsonld.expand(doc as Parameters<typeof jsonld.expand>[0]);
    } catch {
      return { nodes: [], edges: [], graphs: [], prefixes };
    }

    // Collect nodes and edges from the expanded form.
    const nodeMap  = new Map<string, WorkingNodeInterface>();
    const edges: VizEdgeInterface[] = [];
    const graphIris = new Set<string>();

    for (const item of expanded) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const itemObj = item as Record<string, unknown>;

      // Named-graph wrapper: { "@id": graphIRI, "@graph": [...entities] }
      const graphArr = itemObj['@graph'];
      if (Array.isArray(graphArr)) {
        const graphIri = typeof itemObj['@id'] === 'string' ? itemObj['@id'] : undefined;
        if (graphIri !== undefined) graphIris.add(graphIri);

        for (const entity of graphArr) {
          JsonLdGraph.#walkExpandedEntity(entity, prefixes, graphIri, nodeMap, edges);
        }
      } else {
        // Top-level entity (no named-graph wrapper).
        JsonLdGraph.#walkExpandedEntity(itemObj, prefixes, undefined, nodeMap, edges);
      }
    }

    // Ensure every edge target has a node entry (JSON-LD expand may elide
    // entities that have no properties beyond @id). These are implicit-IRI
    // nodes — use the human-friendlier local name rather than the full CURIE.
    for (const edge of edges) {
      if (!nodeMap.has(edge.target)) {
        const label = JsonLdGraph.#implicitIriLabel(edge.target, prefixes);
        nodeMap.set(edge.target, {
          id:         edge.target,
          label,
          classIri:   undefined,
          classLabel: undefined,
          graphIri:   edge.graphIri,
          properties: {},
        });
      }
      if (!nodeMap.has(edge.source)) {
        const label = JsonLdGraph.#implicitIriLabel(edge.source, prefixes);
        nodeMap.set(edge.source, {
          id:         edge.source,
          label,
          classIri:   undefined,
          classLabel: undefined,
          graphIri:   edge.graphIri,
          properties: {},
        });
      }
    }

    // Build sorted node list.
    const nodes: VizNodeInterface[] = [...nodeMap.values()].map(n => ({
      id:         n.id,
      label:      n.label,
      classIri:   n.classIri,
      classLabel: n.classLabel,
      graphIri:   n.graphIri,
      properties: JsonLdGraph.#sortedProperties(n.properties),
    }));

    // Sort edges deterministically by (source, label, target).
    edges.sort((a, b) => {
      const sa = `${a.source}\x00${a.label}\x00${a.target}`;
      const sb = `${b.source}\x00${b.label}\x00${b.target}`;
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });

    // Build graph descriptors.
    const graphs: VizGraphDescriptorInterface[] = [...graphIris]
      .sort()
      .map(iri => ({ id: iri, label: JsonLdGraph.#compactIri(iri, prefixes) }));

    return { nodes, edges, graphs, prefixes };
  }

  /**
   * Synchronous compatibility shim — converts a compacted JSON-LD document
   * without calling `jsonld.expand()`. References must already be
   * `{ "@id": "..." }` objects for edges to be detected.
   *
   * @deprecated Use {@link fromJsonLd} for correct edge detection with compacted documents.
   * @param doc - Parsed JSON-LD document (compacted or expanded).
   * @returns A `VizPayloadInterface`; CURIE-string references produce no edges.
   */
  static fromCompactedJsonLd(doc: unknown): VizPayloadInterface {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return { nodes: [], edges: [], graphs: [], prefixes: {} };
    }

    const docObj = doc as Record<string, unknown>;
    const prefixes = JsonLdGraph.#extractPrefixes(docObj['@context']);

    const nodeMap  = new Map<string, WorkingNodeInterface>();
    const edges: VizEdgeInterface[] = [];
    const graphIris = new Set<string>();

    const topGraph = docObj['@graph'];
    if (Array.isArray(topGraph)) {
      for (const item of topGraph) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
        const itemObj = item as Record<string, unknown>;

        if (Array.isArray(itemObj['@graph'])) {
          const graphIri = typeof itemObj['@id'] === 'string' ? itemObj['@id'] : undefined;
          if (graphIri !== undefined) graphIris.add(graphIri);

          for (const entity of itemObj['@graph'] as unknown[]) {
            JsonLdGraph.#walkEntity(entity, prefixes, graphIri, nodeMap, edges);
          }
        } else {
          JsonLdGraph.#walkEntity(itemObj, prefixes, undefined, nodeMap, edges);
        }
      }
    } else if (typeof docObj['@id'] === 'string') {
      JsonLdGraph.#walkEntity(docObj, prefixes, undefined, nodeMap, edges);
    }

    const nodes: VizNodeInterface[] = [...nodeMap.values()].map(n => ({
      id:         n.id,
      label:      n.label,
      classIri:   n.classIri,
      classLabel: n.classLabel,
      graphIri:   n.graphIri,
      properties: JsonLdGraph.#sortedProperties(n.properties),
    }));

    edges.sort((a, b) => {
      const sa = `${a.source}\x00${a.label}\x00${a.target}`;
      const sb = `${b.source}\x00${b.label}\x00${b.target}`;
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });

    const graphs: VizGraphDescriptorInterface[] = [...graphIris]
      .sort()
      .map(iri => ({ id: iri, label: JsonLdGraph.#compactIri(iri, prefixes) }));

    return { nodes, edges, graphs, prefixes };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extracts a prefix map (prefix → base IRI) from a JSON-LD `@context` value.
   *
   * @remarks
   * Only simple string entries in the context are treated as prefixes.
   * Expanded term definitions (`{ '@id': ... }`) are skipped.
   *
   * @param context - The raw `@context` value from the document.
   * @returns Record of prefix label → base IRI.
   */
  static #extractPrefixes(context: unknown): Record<string, string> {
    if (context === null || typeof context !== 'object' || Array.isArray(context)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, val] of Object.entries(context as Record<string, unknown>)) {
      if (key.startsWith('@')) continue;
      if (typeof val === 'string') {
        result[key] = val;
      }
    }
    return result;
  }

  /**
   * Compacts a full IRI using longest-prefix match.
   *
   * @param iri     - Full IRI to compact.
   * @param prefixes - Prefix map (prefix → base IRI).
   * @returns Compacted form (`prefix:local`) or the original IRI.
   */
  static #compactIri(iri: string, prefixes: Record<string, string>): string {
    let bestPrefix = '';
    let bestBase   = '';

    for (const [prefix, base] of Object.entries(prefixes)) {
      if (iri.startsWith(base) && base.length > bestBase.length) {
        bestPrefix = prefix;
        bestBase   = base;
      }
    }

    if (bestBase.length === 0) return iri;

    const local = iri.slice(bestBase.length);
    if (local.length === 0) return iri;

    return `${bestPrefix}:${local}`;
  }

  /**
   * Picks a human-readable label from an expanded entity's literal properties.
   *
   * @remarks
   * Scans all properties on the expanded entity. For each property whose
   * local name (after the last `#` or `/`) is one of `name`, `title`, or
   * `label`, takes the first literal `@value`. Returns the best match by
   * priority order (name > title > label) or `undefined` when none found.
   *
   * @param obj - Expanded entity object.
   * @returns Human-readable label string, or `undefined`.
   */
  static #pickHumanLabel(obj: Record<string, unknown>): string | undefined {
    const NAME_LOCAL_NAMES = ['name', 'title', 'label'] as const;
    const candidates: Array<{ priority: number; value: string }> = [];

    for (const [iri, val] of Object.entries(obj)) {
      if (iri.startsWith('@')) continue;
      const segments = iri.split(/[#/]/);
      const localName = segments[segments.length - 1]?.toLowerCase();
      if (!localName) continue;
      const idx = NAME_LOCAL_NAMES.indexOf(localName as 'name' | 'title' | 'label');
      if (idx === -1) continue;
      if (!Array.isArray(val) || val.length === 0) continue;
      const first = val[0];
      if (
        first !== null &&
        typeof first === 'object' &&
        !Array.isArray(first) &&
        '@value' in (first as Record<string, unknown>) &&
        typeof (first as Record<string, unknown>)['@value'] === 'string'
      ) {
        candidates.push({ priority: idx, value: (first as Record<string, unknown>)['@value'] as string });
      }
    }

    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates[0]!.value;
  }

  /**
   * Derives a human-friendlier label from a compacted IRI for implicit-IRI
   * nodes (referenced targets that have no explicit entity definition).
   *
   * @remarks
   * Strips the prefix label, then strips a leading `TypeName-` segment if
   * the dash appears within the first 20 characters.
   *
   * Examples:
   * - `aonprd:Trait-flourish` → `'flourish'`
   * - `aonprd:Rarity-common` → `'common'`
   * - `aonprd:ActionCost-two` → `'two'`
   *
   * @param iri      - Full IRI of the implicit node.
   * @param prefixes - Prefix map for compaction.
   * @returns Human-friendlier label string.
   */
  static #implicitIriLabel(iri: string, prefixes: Record<string, string>): string {
    const compacted = JsonLdGraph.#compactIri(iri, prefixes);
    const colonIdx  = compacted.indexOf(':');
    const local     = colonIdx >= 0 ? compacted.slice(colonIdx + 1) : compacted;
    const dashIdx   = local.indexOf('-');
    return (dashIdx > 0 && dashIdx < 20) ? local.slice(dashIdx + 1) : local;
  }

  /**
   * Walks a single expanded entity object, creating or updating a
   * `WorkingNodeInterface` in `nodeMap` and appending edges.
   *
   * @remarks
   * In the expanded form:
   * - `@id` is always a full IRI string.
   * - `@type` is always an array of full IRI strings.
   * - Object references are always `[{ "@id": "..." }]`.
   * - Literals are always `[{ "@value": ..., "@type"?: "..." }]`.
   *
   * @param entity   - Raw expanded entity object.
   * @param prefixes - Prefix map for compaction.
   * @param graphIri - Named graph IRI, if the entity lives in one.
   * @param nodeMap  - Mutable node accumulator.
   * @param edges    - Mutable edge accumulator.
   */
  static #walkExpandedEntity(
    entity:   unknown,
    prefixes: Record<string, string>,
    graphIri: string | undefined,
    nodeMap:  Map<string, WorkingNodeInterface>,
    edges:    VizEdgeInterface[],
  ): void {
    if (entity === null || typeof entity !== 'object' || Array.isArray(entity)) return;

    const obj = entity as Record<string, unknown>;
    const id  = obj['@id'];
    if (typeof id !== 'string' || id.length === 0) return;

    // Get or create the working node.
    let node = nodeMap.get(id);
    if (node === undefined) {
      // Prefer a human-readable name literal over the compacted IRI.
      const humanLabel = JsonLdGraph.#pickHumanLabel(obj);
      const label      = humanLabel ?? JsonLdGraph.#compactIri(id, prefixes);
      // In expanded form @type is an array of full IRIs.
      const typeArr    = obj['@type'];
      const classIri   = Array.isArray(typeArr) && typeof typeArr[0] === 'string'
        ? typeArr[0]
        : undefined;
      const classLabel = classIri !== undefined
        ? JsonLdGraph.#compactIri(classIri, prefixes)
        : undefined;

      node = { id, label, classIri, classLabel, graphIri, properties: {} };
      nodeMap.set(id, node);
    } else {
      if (node.graphIri === undefined && graphIri !== undefined) {
        node.graphIri = graphIri;
      }
    }

    // Walk properties (all values are arrays in expanded form).
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('@')) continue;

      // In expanded form the predicate key is always a full IRI.
      const predLabel = JsonLdGraph.#compactIri(key, prefixes);
      const values    = Array.isArray(value) ? value : [value];

      for (const val of values) {
        if (val === null || val === undefined) continue;

        if (typeof val === 'object' && !Array.isArray(val)) {
          const valObj = val as Record<string, unknown>;

          if (typeof valObj['@id'] === 'string') {
            // Object reference -> edge.
            const targetId = valObj['@id'] as string;
            const edgeId   = `${id}--${predLabel}->>${targetId}`;
            edges.push({
              id:       edgeId,
              source:   id,
              target:   targetId,
              label:    predLabel,
              graphIri,
            });
          } else if ('@value' in valObj) {
            // Literal with @value.
            const str = String(valObj['@value'] ?? '');
            JsonLdGraph.#addProperty(node.properties, predLabel, str);
          }
        } else if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
          // Plain primitive literal (should not appear in expanded form, but
          // handle defensively).
          JsonLdGraph.#addProperty(node.properties, predLabel, String(val));
        }
      }
    }
  }

  /**
   * Walks a single entity object in compacted form (legacy path).
   *
   * @param entity   - Raw entity object (must have `@id`).
   * @param prefixes - Prefix map for compaction.
   * @param graphIri - Named graph IRI, if the entity lives in one.
   * @param nodeMap  - Mutable node accumulator.
   * @param edges    - Mutable edge accumulator.
   */
  static #walkEntity(
    entity:   unknown,
    prefixes: Record<string, string>,
    graphIri: string | undefined,
    nodeMap:  Map<string, WorkingNodeInterface>,
    edges:    VizEdgeInterface[],
  ): void {
    if (entity === null || typeof entity !== 'object' || Array.isArray(entity)) return;

    const obj = entity as Record<string, unknown>;
    const id  = obj['@id'];
    if (typeof id !== 'string' || id.length === 0) return;

    let node = nodeMap.get(id);
    if (node === undefined) {
      const label      = JsonLdGraph.#compactIri(id, prefixes);
      const classIri   = JsonLdGraph.#extractFirstType(obj['@type']);
      const classLabel = classIri !== undefined
        ? JsonLdGraph.#compactIri(classIri, prefixes)
        : undefined;

      node = { id, label, classIri, classLabel, graphIri, properties: {} };
      nodeMap.set(id, node);
    } else {
      if (node.graphIri === undefined && graphIri !== undefined) {
        node.graphIri = graphIri;
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('@')) continue;

      const predLabel = JsonLdGraph.#compactIri(key, prefixes);
      const values = Array.isArray(value) ? value : [value];

      for (const val of values) {
        if (val === null || val === undefined) continue;

        if (typeof val === 'object' && !Array.isArray(val)) {
          const valObj = val as Record<string, unknown>;

          if (typeof valObj['@id'] === 'string') {
            const targetId = valObj['@id'] as string;
            const edgeId   = `${id}--${predLabel}->>${targetId}`;
            edges.push({
              id:       edgeId,
              source:   id,
              target:   targetId,
              label:    predLabel,
              graphIri,
            });
          } else if ('@value' in valObj) {
            const str = String(valObj['@value'] ?? '');
            JsonLdGraph.#addProperty(node.properties, predLabel, str);
          }
        } else if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
          JsonLdGraph.#addProperty(node.properties, predLabel, String(val));
        }
      }
    }
  }

  /**
   * Extracts the first `@type` IRI from a JSON-LD type value.
   *
   * @param typeVal - Raw `@type` value (string, array, or absent).
   * @returns The first type IRI string, or `undefined`.
   */
  static #extractFirstType(typeVal: unknown): string | undefined {
    if (typeof typeVal === 'string') return typeVal;
    if (Array.isArray(typeVal)) {
      const first = typeVal[0];
      return typeof first === 'string' ? first : undefined;
    }
    return undefined;
  }

  /**
   * Appends a value to a property array, creating the array if absent.
   *
   * @param properties - The mutable properties map.
   * @param predicate  - Compacted predicate label.
   * @param value      - String value to append.
   */
  static #addProperty(
    properties: Record<string, string[]>,
    predicate:  string,
    value:      string,
  ): void {
    const arr = properties[predicate];
    if (arr !== undefined) {
      arr.push(value);
    } else {
      properties[predicate] = [value];
    }
  }

  /**
   * Returns a new properties record with keys sorted lexicographically and
   * each array's contents preserved.
   *
   * @param properties - Mutable properties map.
   * @returns Sorted, frozen-compatible record.
   */
  static #sortedProperties(
    properties: Record<string, string[]>,
  ): Readonly<Record<string, ReadonlyArray<string>>> {
    const sorted: Record<string, ReadonlyArray<string>> = {};
    for (const key of Object.keys(properties).sort()) {
      sorted[key] = properties[key] as ReadonlyArray<string>;
    }
    return sorted;
  }
}
