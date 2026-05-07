/**
 * @fileoverview ChunkBuilder — partition a JsonLdGraph payload into per-named-graph
 * chunks with baked positions.
 * @module viz/ChunkBuilder
 *
 * Pipeline:
 *   1. Partition payload nodes/edges by `graphIri` (one bucket per named graph,
 *      plus an `__default__` bucket for orphans).
 *   2. For each bucket: build a graphology `MultiDirectedGraph`, run ForceAtlas2
 *      INDEPENDENTLY to lay out that subgraph in its own coordinate frame.
 *   3. Translate each subgraph's coordinates onto a tile of a larger grid so
 *      the 14 named graphs occupy visually distinct regions of the canvas.
 *   4. Emit one JSON file per non-empty chunk + `index.json` sorted by ascending
 *      node count (smallest first → fastest visible response).
 *
 * Cross-chunk edges (an edge whose source/target are in different named graphs)
 * are emitted with the source chunk; the target chunk holds its own copy of
 * the target node so the runtime can resolve the edge regardless of load order.
 */
import { MultiDirectedGraph } from 'graphology';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

import type { VizPayloadInterface } from './JsonLdGraph.js';

// graphology-layout-forceatlas2 ships a single CJS function with `.assign` and
// `.inferSettings` attached. Under NodeNext ESM both pieces only resolve via
// a direct require; the .d.ts named-export forms are TS-only fictions.
const requireCjs = createRequire(import.meta.url);
interface FA2InvokerInterface {
  assign:        (graph: MultiDirectedGraph, params: { iterations: number; settings: object }) => void;
  inferSettings: (graph: MultiDirectedGraph) => Record<string, unknown>;
}
const fa2 = requireCjs('graphology-layout-forceatlas2') as FA2InvokerInterface;

/**
 * Manifest entry written into `index.json` — one per non-empty chunk file.
 *
 * @category Viz
 * @since 0.2.0
 * @group Types
 */
export interface ChunkManifestEntryInterface {
  readonly id:        string;
  readonly label:     string;
  readonly slug:      string;
  readonly file:      string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** Hex color used for both the chunk's nodes (fill) and its row in the legend. */
  readonly color:     string;
}

/**
 * One chunk on disk. Mirrors the JSON shape the runtime fetches and merges.
 *
 * @category Viz
 * @since 0.2.0
 * @group Types
 */
export interface ChunkInterface {
  readonly id:    string;
  readonly label: string;
  readonly slug:  string;
  readonly color: string;
  readonly nodes: ReadonlyArray<ChunkNodeInterface>;
  readonly edges: ReadonlyArray<ChunkEdgeInterface>;
}

/**
 * Node entry inside a chunk file.
 *
 * @category Viz
 * @since 0.2.0
 * @group Types
 */
export interface ChunkNodeInterface {
  readonly id:         string;
  readonly label:      string;
  readonly classIri:   string;
  readonly classLabel: string;
  readonly x:          number;
  readonly y:          number;
  /** Hex color (matches the chunk color so chunks read as visually grouped). */
  readonly color:      string;
  /** Degree-derived render size (sigma's canonical `degree/3` pattern). */
  readonly size:       number;
  readonly properties: Readonly<Record<string, ReadonlyArray<string>>>;
}

/**
 * Edge entry inside a chunk file.
 *
 * @category Viz
 * @since 0.2.0
 * @group Types
 */
export interface ChunkEdgeInterface {
  readonly id:     string;
  readonly source: string;
  readonly target: string;
  readonly label:  string;
  readonly color:  string;
}

/**
 * Options for `ChunkBuilder.build()`.
 *
 * @category Viz
 * @since 0.2.0
 * @group Types
 */
export interface ChunkBuildOptionsInterface {
  readonly outDir:      string;
  readonly iterations?: number;
  readonly onChunk?:    (entry: ChunkManifestEntryInterface) => void;
}

const DEFAULT_GRAPH_ID    = '__default__';
const DEFAULT_GRAPH_LABEL = 'Ontology / class graph';

/**
 * Categorical palette — 16 visually-distinct hex colors that read well on the
 * `#0a0a0a` canvas. Picked manually for max separation; we cycle through.
 * (Tableau-10 + a few extras tuned for our eggplant-on-black brand.)
 */
const CATEGORICAL_PALETTE: ReadonlyArray<string> = [
  '#c09fef', // squashage lavender
  '#e94560', // squashage rose
  '#ffb13c', // amber
  '#4dd0e1', // cyan
  '#81c784', // green
  '#ffd54f', // sunflower
  '#ba68c8', // orchid
  '#ff8a65', // coral
  '#90caf9', // sky
  '#aed581', // chartreuse
  '#f06292', // pink
  '#7986cb', // periwinkle
  '#ffb74d', // tangerine
  '#a1887f', // taupe
  '#dce775', // lime
  '#4fc3f7', // azure
];

