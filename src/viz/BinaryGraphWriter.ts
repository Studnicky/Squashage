/**
 * @fileoverview BinaryGraphWriter — write compact little-endian binary graph
 * frames + manifest to disk per the {@link BinaryFrameManifestInterface}
 * contract.
 *
 * @module viz/BinaryGraphWriter
 *
 * Each frame is a single `.bin` file: a 16-byte header (magic, version,
 * nodeCount, edgeCount) followed by packed Float32 positions, colors, and
 * sizes, then Uint32 global edge index pairs. The header is written
 * explicitly little-endian via `DataView` for portability; the typed-array
 * bodies are written in platform byte order (all dev/CI/browser targets are
 * little-endian, so the same machine reads what it writes).
 *
 * @category Viz
 * @since 0.10.0
 */
import { writeFile } from 'node:fs/promises';

import {
  FRAME_MAGIC,
  FRAME_VERSION,
  FRAME_HEADER_BYTES,
  POSITION_STRIDE,
  COLOR_STRIDE,
  EDGE_STRIDE,
} from './BinaryFrameFormat.js';
import type { BinaryFrameManifestInterface } from './BinaryFrameFormat.js';

/** Bytes per Float32 / Uint32 element. */
const BYTES_PER_ELEMENT = 4;

/**
 * Packed typed arrays for one binary frame.
 *
 * @category Viz
 * @since 0.10.0
 * @group Types
 */
export interface BinaryFrameArraysInterface {
  /** Interleaved x,y positions — length `nodeCount * POSITION_STRIDE`. */
  readonly positions: Float32Array;
  /** Interleaved r,g,b,a colors in [0,1] — length `nodeCount * COLOR_STRIDE`. */
  readonly colors:    Float32Array;
  /** Per-node render sizes — length `nodeCount`. */
  readonly sizes:     Float32Array;
  /** Global src,tgt index pairs — length `edgeCount * EDGE_STRIDE`. */
  readonly edges:     Uint32Array;
}

/**
 * Static-only writer for binary graph frames and the accompanying manifest.
 *
 * @remarks
 * Run at build time (Node). The class cannot be instantiated.
 *
 * @category Viz
 * @since 0.10.0
 * @group Core
 */
export class BinaryGraphWriter {
  private constructor() { /* static-only */ }

  /**
   * Writes one frame `.bin` file from packed typed arrays.
   *
   * @remarks
   * Allocates a single `ArrayBuffer` sized for the header plus all four bodies,
   * writes the header little-endian via a `DataView`, copies each typed array
   * into its byte-aligned region, then flushes the buffer to disk.
   *
   * @param path - Absolute or relative output path for the frame file.
   * @param args - Packed positions, colors, sizes, and global edge pairs.
   * @returns The number of bytes written.
   */
  static async writeFrame(
    path: string,
    args: BinaryFrameArraysInterface,
  ): Promise<number> {
    const nodeCount = args.sizes.length;
    const edgeCount = args.edges.length / EDGE_STRIDE;

    const positionBytes = nodeCount * POSITION_STRIDE * BYTES_PER_ELEMENT;
    const colorBytes    = nodeCount * COLOR_STRIDE * BYTES_PER_ELEMENT;
    const sizeBytes     = nodeCount * BYTES_PER_ELEMENT;
    const edgeBytes     = edgeCount * EDGE_STRIDE * BYTES_PER_ELEMENT;

    const total = FRAME_HEADER_BYTES + positionBytes + colorBytes + sizeBytes + edgeBytes;
    const buf   = new ArrayBuffer(total);

    // Header — explicit little-endian for portability.
    const header = new DataView(buf);
    header.setUint32(0, FRAME_MAGIC, true);
    header.setUint32(4, FRAME_VERSION, true);
    header.setUint32(8, nodeCount, true);
    header.setUint32(12, edgeCount, true);

    // Bodies — byte-aligned typed-array views over the shared buffer.
    let offset = FRAME_HEADER_BYTES;
    new Float32Array(buf, offset, nodeCount * POSITION_STRIDE).set(args.positions);
    offset += positionBytes;
    new Float32Array(buf, offset, nodeCount * COLOR_STRIDE).set(args.colors);
    offset += colorBytes;
    new Float32Array(buf, offset, nodeCount).set(args.sizes);
    offset += sizeBytes;
    new Uint32Array(buf, offset, edgeCount * EDGE_STRIDE).set(args.edges);

    await writeFile(path, Buffer.from(buf));
    return total;
  }

  /**
   * Writes the `manifest.json` document for a binary-frame graph export.
   *
   * @param path     - Absolute or relative output path for the manifest file.
   * @param manifest - The fully-populated manifest document.
   */
  static async writeManifest(
    path:     string,
    manifest: BinaryFrameManifestInterface,
  ): Promise<void> {
    await writeFile(path, JSON.stringify(manifest, null, 2), 'utf-8');
  }
}
