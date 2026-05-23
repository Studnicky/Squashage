/**
 * @fileoverview Thin wrapper that normalises RDF serialization across n3
 * (Turtle, TriG, N-Triples, N-Quads) and jsonld (JSON-LD) into a single
 * async `Serializer.serialize(quads, { format })` call.
 *
 * @remarks
 * **v0.x swap point** — In v1.x this entire class body is replaced by a
 * one-liner that delegates to `@semantics/rdf-io`'s writer, which ships its
 * own TypeScript declarations, streaming support, and RDF/XML coverage.
 * Until then, the two OSS packages (`n3`, `jsonld`) are imported here and
 * nowhere else in application code; the ESLint `no-restricted-imports` rule
 * enforces that boundary (see `eslint.config.mjs`).
 *
 * **Writer.end callback shape (n3 v2)**:
 * `writer.end((error, result) => …)`
 * — called once with `(null, result)` on success,
 * — called once with `(error, '')` on failure.
 * Typed via `@types/n3`; see {@link https://www.npmjs.com/package/@types/n3}.
 *
 * **JSON-LD bridge** — JSON-LD output is produced by first serializing the
 * quad array to N-Quads (recursive call), then passing the N-Quads string to
 * `jsonld.fromRDF` with `{ format: 'application/n-quads' }`.  When a
 * `jsonldContext` is provided in the options, the expanded array is then
 * compacted via `jsonld.compact(expanded, context)`.  Otherwise the raw
 * expanded form is pretty-printed.
 *
 * @module rdf/Serializer
 * @category RDF
 * @since 2.2.0
 */

import { createWriteStream } from 'node:fs';
import { mkdir }             from 'node:fs/promises';
import { dirname }           from 'node:path';
import { Writer } from 'n3';
import jsonld from 'jsonld';

import type { Quad } from '@rdfjs/types';
import type { RDFFormat } from './Formats.js';
import type { JsonldContextDocInterface } from './JsonldContext.js';
import { OutputConfigError } from '../errors/OutputConfigError.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * N3 Writer format strings keyed by {@link RDFFormat}.
 *
 * N3 uses the last `\w+` in the format string (lower-cased) to detect mode.
 * These values produce the expected behaviour for each v0.x format.
 */
const N3_FORMAT: Readonly<Record<Exclude<RDFFormat, 'jsonld'>, string>> = Object.freeze({
  turtle:   'Turtle',
  trig:     'application/trig',
  ntriples: 'N-Triples',
  nquads:   'N-Quads',
} as const);

/**
 * N3 Writer format strings for RDF-star-capable variants.
 *
 * @remarks
 * These format strings activate n3.js's RDF-star serialization path, which
 * encodes quoted triples using `<< ... >>` syntax. The keys mirror the
 * canonical RDF-star MIME types returned by {@link RdfStar.isSupported}.
 *
 * Supported in n3 v2: `application/trig-star`, `text/turtle-star`,
 * `application/n-quads-star`.
 */
const N3_STAR_FORMAT: Readonly<Record<string, string>> = Object.freeze({
  'application/trig-star':   'application/trig-star',
  'text/turtle-star':        'text/turtle-star',
  'application/n-quads-star': 'application/n-quads-star',
} as const);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for {@link Serializer.serialize}.
 *
 * @example
 * ```ts
 * const opts: SerializeOptionsInterface = {
 *   format:   'turtle',
 *   prefixes: { ex: 'http://example.org/' },
 * };
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @group Types
 */
export interface SerializeOptionsInterface {
  /** Target RDF serialization format. */
  format:    RDFFormat;
  /**
   * Namespace prefix map.  Only meaningful for Turtle and TriG; ignored by
   * N-Triples, N-Quads, and JSON-LD serializers.
   */
  prefixes?: Record<string, string>;
  /**
   * Base IRI for the document.  Currently forwarded to the JSON-LD path;
   * n3's Writer does not consume `baseIRI` directly in v0.x.
   */
  baseIRI?:  string;
  /**
   * JSON-LD compaction context to apply when `format === 'jsonld'`.
   *
   * When supplied, the expanded JSON-LD array produced by `jsonld.fromRDF` is
   * compacted using `jsonld.compact(expanded, jsonldContext)` before serialization.
   * When absent, the raw expanded form is returned.
   */
  jsonldContext?: JsonldContextDocInterface | undefined;
  /**
   * Override the n3.js format string directly, bypassing the {@link RDFFormat}
   * enum lookup.  Use this to request RDF-star-capable variants such as
   * `'application/trig-star'`, `'text/turtle-star'`, or
   * `'application/n-quads-star'`.  When set, `format` is still used for the
   * result's `format` field but the writer uses `n3FormatOverride` instead.
   *
   * @since 0.5.0
   */
  n3FormatOverride?: string | undefined;
}

/**
 * Result returned by {@link Serializer.serialize}.
 *
 * @example
 * ```ts
 * const { data, format } = await Serializer.serialize(quads, { format: 'turtle' });
 * console.log(format); // 'turtle'
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @group Types
 */
