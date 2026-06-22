/**
 * @fileoverview QuadGraph — streams N-Quads / TriG / N-Triples / Turtle into
 * the same `VizPayloadInterface` ChunkBuilder consumes. Replaces the
 * JSON-LD-only `JsonLdGraph` for the canonical viz input path.
 *
 * Why a quad-based reader over JSON-LD:
 *   - Production output is already N-Quads (streaming serializer, P21b).
 *   - Line-streamable: O(line) memory, not O(graph).
 *   - Named graphs are first-class in N-Quads / TriG (no `@graph` wrapper
 *     gymnastics).
 *   - One parser (n3.js) instead of n3 + jsonld + a hand-rolled converter.
 *
 * Output payload is structurally identical to `JsonLdGraph.fromJsonLd` so
 * `ChunkBuilder.build(payload, ...)` works unchanged.
 *
 * @module viz/QuadGraph
 * @category Viz
 * @since 0.10.0
 */

import type { Readable } from 'node:stream';

import type { Quad } from '@rdfjs/types';

import { Parser } from '../rdf/Parser.js';
import type { RDFFormat } from '../rdf/Formats.js';

import type {
  VizEdgeInterface,
  VizGraphDescriptorInterface,
  VizNodeInterface,
  VizPayloadInterface,
} from './JsonLdGraph.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const NAME_LOCAL_NAMES = ['name', 'title', 'label'] as const;

interface WorkingNodeInterface {
  id:         string;
  label:      string | undefined;
  classIri:   string | undefined;
  classLabel: string | undefined;
  graphIri:   string | undefined;
  /** All `rdf:type` object IRIs seen for this subject (insertion order). */
  typeIris:   Set<string>;
  /** literal property: predicate IRI → array of literal values */
  literalProps: Map<string, string[]>;
  /** Best-label candidate: `{ priority, value }`. Lower priority wins. */
  labelCandidate: { priority: number; value: string } | null;
}

/**
 * Core supertype local names that are never the most-specific concept. When a
 * subject declares several `rdf:type`s, these generic ancestors are deprioritised
 * so `classIri` resolves to the concept-bearing type.
 */
const CORE_SUPERTYPE_LOCALS = new Set(['thing', 'namedthing', 'contententry']);

/**
 * Format hint for the source data. Defaults to nquads.
 */
export type QuadGraphFormat = Exclude<RDFFormat, 'jsonld'>;

/**
 * Streaming N-Quads / TriG / N-Triples / Turtle → `VizPayloadInterface`.
 *
 * `fromQuadsFile(path)` returns the same payload shape as
 * `JsonLdGraph.fromJsonLd`. ChunkBuilder consumes the result unchanged.
 *
 * @category Viz
 * @since 0.10.0
 */
export class QuadGraph {
  private constructor() { /* static-only */ }

  /**
   * Read a quad file and build a viz payload.
   *
   * @param path     - Filesystem path to the input file.
   * @param prefixes - Optional prefix map for compaction of node / edge labels.
   *                   When omitted, the parser collects any `@prefix` declarations
   *                   in TriG / Turtle inputs; N-Quads has no prefix syntax so the
   *                   default is empty.
   * @param format   - Input format. Defaults to N-Quads.
   */
  static async fromQuadsFile(
    path:     string,
    prefixes: Readonly<Record<string, string>> = {},
    format:   QuadGraphFormat = 'nquads',
  ): Promise<VizPayloadInterface> {
    const nodeMap = new Map<string, WorkingNodeInterface>();
    const edges:   VizEdgeInterface[] = [];
    const graphIris = new Set<string>();

    for await (const q of Parser.streamFile(path, format)) {
      QuadGraph.#absorbQuad(q, nodeMap, edges, graphIris);
    }

    return QuadGraph.#materialize(nodeMap, edges, graphIris, { ...prefixes });
  }

  /**
   * Read quads from any text-emitting `Readable` (network / pipe / fs) and
   * build a payload.
   */
  static async fromStream(
    stream:   Readable,
    prefixes: Readonly<Record<string, string>> = {},
    format:   QuadGraphFormat = 'nquads',
  ): Promise<VizPayloadInterface> {
    const nodeMap = new Map<string, WorkingNodeInterface>();
    const edges:   VizEdgeInterface[] = [];
    const graphIris = new Set<string>();

    for await (const q of Parser.streamReadable(stream, format)) {
      QuadGraph.#absorbQuad(q, nodeMap, edges, graphIris);
    }

    return QuadGraph.#materialize(nodeMap, edges, graphIris, { ...prefixes });
  }