interface MutableChunkInterface {
  id:    string;
  label: string;
  slug:  string;
  color: string;
  nodes: ChunkNodeInterface[];
  edges: ChunkEdgeInterface[];
}

interface BucketInterface {
  id:    string;
  label: string;
  slug:  string;
  color: string;
  /** Set of node IDs anchored to this bucket (whose node.graphIri === id). */
  nodeIds: Set<string>;
  /** Edges where source belongs to this bucket. */
  edges: ReadonlyArray<{ id: string; source: string; target: string; label: string }>[number][];
}

/**
 * Builds chunked graph artifacts from a `JsonLdGraph` payload.
 *
 * @remarks
 * Static-only. Run at build time (Node).
 *
 * @category Viz
 * @since 0.2.0
 * @group Core
 */
export class ChunkBuilder {
  private constructor() { /* static-only */ }

  /**
   * Builds chunks and writes:
   *   `<outDir>/index.json`
   *   `<outDir>/chunks/<slug>.json` (one per non-empty chunk)
   *
   * @returns The manifest entries written to `index.json`.
   */
  static async build(
    payload: VizPayloadInterface,
    opts:    ChunkBuildOptionsInterface,
  ): Promise<ChunkManifestEntryInterface[]> {
    const iterations = opts.iterations ?? 600;
    const outDir     = resolve(opts.outDir);
    const chunksDir  = join(outDir, 'chunks');
    await mkdir(chunksDir, { recursive: true });

    // --- 1. Bucket nodes/edges by graphIri --------------------------------
    const buckets = new Map<string, BucketInterface>();
    const ensureBucket = (id: string, label: string): BucketInterface => {
      let b = buckets.get(id);
      if (!b) {
        const slug  = ChunkBuilder.#slug(label);
        const color = CATEGORICAL_PALETTE[buckets.size % CATEGORICAL_PALETTE.length] as string;
        b = { id, label, slug, color, nodeIds: new Set(), edges: [] };
        buckets.set(id, b);
      }
      return b;
    };

    // Pre-create buckets for declared named graphs so palette assignment is
    // deterministic by index order.
    for (const g of payload.graphs) ensureBucket(g.id, g.label);
    ensureBucket(DEFAULT_GRAPH_ID, DEFAULT_GRAPH_LABEL);

    // Fast lookup: nodeId -> bucketId
    const nodeBucket = new Map<string, string>();
    for (const n of payload.nodes) {
      const isKnown   = n.graphIri !== undefined && buckets.has(n.graphIri);
      const bucketId  = isKnown ? (n.graphIri as string) : DEFAULT_GRAPH_ID;
      const bucket    = buckets.get(bucketId);
      if (bucket === undefined) continue;
      bucket.nodeIds.add(n.id);
      nodeBucket.set(n.id, bucketId);
    }
    for (const e of payload.edges) {
      const srcBucket = nodeBucket.get(e.source) ?? DEFAULT_GRAPH_ID;
      const bucket    = buckets.get(srcBucket);
      if (bucket === undefined) continue;
      bucket.edges.push({ id: e.id, source: e.source, target: e.target, label: e.label });
    }

    // --- 2. Per-bucket FA2, then grid placement ---------------------------
    // Sort buckets by ascending node count so smallest land in the first grid
    // cell (the streaming UX picks them up first too).
    const orderedBuckets = Array.from(buckets.values())
      .filter((b) => b.nodeIds.size > 0)
      .sort((a, b) => a.nodeIds.size - b.nodeIds.size);

    const cols     = Math.max(1, Math.ceil(Math.sqrt(orderedBuckets.length)));
    const tileSize = 1200; // each tile is 1200×1200 logical units.
    const tilePad  = 200;  // gap between tiles.
    const stride   = tileSize + tilePad;

    const positions = new Map<string, { x: number; y: number }>();

    orderedBuckets.forEach((bucket, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const cx  = col * stride;
      const cy  = row * stride;

      const sub = new MultiDirectedGraph();
      // Initial positions: random spread proportional to sqrt(N) so dense
      // graphs start spread out and FA2 only has to refine, not separate.
      const initSpread = Math.max(20, Math.sqrt(bucket.nodeIds.size) * 8);
      for (const id of bucket.nodeIds) {
        sub.addNode(id, {
          x: ChunkBuilder.#seededRand(id + 'x') * initSpread,
          y: ChunkBuilder.#seededRand(id + 'y') * initSpread,
        });
      }
      for (const e of bucket.edges) {
        if (sub.hasNode(e.source) && sub.hasNode(e.target) && !sub.hasEdge(e.id)) {
          sub.addEdgeWithKey(e.id, e.source, e.target);
        }
      }

      // Canonical: inferSettings handles size-appropriate gravity/scalingRatio/
      // barnesHutOptimize/slowDown for us. Don't second-guess it.
      const settings = fa2.inferSettings(sub);
      fa2.assign(sub, { iterations, settings });

      // Find subgraph bbox to normalise into the tile.
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      sub.forEachNode((_id, attrs) => {
        const x = attrs['x'] as number;
        const y = attrs['y'] as number;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      });
      const dx = maxX - minX || 1;
      const dy = maxY - minY || 1;
      const scale = Math.min(tileSize / dx, tileSize / dy);
      sub.forEachNode((id, attrs) => {
        const x = ((attrs['x'] as number) - minX) * scale - tileSize / 2;
        const y = ((attrs['y'] as number) - minY) * scale - tileSize / 2;
        positions.set(id, { x: cx + x, y: cy + y });
      });
    });

    // --- 3. Build chunk objects -------------------------------------------
    const chunkMap = new Map<string, MutableChunkInterface>();
    for (const bucket of orderedBuckets) {
      chunkMap.set(bucket.id, {
        id:    bucket.id,
        label: bucket.label,
        slug:  bucket.slug,
        color: bucket.color,
        nodes: [],
        edges: [],
      });
    }

    // Compute global degree per node (across all chunks) so size reflects
    // the node's true importance, not just its in-chunk connections.
    const degree = new Map<string, number>();
    for (const e of payload.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    for (const n of payload.nodes) {
      const bucketId = nodeBucket.get(n.id);
      if (bucketId === undefined) continue;
      const chunk = chunkMap.get(bucketId);
      const pos   = positions.get(n.id);
      if (chunk === undefined || pos === undefined) continue;
      const d = degree.get(n.id) ?? 0;
      chunk.nodes.push({
        id:         n.id,
        label:      n.label,
        classIri:   n.classIri  ?? '',
        classLabel: n.classLabel ?? '',
        x:          pos.x,
        y:          pos.y,
        color:      chunk.color,
        // Sigma canonical: size = degree / 3 (capped to a sane band).
        size:       Math.max(2, Math.min(20, d / 3)),
        properties: n.properties,
      });
    }

    for (const e of payload.edges) {
      const srcBucket = nodeBucket.get(e.source) ?? DEFAULT_GRAPH_ID;
      const chunk     = chunkMap.get(srcBucket);
      if (chunk === undefined) continue;
      chunk.edges.push({
        id:     e.id,
        source: e.source,
        target: e.target,
        label:  e.label,
        // Very low-contrast at rest — edges are background until a node is
        // hovered/selected, at which point the reducer recolors incident edges
        // to the rose accent and hides everything else.
        color:  '#222222',
      });
    }

    // --- 4. Sort, write files, build manifest -----------------------------
    const ordered = Array.from(chunkMap.values()).sort((a, b) => a.nodes.length - b.nodes.length);

    const manifest: ChunkManifestEntryInterface[] = [];
    for (const chunk of ordered) {
      if (chunk.nodes.length === 0 && chunk.edges.length === 0) continue;

      const file = `chunks/${chunk.slug}.json`;
      const data: ChunkInterface = {
        id:    chunk.id,
        label: chunk.label,
        slug:  chunk.slug,
        color: chunk.color,
        nodes: chunk.nodes,
        edges: chunk.edges,
      };
      await writeFile(join(outDir, file), JSON.stringify(data), 'utf-8');

      const entry: ChunkManifestEntryInterface = {
        id:        chunk.id,
        label:     chunk.label,
        slug:      chunk.slug,
        file,
        nodeCount: chunk.nodes.length,
        edgeCount: chunk.edges.length,
        color:     chunk.color,
      };
      manifest.push(entry);
      opts.onChunk?.(entry);
    }

    await writeFile(join(outDir, 'index.json'), JSON.stringify({ chunks: manifest }, null, 2), 'utf-8');
    return manifest;
  }

  // ---- Internals ----------------------------------------------------------

  static #seededRand(seed: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return ((h % 20000) - 10000) / 10000;
  }

  static #slug(label: string): string {
    const s = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s.length > 0 ? s : 'graph';
  }

  /** Fade a hex color toward `#0a0a0a` by the given alpha (0..1). */
}