export interface SerializeResultInterface {
  /** The serialized RDF document as a UTF-8 string. */
  data:   string;
  /** The format that was used for serialization (mirrors the input option). */
  format: RDFFormat;
}

// ---------------------------------------------------------------------------
// Streaming writer
// ---------------------------------------------------------------------------

/**
 * Handle returned by {@link Serializer.openStream}.
 *
 * @remarks
 * Provides incremental quad writing to an open file stream and a close
 * method that resolves once the underlying stream has been fully flushed.
 * Designed for the streaming output path where individual per-record quad
 * batches are written to disk as they are produced, avoiding accumulation of
 * the entire quad set in memory.
 *
 * @category RDF
 * @since 2.3.0
 * @group Types
 */
export interface RecordWriterInterface {
  /**
   * Serialize `quads` in the configured format and write them to the stream.
   *
   * @param quads - The quad batch to write.  Must not contain JSON-LD format
   *   quads (JSON-LD requires batch serialization; use `Serializer.serialize`
   *   for that path).
   * @returns A Promise that resolves once the data has been accepted by the
   *   writable stream (i.e. the `write()` call did not return `false`, or the
   *   `'drain'` event was received if it did).
   */
  write(quads: ReadonlyArray<Quad>): Promise<void>;

  /**
   * Flush the write stream and wait for the `'finish'` event.
   *
   * @returns A Promise that resolves when the stream is fully closed.
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Serializer class
// ---------------------------------------------------------------------------

/**
 * Static-only RDF serializer that dispatches across n3 and jsonld based on
 * the requested {@link RDFFormat}.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated.  Application code
 * should never import `n3` or `jsonld` directly; use this class instead.
 *
 * Supported formats in v0.x: `turtle`, `trig`, `ntriples`, `nquads`, `jsonld`.
 * RDF/XML and N3 output return in v1.x when `@semantics/rdf-io` is consumed.
 *
 * @example
 * ```ts
 * const { data } = await Serializer.serialize(
 *   [quad],
 *   { format: 'turtle', prefixes: { ex: 'http://example.org/' } },
 * );
 * // '@prefix ex: <http://example.org/> .\nex:s ex:p "o" .\n'
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @see {@link SerializeOptionsInterface}
 * @see {@link SerializeResultInterface}
 * @group Core
 */
export class Serializer {
  private constructor() { /* static-only */ }