  /**
   * Build a payload directly from an array (or iterable) of `@rdfjs/types` Quads.
   * Useful for tests that have quads in memory already.
   */
  static fromQuads(
    quads:    Iterable<Quad>,
    prefixes: Readonly<Record<string, string>> = {},
  ): VizPayloadInterface {
    const nodeMap = new Map<string, WorkingNodeInterface>();
    const edges:   VizEdgeInterface[] = [];
    const graphIris = new Set<string>();

    for (const q of quads) QuadGraph.#absorbQuad(q, nodeMap, edges, graphIris);

    return QuadGraph.#materialize(nodeMap, edges, graphIris, { ...prefixes });
  }

  /**
   * Convenience: parse a string of N-Quads / TriG / Turtle / N-Triples
   * asynchronously (small inputs / tests).
   */
  static async fromText(
    text:     string,
    prefixes: Readonly<Record<string, string>> = {},
    format:   QuadGraphFormat = 'nquads',
  ): Promise<VizPayloadInterface> {
    const { quads } = await Parser.parse(text, { format });
    return QuadGraph.fromQuads(quads, prefixes);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  static #absorbQuad(
    quad:      Quad,
    nodeMap:   Map<string, WorkingNodeInterface>,
    edges:     VizEdgeInterface[],
    graphIris: Set<string>,
  ): void {
    const subjectIri = quad.subject.value;
    const predIri    = quad.predicate.value;
    const graphIri   = quad.graph.termType === 'NamedNode' ? quad.graph.value : undefined;

    if (graphIri !== undefined) graphIris.add(graphIri);

    // Ensure a working node for the subject.
    let subjNode = nodeMap.get(subjectIri);
    if (subjNode === undefined) {
      subjNode = {
        id:             subjectIri,
        label:          undefined,
        classIri:       undefined,
        classLabel:     undefined,
        graphIri,
        typeIris:       new Set(),
        literalProps:   new Map(),
        labelCandidate: null,
      };
      nodeMap.set(subjectIri, subjNode);
    } else if (subjNode.graphIri === undefined && graphIri !== undefined) {
      subjNode.graphIri = graphIri;
    }

    // rdf:type — collect ALL types; the most-specific is chosen at materialize
    // time (see #resolveClassIri). The first hit also seeds `classIri` so nodes
    // with a single type behave exactly as before.
    if (predIri === RDF_TYPE && quad.object.termType === 'NamedNode') {
      subjNode.typeIris.add(quad.object.value);
      if (subjNode.classIri === undefined) {
        subjNode.classIri = quad.object.value;
      }
      return;
    }

    if (quad.object.termType === 'Literal') {
      const value = quad.object.value;
      // Track property under predicate IRI key.
      const arr = subjNode.literalProps.get(predIri);
      if (arr === undefined) subjNode.literalProps.set(predIri, [value]);
      else arr.push(value);

      // Possible human-readable label candidate.
      const local = QuadGraph.#localName(predIri).toLowerCase();
      const idx = NAME_LOCAL_NAMES.indexOf(local as 'name' | 'title' | 'label');
      if (idx !== -1) {
        const existing = subjNode.labelCandidate;
        if (existing === null || idx < existing.priority) {
          subjNode.labelCandidate = { priority: idx, value };
        }
      }
      return;
    }

    if (quad.object.termType === 'NamedNode' || quad.object.termType === 'BlankNode') {
      const targetId = quad.object.termType === 'BlankNode'
        ? `_:${quad.object.value}`
        : quad.object.value;
      edges.push({
        id:       `${subjectIri}--${predIri}->>${targetId}`,
        source:   subjectIri,
        target:   targetId,
        label:    predIri,  // compact later in #materialize
        graphIri,
      });
      return;
    }
  }

