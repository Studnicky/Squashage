/**
 * @fileoverview Built-in `rdfjs:stream` task for the Squashage pipeline.
 *
 * @remarks
 * Streaming counterpart to `rdfjs:finalize`. Instead of collecting all quads
 * in memory and writing atomically at end-of-run, this task opens a writable
 * file stream once at orchestrator context-construction time, writes each quad
 * as a single serialized line the moment it arrives on `state.context.dataset`,
 * and closes the file after the last record's pipeline drains.
 *
 * The implementation wraps `state.context.dataset` with a write-through proxy
 * so that plugin calls to `dataset.add(quad)` fan out to both the in-memory
 * `DatasetCore` and the open `StreamWriter`. Plugins remain unaware of the
 * streaming output path.
 *
 * Compatible formats (line-oriented serializations):
 * - `ntriples` -- one triple line per quad
 * - `nquads`   -- one quad line per quad
 * - `turtle`   -- prefix block written at open; one triple per line thereafter
 * - `trig`     -- prefix block written at open; one quad per line thereafter
 *
 * Incompatible combinations (config-load error + task-invocation defense):
 * - `encoding: stream` + `canonicalize: true` -- canonicalization needs the full graph
 * - `encoding: stream` + `format: jsonld`     -- JSON-LD compaction needs the full graph
 *
 * `dropInMemory: true` -- after each `dataset.add(quad)` is proxied, the quad
 * is NOT added to the in-memory `DatasetCore`, bounding RSS growth for very
 * large datasets (e.g. Veekun 486K learnsets).
 *
 * The task self-registers under the name `rdfjs:stream` at module load time;
 * a side-effect import of this file is sufficient.
 *
 * @module
 * @since 0.7.0
 * @category Tasks
 */

import { mkdir, createWriteStream }              from 'node:fs';
import { promisify }                             from 'node:util';
import { dirname, join }                         from 'node:path';
import type { Writable }                         from 'node:stream';
import { mkdir as mkdirAsync, writeFile }        from 'node:fs/promises';

import type { Quad }                             from '@rdfjs/types';
import type { DatasetCore }                      from '@rdfjs/types';
import type { NextFnInterface, TaskFnInterface } from '../types/Pipeline.js';
import type { PipelineStateInterface }           from '../types/PipelineState.js';
import type { PipelineContextInterface }         from '../types/PipelineState.js';
import type { OutputReportInterface }            from '../output/OutputInterface.js';
import type { RDFFormat }                        from '../rdf/Formats.js';

import { TaskRegistry }        from '../registry/TaskRegistry.js';
import { Logger }              from '../modules/logger/logger.js';
import { ExternalSchemaError } from '../errors/ExternalSchemaError.js';
import { OutputConfigError }   from '../errors/OutputConfigError.js';
import { FormatResolver }      from '../output/FormatResolver.js';
import { Bucketer }            from '../output/Bucketer.js';
import type { BucketingConfigInterface, BucketReportInterface } from '../output/Bucketer.js';
import { OutputReport, OUTPUT_REPORT_FILENAME } from '../output/OutputReport.js';

const logger = Logger.forComponent('rdfjsStream');

/** Name under which `rdfjs:stream` is registered in the {@link TaskRegistry}. */
export const TASK_NAME = 'rdfjs:stream' as const;

/** Formats that support line-oriented streaming output. JSON-LD is excluded. */
const STREAMING_FORMATS = new Set<RDFFormat>(['ntriples', 'nquads', 'turtle', 'trig']);

// ---------------------------------------------------------------------------
// StreamWriter
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of a streaming RDF output file.
 *
 * Single-use: `open()` then one or more `writeQuad()` calls then `close()`.
 *
 * @since 0.7.0
 * @category Tasks
 */
