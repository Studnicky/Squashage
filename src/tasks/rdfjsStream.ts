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

    logger.info('open', 'Stream writer opened', { path: this.#path });
  }

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
 * `dropInMemory` is true), and also writes the quad to the `StreamWriter`.
 *
 * @since 0.7.0
 */
export function buildDatasetProxy(
  inner:        DatasetCore,
  writer:       StreamWriter,
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

  const writer = (ctx as unknown as Record<string, unknown>)['__streamWriter'] as StreamWriter | undefined;
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

  const writer = new StreamWriter(outputConfig.path, format, rawPrefixes);
  await writer.open();

  if (dropInMemory) {
    logger.warn('openStreamingOutput', 'dropInMemory=true: downstream tasks that scan ctx.dataset (provenance, ontology:emit) will see an empty store', {
      path: outputConfig.path,
    });
  }

  const mutableCtx = ctx as unknown as Record<string, unknown>;
  mutableCtx['__streamWriter'] = writer;

  const proxy = buildDatasetProxy(ctx.dataset, writer, dropInMemory);
  mutableCtx['dataset'] = proxy;

  logger.debug('openStreamingOutput', 'Streaming output initialized', {
    path:         outputConfig.path,
    format,
    dropInMemory,
  });
}
