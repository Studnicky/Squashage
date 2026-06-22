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
import { createWriteStream } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';

import type { VizPayloadInterface } from './JsonLdGraph.js';
import { ConceptPalette } from './ConceptPalette.js';
import { BinaryGraphWriter } from './BinaryGraphWriter.js';
import {
  FRAME_VERSION,
  MANIFEST_FORMAT,
  POSITION_STRIDE,
  COLOR_STRIDE,
  EDGE_STRIDE,
} from './BinaryFrameFormat.js';
import type {
  BinaryFrameManifestEntryInterface,
  BinaryFrameManifestInterface,
} from './BinaryFrameFormat.js';

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
 * Result of the shared bucketing + per-bucket FA2 + grid-placement layout pass.
 * Consumed by both the JSON (`build`) and binary (`buildBinary`) emitters.
 */
interface LayoutResultInterface {
  /** Non-empty buckets, ascending by node count (smallest concept first). */
  orderedBuckets: BucketInterface[];
  /** Baked world position per node id. */
  positions:      Map<string, { x: number; y: number }>;
  /** Node id → owning bucket id. */
  nodeBucket:     Map<string, string>;
  /** Global degree (in + out) per node id. */
  degree:         Map<string, number>;
  /** Total x extent of the placed grid (max - min over all positions). */
  spanX:          number;
  /** Total y extent of the placed grid (max - min over all positions). */
  spanY:          number;
}

/**
 * Options for `ChunkBuilder.buildBinary()`.
 *
 * @category Viz
 * @since 0.10.0
 * @group Types
 */
export interface BinaryBuildOptionsInterface {
  /** Output directory; frames land in `<outDir>/frames/`. */
  readonly outDir:      string;
  /** FA2 iterations per bucket (default 600, matching the JSON path). */
  readonly iterations?: number;
  /** Invoked after each frame is written, in stream order. */
  readonly onFrame?:    (entry: BinaryFrameManifestEntryInterface) => void;
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

    const layout = ChunkBuilder.#computeLayout(payload, iterations);
    const { orderedBuckets, positions, nodeBucket, degree } = layout;

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
      // Stream-write the chunk JSON so we don't allocate one giant string
      // for the whole `nodes` + `edges` arrays. Large class chunks (e.g.
      // 90k Monster nodes) blow past V8's ~512MB string-length cap if we
      // JSON.stringify the whole object.
      await ChunkBuilder.#writeChunkStreaming(join(outDir, file), chunk);

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