export class StreamWriter {
  readonly #path:     string;
  readonly #format:   RDFFormat;
  readonly #prefixes: Record<string, string> | undefined;
  #stream:            Writable | null = null;
  #quadCount:         number = 0;
  #bytesWritten:      number = 0;
  #openedAt:          number = 0;
  #pendingWrites:     Promise<void> = Promise.resolve();
  /** Whether the file was ever opened (first open). Controls header emission on reopen. */
  #everOpened:        boolean = false;

  public constructor(
    path:      string,
    format:    RDFFormat,
    prefixes?: Record<string, string>,
  ) {
    this.#path     = path;
    this.#format   = format;
    this.#prefixes = prefixes;
  }

  /** The number of quads written so far. */
  public get quadCount(): number { return this.#quadCount; }

  /** The number of bytes written so far. */
  public get bytesWritten(): number { return this.#bytesWritten; }

  /**
   * Opens the output file and writes the format-specific header.
   *
   * For N-Triples and N-Quads: no header.
   * For Turtle and TriG: writes the `@prefix` block.
   */
  public async open(): Promise<void> {
    logger.debug('open', 'Opening streaming output file', { path: this.#path, format: this.#format });

    this.#openedAt = Date.now();

    await promisify(mkdir)(dirname(this.#path), { recursive: true });

    this.#stream = createWriteStream(this.#path, { encoding: 'utf8' });

    const header = StreamWriter.buildHeader(this.#format, this.#prefixes);
    if (header.length > 0) {
      await this.appendChunk(header);
    }

    this.#everOpened = true;
    logger.info('open', 'Stream writer opened', { path: this.#path });
  }

  /**
   * Reopens the file in append mode after an LRU close.
   *
   * @remarks
   * No header is emitted on reopen — only the first `open()` writes the header.
   * The underlying stream is replaced; the quad/byte counters continue from
   * their current values.
   */
  public async reopen(): Promise<void> {
    if (!this.#everOpened) {
      throw new Error(`StreamWriter.reopen() called before open() for path "${this.#path}"`);
    }
    logger.debug('reopen', 'Reopening stream in append mode', { path: this.#path });
    this.#stream = createWriteStream(this.#path, { encoding: 'utf8', flags: 'a' });
  }

  /**
   * Closes the underlying stream without finalizing the report.
   *
   * @remarks
   * Used by `MultiStreamWriter` for LRU eviction. The writer can be
   * subsequently reopened via {@link reopen}.
   */
  public async closeHandle(): Promise<void> {
    await this.#pendingWrites;
    if (this.#stream !== null) {
      await new Promise<void>((resolve, reject) => {
        this.#stream!.end((err: Error | null | undefined) => {
          if (err !== null && err !== undefined) { reject(err); } else { resolve(); }
        });
      });
      this.#stream = null;
    }
    logger.debug('closeHandle', 'Stream handle closed (LRU eviction)', { path: this.#path });
  }

  /** Whether the file handle is currently open. */
  public get isOpen(): boolean { return this.#stream !== null; }

  /**
   * Serializes a single quad to its line-form and appends it to the file.
   */
  public async writeQuad(quad: Quad): Promise<void> {
    if (this.#stream === null) {
      throw new Error('StreamWriter.writeQuad called before open()');
    }

    const line = StreamWriter.serializeQuad(quad, this.#format);
    await this.appendChunk(line);
    this.#quadCount++;
  }

  /**
   * Enqueues a quad write without awaiting.
   *
   * @remarks
   * Called from the dataset proxy where synchronous return is required.
   * The write promise is chained onto the serial write queue so the stream
   * receives writes in order without accumulating unbounded pending promises.
   */
  enqueueQuad(quad: Quad): void {
    this.#pendingWrites = this.#pendingWrites.then(
      () => this.writeQuad(quad),
      () => this.writeQuad(quad),
    );
  }

  /**
   * Flushes and closes the output file.
   */
  public async close(): Promise<OutputReportInterface> {
    // Settle all pending quad writes before closing.
    await this.#pendingWrites;

    if (this.#stream !== null) {
      await new Promise<void>((resolve, reject) => {
        this.#stream!.end((err: Error | null | undefined) => {
          if (err !== null && err !== undefined) { reject(err); }
          else { resolve(); }
        });
      });
      this.#stream = null;
    }

    const durationMs = Date.now() - this.#openedAt;

    logger.info('close', 'Stream writer closed', {
      path:         this.#path,
      quadCount:    this.#quadCount,
      bytesWritten: this.#bytesWritten,
      durationMs,
    });

    return {
      path:         this.#path,
      format:       this.#format,
      quadCount:    this.#quadCount,
      graphCount:   1,
      durationMs,
      bytesWritten: this.#bytesWritten,
      errors:       [],
    };
  }

  /**
   * Appends a string chunk to the underlying write stream.
   *
   * @remarks
   * Exposed (non-private) so unit tests can exercise byte counting directly.
   */
  async appendChunk(chunk: string): Promise<void> {
    const bytes = Buffer.byteLength(chunk, 'utf8');
    await new Promise<void>((resolve, reject) => {
      this.#stream!.write(chunk, 'utf8', (err: Error | null | undefined) => {
        if (err !== null && err !== undefined) { reject(err); }
        else { resolve(); }
      });
    });
    this.#bytesWritten += bytes;
  }

  /**
   * Returns the format-specific document header.
   *
   * N-Triples and N-Quads: empty string. Turtle and TriG: `@prefix` lines.
   */
  static buildHeader(format: RDFFormat, prefixes: Record<string, string> | undefined): string {
    if (format !== 'turtle' && format !== 'trig') return '';
    if (prefixes === undefined || Object.keys(prefixes).length === 0) return '';

    const lines = Object.entries(prefixes)
      .map(([pfx, iri]) => `@prefix ${pfx}: <${iri}> .`)
      .join('\n');

    return `${lines}\n\n`;
  }

  /**
   * Serializes one quad to its single-line form for the given format.
   *
   * N-Triples/Turtle: `<s> <p> <o> .`
   * N-Quads/TriG:     `<s> <p> <o> <g> .`
   */
  static serializeQuad(quad: Quad, format: RDFFormat): string {
    const s = StreamWriter.serializeTerm(quad.subject);
    const p = StreamWriter.serializeTerm(quad.predicate);
    const o = StreamWriter.serializeTerm(quad.object);

    if (format === 'ntriples' || format === 'turtle') {
      return `${s} ${p} ${o} .\n`;
    }

    const g = quad.graph.termType === 'DefaultGraph'
      ? ''
      : ` ${StreamWriter.serializeTerm(quad.graph)}`;

    return `${s} ${p} ${o}${g} .\n`;
  }

  /** Serializes a single RDF/JS term to its N-Triples/N-Quads token form. */
  static serializeTerm(
    term: Quad['subject'] | Quad['predicate'] | Quad['object'] | Quad['graph'],
  ): string {
    switch (term.termType) {
      case 'NamedNode':
        return `<${term.value}>`;

      case 'BlankNode':
        return `_:${term.value}`;

      case 'Literal': {
        const escaped = term.value
          .replace(/\\/g, '\\\\')
          .replace(/"/g,  '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t');

        if (term.language !== '') {
          return `"${escaped}"@${term.language}`;
        }

        const xsdString = 'http://www.w3.org/2001/XMLSchema#string';
        if (term.datatype.value !== xsdString) {
          return `"${escaped}"^^<${term.datatype.value}>`;
        }

        return `"${escaped}"`;
      }

      case 'DefaultGraph':
        return '';

      case 'Variable':
        return `?${term.value}`;

      default: {
        const fb = term as unknown as { value: string };
        return `<${fb.value}>`;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Dataset write-through proxy
// ---------------------------------------------------------------------------

/**
 * Creates a write-through proxy around a `DatasetCore` that intercepts every
 * `add(quad)` call, optionally forwards it to the real dataset (unless
 * `dropInMemory` is true), and also writes the quad to the writer.
 *
 * @since 0.7.0
 */
export function buildDatasetProxy(
  inner:        DatasetCore,
  writer:       StreamWriter | MultiStreamWriter,
  dropInMemory: boolean,
): DatasetCore {
  return new Proxy(inner, {
    get(target: DatasetCore, prop: string | symbol): unknown {
      if (prop === 'add') {
        return (quad: Quad): DatasetCore => {
          writer.enqueueQuad(quad);

          if (!dropInMemory) {
            target.add(quad);
          }

          return inner;
        };
      }

      const raw = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof raw === 'function') {
        return (raw as (...args: unknown[]) => unknown).bind(target);
      }
      return raw;
    },
  });
}

// ---------------------------------------------------------------------------
// MultiStreamWriter
// ---------------------------------------------------------------------------

/**
 * Manages multiple `StreamWriter` instances — one per named-graph bucket.
 *
 * Two modes:
 * - **Pre-open** (`per-config-bucket`): all file handles opened at
 *   construction; quad routing is a O(1) Map lookup.
 * - **Lazy-open** (`per-graph-iri`): file handles opened on the first quad
 *   seen for each graph IRI. A `Map<string, Promise<StreamWriter>>` serialises
 *   concurrent first-quad races. LRU eviction fires when open-file count
 *   exceeds `bucketing.maxOpenFiles` (default 256).
 *
 * @since 0.7.0
 * @category Tasks
 */
export class MultiStreamWriter {
  readonly #format:      RDFFormat;
  readonly #prefixes:    Record<string, string> | undefined;
  readonly #bucketing:   BucketingConfigInterface;
  readonly #bucketDir:   string;
  readonly #maxOpen:     number;

  /** Fully-open writers, keyed by bucket key. */
  readonly #writers:     Map<string, StreamWriter> = new Map();
  /** In-flight open promises — prevents double-open races. */
  readonly #opening:     Map<string, Promise<StreamWriter>> = new Map();
  /** LRU order: least-recently-written key is first. */
  readonly #lruOrder:    string[] = [];
  /** Serial write queue — ensures all enqueued writes are ordered. */
  #pendingWrites: Promise<void> = Promise.resolve();

  #totalQuads:   number = 0;
  #totalBytes:   number = 0;
  #openedAt:     number = 0;

  public constructor(
    format:    RDFFormat,
    bucketing: BucketingConfigInterface,
    bucketDir: string,
    prefixes?: Record<string, string>,
  ) {
    this.#format    = format;
    this.#bucketing = bucketing;
    this.#bucketDir = bucketDir;
    this.#prefixes  = prefixes;
    this.#maxOpen   = bucketing.maxOpenFiles ?? 256;
  }

  /** Total quads written across all buckets. */
  public get quadCount():    number { return this.#totalQuads; }
  /** Total bytes written across all buckets. */
  public get bytesWritten(): number { return this.#totalBytes; }

  /**
   * Pre-open mode: opens all buckets declared in `bucketing.buckets` upfront.
   *
   * @remarks
   * Only valid for `per-config-bucket` strategy.
   * All `StreamWriter` instances are opened; prefix headers are written.
   */
  public async openAll(): Promise<void> {
    this.#openedAt = Date.now();
    const strategy = this.#bucketing.strategy ?? 'per-graph-iri';
    if (strategy !== 'per-config-bucket') return;

    const buckets = this.#bucketing.buckets ?? {};
    const allKeys = new Set(Object.keys(buckets));

    for (const graphIri of allKeys) {
      const stem = Bucketer.stemFor(graphIri, this.#bucketing, allKeys);
      const ext  = `.${this.#format === 'ntriples' ? 'nt' : this.#format === 'nquads' ? 'nq' : this.#format === 'turtle' ? 'ttl' : this.#format === 'trig' ? 'trig' : this.#format}`;
      const path = join(this.#bucketDir, `${stem}${ext}`);

      const writer = new StreamWriter(path, this.#format, this.#prefixes);
      await writer.open();
      this.#writers.set(graphIri, writer);
      this.#lruOrder.push(graphIri);
    }

    logger.debug('openAll', 'Pre-opened all bucket writers', {
      bucketCount: this.#writers.size,
      strategy,
    });
  }

  /**
   * Lazy-open mode initializer — sets the start time; no handles opened yet.
   *
   * @remarks
   * For `per-graph-iri` strategy; call before per-record dispatch.
   */
  public startLazy(): void {
    this.#openedAt = Date.now();
    logger.debug('startLazy', 'MultiStreamWriter ready in lazy-open mode');
  }

  /**
   * Routes a quad to the appropriate `StreamWriter`, opening it lazily if needed.
   *
   * @remarks
   * Thread-safe via the `#opening` promise map — concurrent first-quad calls
   * for the same graph IRI will share the same open promise.
   *
   * @param quad - The quad to write.
   */
  public async writeQuad(quad: Quad): Promise<void> {
    const writer = await this.#resolveWriter(quad);
    if (writer === null) return; // dropped per onUnmapped=drop

    await writer.writeQuad(quad);
    this.#totalQuads++;
  }

  /**
   * Enqueues a quad write without awaiting (for use in the dataset proxy).
   *
   * @remarks
   * Chains onto the serial write queue so all quads are processed in order,
   * which is required for correct LRU open/close sequencing.
   */
  public enqueueQuad(quad: Quad): void {
    this.#pendingWrites = this.#pendingWrites.then(
      () => this.writeQuad(quad),
      () => this.writeQuad(quad),
    );
  }

  /**
   * Closes all open writers and returns per-bucket report entries.
   */
  public async close(): Promise<{ reports: BucketReportInterface[]; durationMs: number }> {
    // Drain the serial write queue first
    await this.#pendingWrites;
    // Then wait for any in-flight opens to settle
    await Promise.allSettled([...this.#opening.values()]);

    let totalQuads = 0;
    let totalBytes = 0;
    const reports: BucketReportInterface[] = [];

    for (const [bucketKey, writer] of this.#writers) {
      if (writer.isOpen) {
        await writer.closeHandle();
      }

      const graphIri = bucketKey === '__default__' || bucketKey === '__other__' ? null : bucketKey;
      const allKeys  = new Set(this.#writers.keys());
      const stem     = Bucketer.stemFor(bucketKey, this.#bucketing, allKeys);
      const ext      = this.#formatExt();
      const filePath = join(this.#bucketDir, `${stem}${ext}`);

      totalQuads += writer.quadCount;
      totalBytes += writer.bytesWritten;

      reports.push({
        bucketKey,
        path:         writer.quadCount > 0 ? filePath : null,
        graphIri,
        stem,
        format:       this.#format,
        quadCount:    writer.quadCount,
        bytesWritten: writer.bytesWritten,
      });
    }

    this.#totalQuads = totalQuads;
    this.#totalBytes = totalBytes;

    const durationMs = Date.now() - this.#openedAt;
    logger.info('close', 'MultiStreamWriter closed all buckets', {
      bucketCount: reports.length,
      totalQuads,
      totalBytes,
      durationMs,
    });

    return { reports, durationMs };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Returns the writer for the quad's graph, opening lazily if needed. */
  async #resolveWriter(quad: Quad): Promise<StreamWriter | null> {
    const strategy = this.#bucketing.strategy ?? 'per-graph-iri';
    const term     = quad.graph;
    let bucketKey: string;

    if (term.termType === 'DefaultGraph') {
      bucketKey = '__default__';
    } else if (strategy === 'per-config-bucket') {
      const iri     = term.value;
      const buckets = this.#bucketing.buckets ?? {};
      if (Object.prototype.hasOwnProperty.call(buckets, iri)) {
        bucketKey = iri;
      } else {
        const onUnmapped = this.#bucketing.onUnmapped ?? 'other';
        if (onUnmapped === 'drop') return null;
        if (onUnmapped === 'fail') {
          throw new Error(`MultiStreamWriter: graph IRI "${iri}" not in buckets map and onUnmapped="fail"`);
        }
        bucketKey = '__other__';
      }
    } else {
      bucketKey = term.value;
    }

    // Fast path: writer known
    const existing = this.#writers.get(bucketKey);
    if (existing !== undefined) {
      // If the writer was LRU-evicted (handle closed), reopen in append mode
      if (!existing.isOpen) {
        // Evict another slot if needed before reopening
        if (this.#writers.size >= this.#maxOpen) {
          await this.#evictLru();
        }
        await existing.reopen();
        logger.debug('resolveWriter', 'Reopened LRU-evicted bucket writer', { bucketKey });
      }
      this.#touchLru(bucketKey);
      return existing;
    }

    // Check for in-flight open
    const inFlight = this.#opening.get(bucketKey);
    if (inFlight !== undefined) {
      return inFlight;
    }

    // Lazy-open a new writer
    const openPromise = this.#lazyOpen(bucketKey);
    this.#opening.set(bucketKey, openPromise);

    let writer: StreamWriter;
    try {
      writer = await openPromise;
    } finally {
      this.#opening.delete(bucketKey);
    }

    return writer;
  }

  /** Opens a new `StreamWriter` for a previously-unseen bucket key. */
  async #lazyOpen(bucketKey: string): Promise<StreamWriter> {
    // Evict LRU handle if at capacity
    if (this.#writers.size >= this.#maxOpen) {
      await this.#evictLru();
    }

    const allKeys = new Set([...this.#writers.keys(), bucketKey]);
    const stem    = Bucketer.stemFor(bucketKey, this.#bucketing, allKeys);
    const ext     = this.#formatExt();
    const path    = join(this.#bucketDir, `${stem}${ext}`);

    // Ensure directory exists
    await mkdirAsync(this.#bucketDir, { recursive: true });

    const writer = new StreamWriter(path, this.#format, this.#prefixes);

    try {
      await writer.open();
    } catch (err) {
      // Lazy-open failure: surface cleanly; caller aborts the run
      logger.error('lazyOpen', 'Failed to open bucket stream — aborting', {
        bucketKey,
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    this.#writers.set(bucketKey, writer);
    this.#lruOrder.push(bucketKey);

    logger.debug('lazyOpen', 'Lazily opened bucket writer', { bucketKey, path });
    return writer;
  }

  /** Evicts the least-recently-used open handle. */
  async #evictLru(): Promise<void> {
    const lruKey = this.#lruOrder.shift();
    if (lruKey === undefined) return;

    const writer = this.#writers.get(lruKey);
    if (writer !== undefined && writer.isOpen) {
      await writer.closeHandle();
      logger.debug('evictLru', 'LRU-evicted bucket handle', { bucketKey: lruKey });
    }
  }

  /** Updates the LRU order to mark a key as most-recently-used. */
  #touchLru(key: string): void {
    const idx = this.#lruOrder.indexOf(key);
    if (idx !== -1) {
      this.#lruOrder.splice(idx, 1);
    }
    this.#lruOrder.push(key);
  }

  /** Returns the file extension for the configured format. */
  #formatExt(): string {
    const extMap: Record<RDFFormat, string> = {
      turtle:   '.ttl',
      trig:     '.trig',
      ntriples: '.nt',
      nquads:   '.nq',
      jsonld:   '.jsonld',
    };
    return extMap[this.#format];
  }
}

// ---------------------------------------------------------------------------
// rdfjs:stream pipeline task
// ---------------------------------------------------------------------------

/**
 * Pipeline task function for `rdfjs:stream`.
 *
 * Invoked once after the final per-record batch settles. All quads have
 * already been written to the stream via the dataset proxy. This task
 * closes the `StreamWriter` and persists the output report.
 *
 * @param next  - Advance function supplied by the orchestrator.
 * @param state - Synthetic pipeline state carrying the run-wide context.
 * @throws {ExternalSchemaError} When `state.context` is undefined.
 * @throws {OutputConfigError}   When format/encoding compatibility fails.
 */
const rdfjsStreamTask: TaskFnInterface<PipelineStateInterface> = async (
  next:  NextFnInterface,
  state: PipelineStateInterface,
): Promise<void> => {
  logger.debug('execute', 'rdfjs:stream task invoked', { targetId: state.targetId });

  const ctx = state.context;
  if (ctx === undefined) {
    throw ExternalSchemaError.create('rdfjs:stream requires state.context to be set by the orchestrator', {
      metadata: { task: TASK_NAME },
    });
  }

  const encoding = (ctx.output as Record<string, unknown>)['encoding'];
  if (encoding !== 'stream') {
    throw OutputConfigError.create(
      `rdfjs:stream task requires output.encoding === 'stream', got "${String(encoding)}"`,
      { metadata: { task: TASK_NAME, encoding } },
    );
  }

  const format = FormatResolver.resolve(ctx.output);

  if (format === 'jsonld') {
    throw OutputConfigError.create(
      'streaming and JSON-LD are mutually exclusive; JSON-LD compaction needs the full graph',
      { metadata: { task: TASK_NAME, format } },
    );
  }

  if (ctx.output.canonicalize === true) {
    throw OutputConfigError.create(
      'streaming and canonicalization are mutually exclusive; canonicalization needs the full graph',
      { metadata: { task: TASK_NAME, format } },
    );
  }

  if (!STREAMING_FORMATS.has(format)) {
    throw OutputConfigError.create(
      `Format "${format}" is not supported for streaming output. Compatible formats: ntriples, nquads, turtle, trig.`,
      { metadata: { task: TASK_NAME, format } },
    );
  }

  const mutableCtx = ctx as unknown as Record<string, unknown>;
  const rawWriter = mutableCtx['__streamWriter'];
  const multiWriter = mutableCtx['__multiStreamWriter'] as MultiStreamWriter | undefined;

  if (multiWriter !== undefined) {
    // Bucketed streaming path
    const { reports, durationMs } = await multiWriter.close();

    const bucketDir = ctx.output.path;
    const totalQuads = reports.reduce((sum, r) => sum + r.quadCount, 0);
    const totalBytes = reports.reduce((sum, r) => sum + r.bytesWritten, 0);

    const report: OutputReportInterface = {
      path:         bucketDir,
      format,
      quadCount:    totalQuads,
      graphCount:   reports.length,
      durationMs,
      bytesWritten: totalBytes,
      errors:       [],
      buckets:      reports,
    };

    const runDir     = join(ctx.outDir, ctx.target);
    const reportPath = join(runDir, OUTPUT_REPORT_FILENAME);
    await mkdirAsync(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, OutputReport.toJson(report), 'utf8');

    logger.info('finalize', 'Bucketed streaming output written and report persisted', {
      targetId:     state.targetId,
      bucketDir,
      reportPath,
      totalQuads,
      totalBytes,
      durationMs,
    });

    await next();
    return;
  }

  const writer = rawWriter as StreamWriter | undefined;
  if (writer === undefined) {
    throw ExternalSchemaError.create(
      'rdfjs:stream: no StreamWriter found on ctx.__streamWriter -- orchestrator must open it before per-record dispatch',
      { metadata: { task: TASK_NAME } },
    );
  }

  const report = await writer.close();

  const runDir     = join(ctx.outDir, ctx.target);
  const reportPath = join(runDir, OUTPUT_REPORT_FILENAME);
  await mkdirAsync(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, OutputReport.toJson(report), 'utf8');

  logger.info('finalize', 'Streaming output written and report persisted', {
    targetId:     state.targetId,
    path:         report.path,
    reportPath,
    quadCount:    report.quadCount,
    bytesWritten: report.bytesWritten,
    durationMs:   report.durationMs,
  });

  await next();
};

TaskRegistry.register(TASK_NAME, rdfjsStreamTask);

// ---------------------------------------------------------------------------
// Factory for orchestrator use
// ---------------------------------------------------------------------------

/**
 * Opens a `StreamWriter` for the given context, installs a write-through
 * dataset proxy, and stores the writer at `ctx.__streamWriter`.
 *
 * Called by the orchestrator once per run, before per-record dispatch.
 *
 * @param ctx - The run-wide pipeline context.
 * @since 0.7.0
 */
export async function openStreamingOutput(
  ctx: PipelineContextInterface,
): Promise<void> {
  const outputConfig = ctx.output;
  const format       = FormatResolver.resolve(outputConfig);

  if (format === 'jsonld') {
    throw OutputConfigError.create(
      'streaming and JSON-LD are mutually exclusive; JSON-LD compaction needs the full graph',
      { metadata: { function: 'openStreamingOutput', format } },
    );
  }

  if (outputConfig.canonicalize === true) {
    throw OutputConfigError.create(
      'streaming and canonicalization are mutually exclusive; canonicalization needs the full graph',
      { metadata: { function: 'openStreamingOutput', format } },
    );
  }

  const rawPrefixes  = outputConfig.prefixes as Record<string, string> | undefined;
  const dropInMemory = (outputConfig as Record<string, unknown>)['dropInMemory'] === true;
  const bucketing    = (outputConfig as Record<string, unknown>)['bucketing'] as BucketingConfigInterface | undefined;
  const bucketingEnabled = bucketing?.enabled === true;

  const mutableCtx = ctx as unknown as Record<string, unknown>;

  if (bucketingEnabled) {
    // Bucketed streaming path — use MultiStreamWriter
    const strategy  = bucketing!.strategy ?? 'per-graph-iri';
    const bucketDir = outputConfig.path;

    await mkdirAsync(bucketDir, { recursive: true });

    const multiWriter = new MultiStreamWriter(format, bucketing!, bucketDir, rawPrefixes);

    if (strategy === 'per-config-bucket') {
      await multiWriter.openAll();
      logger.debug('openStreamingOutput', 'Multi-stream writer pre-opened (per-config-bucket)', {
        bucketDir,
        format,
      });
    } else {
      multiWriter.startLazy();
      logger.debug('openStreamingOutput', 'Multi-stream writer lazy-open ready (per-graph-iri)', {
        bucketDir,
        format,
      });
    }

    mutableCtx['__multiStreamWriter'] = multiWriter;

    const proxy = buildDatasetProxy(ctx.dataset, multiWriter, dropInMemory);
    mutableCtx['dataset'] = proxy;

    if (dropInMemory) {
      logger.warn('openStreamingOutput', 'dropInMemory=true with bucketing: downstream tasks will see an empty store', {
        bucketDir,
      });
    }

    logger.debug('openStreamingOutput', 'Bucketed streaming output initialized', {
      bucketDir,
      format,
      strategy,
      dropInMemory,
    });
    return;
  }

  // Single-file streaming path
  const writer = new StreamWriter(outputConfig.path, format, rawPrefixes);
  await writer.open();

  if (dropInMemory) {
    logger.warn('openStreamingOutput', 'dropInMemory=true: downstream tasks that scan ctx.dataset (provenance, ontology:emit) will see an empty store', {
      path: outputConfig.path,
    });
  }

  mutableCtx['__streamWriter'] = writer;

  const proxy = buildDatasetProxy(ctx.dataset, writer, dropInMemory);
  mutableCtx['dataset'] = proxy;

  logger.debug('openStreamingOutput', 'Streaming output initialized', {
    path:         outputConfig.path,
    format,
    dropInMemory,
  });
}