  static #materialize(
    nodeMap:   Map<string, WorkingNodeInterface>,
    edges:     VizEdgeInterface[],
    graphIris: Set<string>,
    prefixes:  Record<string, string>,
  ): VizPayloadInterface {
    // Ensure edge endpoints exist as nodes (referenced-only targets).
    for (const e of edges) {
      if (!nodeMap.has(e.target)) {
        nodeMap.set(e.target, {
          id:             e.target,
          label:          undefined,
          classIri:       undefined,
          classLabel:     undefined,
          graphIri:       e.graphIri,
          typeIris:       new Set(),
          literalProps:   new Map(),
          labelCandidate: null,
        });
      }
    }

    // Build sorted final nodes.
    const nodes: VizNodeInterface[] = [];
    for (const wn of nodeMap.values()) {
      const label = wn.labelCandidate !== null
        ? wn.labelCandidate.value
        : QuadGraph.#implicitIriLabel(wn.id, prefixes);

      // Resolve the most-specific type as classIri (over the first-seen one,
      // which is frequently a generic supertype like Thing / NamedThing).
      const resolvedClassIri = QuadGraph.#resolveClassIri(wn);
      const classLabel = resolvedClassIri !== undefined
        ? QuadGraph.#compactIri(resolvedClassIri, prefixes)
        : undefined;

      // Compact literal property keys to compacted IRI labels, sort by key.
      const compactedProps: Record<string, string[]> = {};
      for (const [iri, vals] of wn.literalProps) {
        const key = QuadGraph.#compactIri(iri, prefixes);
        if (compactedProps[key] === undefined) compactedProps[key] = [];
        compactedProps[key].push(...vals);
      }
      const properties: Record<string, ReadonlyArray<string>> = {};
      for (const k of Object.keys(compactedProps).sort()) {
        properties[k] = compactedProps[k] as string[];
      }

      nodes.push({
        id:         wn.id,
        label,
        classIri:   resolvedClassIri,
        classLabel,
        graphIri:   wn.graphIri,
        properties,
      });
    }

    // Compact edge labels + sort.
    const finalEdges: VizEdgeInterface[] = edges.map((e) => ({
      id:       e.id,
      source:   e.source,
      target:   e.target,
      label:    QuadGraph.#compactIri(e.label, prefixes),
      graphIri: e.graphIri,
    }));
    finalEdges.sort((a, b) => {
      const sa = `${a.source}\x00${a.label}\x00${a.target}`;
      const sb = `${b.source}\x00${b.label}\x00${b.target}`;
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });

    // Build sorted graph descriptors.
    const graphs: VizGraphDescriptorInterface[] = [...graphIris]
      .sort()
      .map((iri) => ({ id: iri, label: QuadGraph.#compactIri(iri, prefixes) }));

    return { nodes, edges: finalEdges, graphs, prefixes };
  }

  /**
   * Choose the most-specific `rdf:type` for a node. A subject often declares
   * several types — its concept plus generic supertypes (Thing / NamedThing /
   * ContentEntry). Selection order, all deterministic:
   *   1. The type whose local name matches the node's named-graph concept.
   *   2. Any type that is not a core supertype (first in insertion order).
   *   3. The first-seen type (the original behaviour).
   */
  static #resolveClassIri(wn: WorkingNodeInterface): string | undefined {
    if (wn.typeIris.size === 0) return wn.classIri;

    const types = [...wn.typeIris];

    // 1. Prefer the type matching the named-graph concept local name.
    if (wn.graphIri !== undefined) {
      const concept = QuadGraph.#localName(wn.graphIri).toLowerCase();
      const match = types.find((t) => QuadGraph.#localName(t).toLowerCase() === concept);
      if (match !== undefined) return match;
    }

    // 2. Prefer any non-core-supertype.
    const specific = types.find((t) => !CORE_SUPERTYPE_LOCALS.has(QuadGraph.#localName(t).toLowerCase()));
    if (specific !== undefined) return specific;

    // 3. Fall back to the first-seen type.
    return types[0];
  }

  static #compactIri(iri: string, prefixes: Record<string, string>): string {
    // Longest-prefix-first wins.
    let bestPrefix:    string | null = null;
    let bestBaseIri:   string = '';
    for (const [prefix, baseIri] of Object.entries(prefixes)) {
      if (iri.startsWith(baseIri) && baseIri.length > bestBaseIri.length) {
        bestPrefix  = prefix;
        bestBaseIri = baseIri;
      }
    }
    if (bestPrefix !== null) return `${bestPrefix}:${iri.slice(bestBaseIri.length)}`;
    return iri;
  }

  static #localName(iri: string): string {
    const segs = iri.split(/[#/]/);
    return segs[segs.length - 1] ?? '';
  }

  static #implicitIriLabel(iri: string, prefixes: Record<string, string>): string {
    const compacted = QuadGraph.#compactIri(iri, prefixes);
    const colonIdx  = compacted.indexOf(':');
    const local     = colonIdx >= 0 ? compacted.slice(colonIdx + 1) : compacted;
    const dashIdx   = local.indexOf('-');
    return (dashIdx > 0 && dashIdx < 20) ? local.slice(dashIdx + 1) : local;
  }
}