  /**
   * Builds compact binary frames and writes:
   *   `<outDir>/manifest.json`
   *   `<outDir>/frames/frame-NNN.bin` (one per non-empty concept bucket)
   *
   * @remarks
   * Reuses the same bucketing, per-bucket ForceAtlas2 layout, grid placement,
   * and global degree as {@link build} (via the shared `#computeLayout` pass),
   * so the binary export reproduces the JSON path's positions exactly. Node
   * colors and sizes come from {@link ConceptPalette} keyed by each node's own
   * class IRI (per-concept), not the chunk's flat categorical color.
   *
   * Global node indices are assigned in frame order: frame 0 owns
   * `[0, n0)`, frame 1 owns `[n0, n0+n1)`, and so on. Edge endpoints are
   * GLOBAL indices so the streaming worker appends frames without remapping.
   * Edges belong to the frame whose bucket owns the edge SOURCE (matching the
   * JSON path); self-loops and edges with an unmapped endpoint are skipped.
   *
   * @param payload - The graph payload to export.
   * @param opts    - Output directory and layout options.
   * @returns The written {@link BinaryFrameManifestInterface}.
   */
  static async buildBinary(
    payload: VizPayloadInterface,
    opts:    BinaryBuildOptionsInterface,
  ): Promise<BinaryFrameManifestInterface> {
    const iterations = opts.iterations ?? 600;
    const outDir     = resolve(opts.outDir);
    const framesDir  = join(outDir, 'frames');
    await mkdir(framesDir, { recursive: true });

    const { orderedBuckets, positions, degree, spanX, spanY } =
      ChunkBuilder.#computeLayout(payload, iterations);

    // Stable per-bucket node ordering and global index assignment, walking
    // buckets in stream order (smallest concept first).
    const bucketNodeIds = new Map<string, string[]>();
    const globalIndex   = new Map<string, number>();
    let nextIndex = 0;
    for (const bucket of orderedBuckets) {
      // Only nodes that actually received a baked position participate.
      const ids = [...bucket.nodeIds].filter((id) => positions.has(id)).sort();
      bucketNodeIds.set(bucket.id, ids);
      for (const id of ids) {
        globalIndex.set(id, nextIndex);
        nextIndex += 1;
      }
    }

    const frames: BinaryFrameManifestEntryInterface[] = [];
    let frameNo    = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    for (const bucket of orderedBuckets) {
      const ids = bucketNodeIds.get(bucket.id) ?? [];
      if (ids.length === 0) continue;

      const nodeBase  = globalIndex.get(ids[0] as string) as number;
      const nodeCount = ids.length;

      const framePositions = new Float32Array(nodeCount * POSITION_STRIDE);
      const frameColors    = new Float32Array(nodeCount * COLOR_STRIDE);
      const frameSizes     = new Float32Array(nodeCount);

      // Concept color: the concept of a node is its NAMED GRAPH (the per-concept
      // partition: Monster, Spell, Generic, …) — `bucket.id` is that graph IRI.
      // ConceptPalette pins each concept to a maximally-distinct palette color,
      // so every node in a concept-frame shares that concept's hue and the graph
      // visibly separates concept clusters. (Per-node rdf:type is supertype-
      // dominated here, so it is NOT used as the color key.)
      const bucketHex = ConceptPalette.colorFor(bucket.id);
      const representativeColor = bucketHex;
      const rgba = ChunkBuilder.#hexToRgba(bucketHex);
      ids.forEach((id, i) => {
        const pos  = positions.get(id) as { x: number; y: number };
        framePositions[i * POSITION_STRIDE]     = pos.x;
        framePositions[i * POSITION_STRIDE + 1] = pos.y;

        frameColors[i * COLOR_STRIDE]     = rgba[0];
        frameColors[i * COLOR_STRIDE + 1] = rgba[1];
        frameColors[i * COLOR_STRIDE + 2] = rgba[2];
        frameColors[i * COLOR_STRIDE + 3] = rgba[3];

        frameSizes[i] = ConceptPalette.sizeFor(degree.get(id) ?? 0);
      });

      // Edges whose SOURCE belongs to this bucket; map both endpoints to global
      // indices, skip self-loops and edges with an unmapped endpoint.
      const edgePairs: number[] = [];
      for (const e of bucket.edges) {
        const src = globalIndex.get(e.source);
        const tgt = globalIndex.get(e.target);
        if (src === undefined || tgt === undefined || src === tgt) continue;
        edgePairs.push(src, tgt);
      }
      const frameEdges = Uint32Array.from(edgePairs);
      const edgeCount  = frameEdges.length / EDGE_STRIDE;

      const file = `frames/frame-${String(frameNo).padStart(3, '0')}.bin`;
      await BinaryGraphWriter.writeFrame(join(outDir, file), {
        positions: framePositions,
        colors:    frameColors,
        sizes:     frameSizes,
        edges:     frameEdges,
      });

      const entry: BinaryFrameManifestEntryInterface = {
        file,
        label:     bucket.label,
        color:     representativeColor,
        nodeCount,
        edgeCount,
        nodeBase,
      };
      frames.push(entry);
      opts.onFrame?.(entry);

      totalNodes += nodeCount;
      totalEdges += edgeCount;
      frameNo    += 1;
    }

    const manifest: BinaryFrameManifestInterface = {
      format:    MANIFEST_FORMAT,
      version:   FRAME_VERSION,
      // World extent that frames the whole placed grid; cosmos.gl `spaceSize`.
      spaceSize: Math.max(1, Math.ceil(Math.max(spanX, spanY))),
      totalNodes,
      totalEdges,
      frames,
    };
    await BinaryGraphWriter.writeManifest(join(outDir, 'manifest.json'), manifest);

    // Build a prefix-compressed node metadata sidecar so the viewer can
    // display IRI and label in the node inspector without bloating the
    // committed demo size. Format: squashage-node-meta-v2.
    //   prefixes:  string[]       — sorted base-IRI strings (e.g. "https://2e.aonprd.com/")
    //   pIdx:      Uint8-encoded  — per-node prefix index (stored as a flat number array)
    //   locals:    string[]       — per-node local name after stripping the prefix
    //   labels:    string[]       — per-node human label (may differ from local name)
    //
    // The viewer reconstructs the full IRI as: prefixes[pIdx[i]] + locals[i].
    // For nodes whose IRI does not start with any known prefix, pIdx[i] is -1
    // and locals[i] is the full IRI.
    //
    // This keeps the sidecar under ~5 MB raw (vs ~46 MB for full IRIs) because
    // the ~100-char base prefix is stored once, not 256k times.

    // Step 1: build node payload map.
    const nodePayloadMap = new Map<string, { id: string; label: string }>();
    for (const n of payload.nodes) nodePayloadMap.set(n.id, { id: n.id, label: n.label });

    // Step 2: collect all IRIs in global-index order to find common prefixes.
    const metaIrisFull: string[]  = new Array(nextIndex).fill('') as string[];
    const metaLabels:   string[]  = new Array(nextIndex).fill('') as string[];
    for (const bucket of orderedBuckets) {
      const ids = bucketNodeIds.get(bucket.id) ?? [];
      for (const id of ids) {
        const gIdx = globalIndex.get(id);
        if (gIdx === undefined) continue;
        const node = nodePayloadMap.get(id);
        metaIrisFull[gIdx] = node?.id    ?? id;
        metaLabels[gIdx]   = node?.label ?? '';
      }
    }

    // Step 3: discover prefix candidates by counting IRI base occurrences.
    // A "prefix" is the IRI up to and including the first `/` after the scheme
    // (e.g. `https://2e.aonprd.com/`) OR up to `#` (e.g. `https://example.com#`).
    const prefixCounts = new Map<string, number>();
    for (const iri of metaIrisFull) {
      if (iri.length === 0) continue;
      // Try scheme+authority prefix (e.g. "https://host/")
      const slashAfterScheme = iri.indexOf('/', iri.indexOf('://') + 3);
      const candidate        = slashAfterScheme >= 0 ? iri.slice(0, slashAfterScheme + 1) : iri;
      prefixCounts.set(candidate, (prefixCounts.get(candidate) ?? 0) + 1);
    }
    // Keep prefixes that cover at least 10 nodes (avoids one-off IRIs).
    const prefixes: string[] = Array.from(prefixCounts.entries())
      .filter(([, count]) => count >= 10)
      .sort(([a], [b]) => b.length - a.length) // longer prefix wins on tie
      .map(([p]) => p);

    // Step 4: encode per-node prefix index + local name.
    const pIdx:   number[] = new Array(nextIndex).fill(-1) as number[];
    const locals: string[] = new Array(nextIndex).fill('') as string[];
    for (let i = 0; i < nextIndex; i++) {
      const iri = metaIrisFull[i] as string;
      let matched = false;
      for (let p = 0; p < prefixes.length; p++) {
        const base = prefixes[p] as string;
        if (iri.startsWith(base)) {
          pIdx[i]   = p;
          locals[i] = iri.slice(base.length);
          matched   = true;
          break;
        }
      }
      if (!matched) {
        locals[i] = iri; // full IRI for unrecognized bases
      }
    }

    // Ship the sidecar gzip-compressed (meta.json.gz, ~2.5 MB) rather than raw
    // (~41 MB) so the committed demo stays small. The viewer decodes it in the
    // browser with the native DecompressionStream — no server gzip negotiation
    // and no build step on the consumer side.
    const metaJson = JSON.stringify({
      format:   'squashage-node-meta-v2',
      prefixes,
      pIdx,
      locals,
      labels: metaLabels,
    });
    const metaGzPath = join(outDir, 'meta.json.gz');
    const metaGz     = gzipSync(Buffer.from(metaJson, 'utf-8'), { level: 9 });
    await writeFile(metaGzPath, metaGz);
    console.log('[ChunkBuilder] meta.json.gz written: ' + String(totalNodes) + ' entries, ' +
      String(prefixes.length) + ' prefixes, ' +
      String(Math.round(metaGz.length / 1024)) + ' KB gzip (' +
      String(Math.round(metaJson.length / 1024)) + ' KB raw) → ' + metaGzPath);

    return manifest;
  }

