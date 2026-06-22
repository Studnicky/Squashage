/**
 * @fileoverview BinaryFrameFormat — the shared on-disk contract for the
 * compact binary graph frames consumed by the cosmos.gl streaming viewer.
 *
 * @module viz/BinaryFrameFormat
 *
 * The viz demo ships the FULL baked graph (positions from ForceAtlas2,
 * per-concept colors, sizes, edge index pairs) as a sequence of compact
 * little-endian binary frame files plus a small JSON manifest. This is
 * ~15-20 MB for a 256K-node / 842K-edge graph, versus ~700 MB of JSON.
 *
 * One frame == one concept bucket (named-graph partition). Streaming frames
 * in concept order reproduces the "stream-in by concept" aesthetic: each
 * concept's cluster animates into place as its frame arrives.
 *
 * ### Frame byte layout (little-endian)
 * ```
 * offset 0   uint32  magic   = 0x53514247  ('SQBG')
 * offset 4   uint32  version = FRAME_VERSION
 * offset 8   uint32  nodeCount
 * offset 12  uint32  edgeCount
 * offset 16  Float32[nodeCount * 2]   positions  (x, y interleaved)
 * ...        Float32[nodeCount * 4]   colors     (r, g, b, a in [0,1])
 * ...        Float32[nodeCount]       sizes
 * ...        Uint32 [edgeCount * 2]   edges      (GLOBAL src, tgt indices)
 * ```
 *
 * Node global indices are assigned in frame order: frame 0 owns indices
 * `[0, n0)`, frame 1 owns `[n0, n0+n1)`, and so on (`frame.nodeBase` in the
 * manifest records each frame's first global index). Edge endpoints are
 * GLOBAL indices, so the worker appends frames without any remapping; an
 * edge may reference a node from an earlier frame.
 *
 * @category Viz
 * @since 0.10.0
 */

/** Magic number at the head of every frame file: ASCII `SQBG`. */
export const FRAME_MAGIC = 0x53514247;

/** Frame format version. Bump on any incompatible layout change. */
export const FRAME_VERSION = 1;

/** Byte length of the per-frame header (magic, version, nodeCount, edgeCount). */
export const FRAME_HEADER_BYTES = 16;

/** Floats per node position entry (x, y). */
export const POSITION_STRIDE = 2;

/** Floats per node color entry (r, g, b, a). */
export const COLOR_STRIDE = 4;

/** Uint32s per edge entry (source index, target index). */
export const EDGE_STRIDE = 2;

/** Manifest format identifier written into `manifest.json`. */
export const MANIFEST_FORMAT = 'squashage-binary-frames-v1';

/**
 * One frame's entry in `manifest.json`.
 *
 * @category Viz
 * @since 0.10.0
 * @group Types
 */
export interface BinaryFrameManifestEntryInterface {
  /** Frame file name, relative to the manifest (e.g. `frames/frame-000.bin`). */
  readonly file:      string;
  /** Human-readable concept label (named-graph CURIE). */
  readonly label:     string;
  /** Hex swatch color for the legend / queue UI. */
  readonly color:     string;
  /** Number of nodes in this frame. */
  readonly nodeCount: number;
  /** Number of edges in this frame. */
  readonly edgeCount: number;
  /** Global index of this frame's first node. */
  readonly nodeBase:  number;
}

/**
 * The `manifest.json` document for a binary-frame graph export.
 *
 * @category Viz
 * @since 0.10.0
 * @group Types
 */
export interface BinaryFrameManifestInterface {
  /** Always {@link MANIFEST_FORMAT}. */
  readonly format:     string;
  /** Frame format version ({@link FRAME_VERSION}). */
  readonly version:    number;
  /** World extent passed to cosmos.gl `spaceSize`. */
  readonly spaceSize:  number;
  /** Total node count across all frames (== final graph order). */
  readonly totalNodes: number;
  /** Total edge count across all frames. */
  readonly totalEdges: number;
  /** Frames in stream order (smallest concept first). */
  readonly frames:     ReadonlyArray<BinaryFrameManifestEntryInterface>;
}