  /**
   * Serializes an array of RDF quads to a string in the requested format.
   *
   * @remarks
   * - **Turtle / TriG / N-Triples / N-Quads** — delegated to `n3.Writer`,
   *   wrapped in a Promise so errors propagate correctly.  Named-graph
   *   information is silently dropped by n3 for triple-only formats (Turtle,
   *   N-Triples); this is expected n3 behaviour.
   * - **JSON-LD** — the quads are first serialized to N-Quads (recursive
   *   call), then `jsonld.fromRDF` converts the N-Quads string to an
   *   expanded JSON-LD array.  When `options.jsonldContext` is provided, the
   *   expanded array is compacted via `jsonld.compact`; otherwise the raw
   *   expanded form is pretty-printed with `JSON.stringify(doc, null, 2)`.
   *
   * @param quads   - Quads to serialize.
   * @param options - Serialization options including the required `format`.
   * @returns A promise resolving to the serialized document and the format used.
   * @throws {OutputConfigError} When an unrecognised format is requested.
   *
   * @example Turtle with prefixes
   * ```ts
   * const { data } = await Serializer.serialize(
   *   [quad],
   *   { format: 'turtle', prefixes: { ex: 'http://example.org/' } },
   * );
   * ```
   *
   * @example JSON-LD with compaction context
   * ```ts
   * const ctx = JsonldContext.build(quads, prefixes);
   * const { data } = await Serializer.serialize(quads, { format: 'jsonld', jsonldContext: ctx });
   * const doc = JSON.parse(data);
   * ```
   */
  public static async serialize(
    quads:   ReadonlyArray<Quad>,
    options: SerializeOptionsInterface,
  ): Promise<SerializeResultInterface> {
    const { format } = options;

    if (format === 'jsonld') {
      return Serializer.serializeJsonLd(quads, options);
    }

    // When an RDF-star format override is requested, use it directly.
    if (options.n3FormatOverride !== undefined) {
      const starFormat = N3_STAR_FORMAT[options.n3FormatOverride];
      if (starFormat === undefined) {
        throw OutputConfigError.create(
          `Unsupported n3FormatOverride: "${options.n3FormatOverride}"`,
          { metadata: { format: options.n3FormatOverride } },
        );
      }
      return Serializer.serializeN3(quads, options, starFormat, format);
    }

    const n3Format = N3_FORMAT[format as Exclude<RDFFormat, 'jsonld'>];

    if (n3Format === undefined) {
      throw OutputConfigError.create(
        `Unsupported RDF output format: "${format}"`,
        { metadata: { format } },
      );
    }

    return Serializer.serializeN3(quads, options, n3Format, format);
  }