  // ---- Internals ----------------------------------------------------------

  /**
   * Shared layout pass: bucket nodes/edges by `graphIri`, run per-bucket
   * ForceAtlas2, place each bucket on a grid tile, and compute global degree.
   * Both {@link build} and {@link buildBinary} consume this so they bake
   * identical positions.
   *
   * @param payload    - The graph payload to lay out.
   * @param iterations - FA2 iterations per bucket.
   * @returns Ordered buckets, baked positions, node→bucket map, degree, and
   *          the placed grid extent.
   */
  static #computeLayout(
    payload:    VizPayloadInterface,
    iterations: number,
  ): LayoutResultInterface {
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

    // Global degree (in + out) per node, across all buckets.
    const degree = new Map<string, number>();
    for (const e of payload.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    // Placed grid extent (frames the whole graph for cosmos.gl spaceSize).
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const { x, y } of positions.values()) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const spanX = positions.size > 0 ? maxX - minX : 0;
    const spanY = positions.size > 0 ? maxY - minY : 0;

    return { orderedBuckets, positions, nodeBucket, degree, spanX, spanY };
  }

  /**
   * Parses a `#rrggbb` hex color into normalized RGBA floats `[r, g, b, 1]`,
   * each channel in `[0, 1]`. Malformed input yields opaque white.
   *
   * @param hex - A `#rrggbb` color string.
   * @returns A 4-tuple of floats in `[0, 1]` (alpha always 1).
   */
  static #hexToRgba(hex: string): [number, number, number, number] {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
    if (m === null) return [1, 1, 1, 1];
    const n = Number.parseInt(m[1] as string, 16);
    const r = ((n >> 16) & 0xff) / 255;
    const g = ((n >> 8) & 0xff) / 255;
    const b = (n & 0xff) / 255;
    return [r, g, b, 1];
  }

  /**
   * Stream-write a chunk JSON to disk without allocating one giant string for
   * the whole `nodes` + `edges` arrays. Necessary for chunks past ~500k JSON
   * chars (V8's string-length cap).
   */
  static async #writeChunkStreaming(
    path:  string,
    chunk: MutableChunkInterface,
  ): Promise<void> {
    const out = createWriteStream(path, { encoding: 'utf-8' });

    // Wire the error handler ONCE on the stream (not per-write) so we don't
    // accumulate listeners and trigger the MaxListenersExceededWarning.
    let pendingReject: ((err: Error) => void) | null = null;
    out.once('error', (err: Error) => { pendingReject?.(err); });

    const write = (s: string): Promise<void> => new Promise<void>((resolve, reject) => {
      pendingReject = reject;
      if (!out.write(s)) out.once('drain', () => { pendingReject = null; resolve(); });
      else { pendingReject = null; resolve(); }
    });

    await write('{"id":' + JSON.stringify(chunk.id));
    await write(',"label":' + JSON.stringify(chunk.label));
    await write(',"slug":' + JSON.stringify(chunk.slug));
    await write(',"color":' + JSON.stringify(chunk.color));
    await write(',"nodes":[');
    for (let i = 0; i < chunk.nodes.length; i++) {
      if (i > 0) await write(',');
      await write(JSON.stringify(chunk.nodes[i]));
    }
    await write('],"edges":[');
    for (let i = 0; i < chunk.edges.length; i++) {
      if (i > 0) await write(',');
      await write(JSON.stringify(chunk.edges[i]));
    }
    await write(']}');
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => err ? reject(err) : resolve());
    });
  }

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
}