  /**
   * Opens a writable file stream and returns a {@link RecordWriterInterface}
   * handle for incremental quad writing.
   *
   * @remarks
   * The parent directory of `path` is created with `{ recursive: true }` if
   * it does not already exist.  Quads are serialized using the same n3.Writer
   * logic as {@link Serializer.serialize} for line-oriented formats (Turtle,
   * TriG, N-Triples, N-Quads).  JSON-LD is not supported on this code path
   * because it requires batch serialization — callers must check and fall back
   * to the batched path when `format === 'jsonld'`.
   *
   * Each {@link RecordWriterInterface.write} call creates a fresh n3.Writer for
   * the batch, serializes the quads to a string, and pushes that string to the
   * underlying `WriteStream`.  This avoids holding all quads in memory while
   * still producing correct line-oriented output.
   *
   * @param path    - Absolute or relative file path to write to.
   * @param format  - Line-oriented RDF format (turtle, trig, ntriples, nquads).
   *   Passing `'jsonld'` throws an {@link OutputConfigError} immediately.
   * @param options - Optional prefix map (forwarded to n3.Writer for Turtle/TriG).
   * @returns A Promise that resolves to the writer handle once the file has
   *   been opened (directory created, stream open).
   * @throws {OutputConfigError} When `format === 'jsonld'` or an unrecognised
   *   format is requested.
   *
   * @example
   * ```ts
   * const writer = await Serializer.openStream('./graphs/out.nq', 'nquads');
   * for (const batch of recordBatches) {
   *   await writer.write(batch);
   * }
   * await writer.close();
   * ```
   *
   * @since 2.3.0
   */
  public static async openStream(
    path:    string,
    format:  Exclude<RDFFormat, 'jsonld'>,
    options: { prefixes?: Record<string, string> } = {},
  ): Promise<RecordWriterInterface> {
    if ((format as string) === 'jsonld') {
      throw OutputConfigError.create(
        'Serializer.openStream does not support JSON-LD — JSON-LD requires batch serialization.',
        { metadata: { format: format as string, path } },
      );
    }

    const n3Format = N3_FORMAT[format];
    if (n3Format === undefined) {
      throw OutputConfigError.create(
        `Unsupported RDF format for streaming: "${format}"`,
        { metadata: { format: format as string, path } },
      );
    }

    await mkdir(dirname(path), { recursive: true });

    const stream = createWriteStream(path, { encoding: 'utf8' });

    // Wait for the stream to be ready (open event) or reject on error.
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve());
      stream.once('error', (err) => reject(err));
    });

    const writerOptions: { format: string; prefixes?: Record<string, string> } = {
      format: n3Format,
    };
    if (options.prefixes !== undefined) writerOptions.prefixes = options.prefixes;

    return {
      async write(quads: ReadonlyArray<Quad>): Promise<void> {
        if (quads.length === 0) return;

        // Serialize the batch to a string via n3.Writer, then push to the stream.
        const chunk = await new Promise<string>((resolve, reject) => {
          const batchOptions: { format: string; prefixes?: Record<string, string> } = {
            format: n3Format,
          };
          // Only emit prefix declarations on first batch; subsequent batches
          // emit raw lines. We omit prefixes from per-batch writers to avoid
          // repeated @prefix declarations in N-Quads / line-oriented output.
          const w = new Writer(batchOptions);
          for (const quad of quads) {
            w.addQuad(quad);
          }
          w.end((error, result) => {
            if (error !== null) { reject(error); return; }
            resolve(result as string);
          });
        });

        // Write to the stream, respecting back-pressure.
        const ok = stream.write(chunk);
        if (!ok) {
          await new Promise<void>((resolve, reject) => {
            stream.once('drain', () => resolve());
            stream.once('error', (err) => reject(err));
          });
        }
      },

      close(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          stream.once('finish', () => resolve());
          stream.once('error', (err) => reject(err));
          stream.end();
        });
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Private dispatch helpers
  // ---------------------------------------------------------------------------

  /**
   * Serializes quads using `n3.Writer` for Turtle-family formats.
   */
  private static serializeN3(
    quads:    ReadonlyArray<Quad>,
    options:  SerializeOptionsInterface,
    n3Format: string,
    format:   Exclude<RDFFormat, 'jsonld'>,
  ): Promise<SerializeResultInterface> {
    return new Promise<SerializeResultInterface>((resolve, reject) => {
      const writerOptions: { format: string; prefixes?: Record<string, string> } = { format: n3Format };
      if (options.prefixes !== undefined) writerOptions.prefixes = options.prefixes;

      const writer = new Writer(writerOptions);
      for (const quad of quads) {
        writer.addQuad(quad);
      }

      // n3 Writer.end calls done(null, result) on success and done(error, '') on
      // failure. @types/n3 ErrorCallback types err as Error (non-null); the cast
      // satisfies the strict-null check while preserving runtime correctness.
      writer.end((error, result) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ data: result as string, format });
      });
    });
  }

  /**
   * Serializes quads to JSON-LD by bridging through N-Quads.
   *
   * @remarks
   * The N-Quads string is produced by a recursive call to
   * {@link Serializer.serialize} so that the same n3.Writer code path is
   * reused.  `jsonld.fromRDF` then converts the N-Quads to an expanded
   * JSON-LD array.  When `options.jsonldContext` is provided, the array is
   * further compacted via `jsonld.compact`; otherwise the raw expanded form
   * is pretty-printed.
   */
  private static async serializeJsonLd(
    quads:   ReadonlyArray<Quad>,
    options: SerializeOptionsInterface,
  ): Promise<SerializeResultInterface> {
    const { data: nq } = await Serializer.serialize(quads, { format: 'nquads' });
    const expanded = await jsonld.fromRDF(nq, { format: 'application/n-quads' });

    if (options.jsonldContext !== undefined) {
      // JsonldContextDocInterface is Readonly<Record<string, unknown>>; @types/jsonld
      // ContextDefinition has a narrower value type. The cast is safe because
      // jsonld.compact accepts any plain object as its context at runtime.
      const compacted = await jsonld.compact(expanded, options.jsonldContext as Parameters<typeof jsonld.compact>[1]);
      return { data: JSON.stringify(compacted, null, 2), format: 'jsonld' };
    }

    return { data: JSON.stringify(expanded, null, 2), format: 'jsonld' };
  }
}
