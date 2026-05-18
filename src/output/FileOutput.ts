/**
 * @fileoverview `FileOutput` — the single-file RDF output sink for Squashage v0.x.
 *
 * @remarks
 * `FileOutput` implements {@link OutputInterface} for the dataset-mode and
 * stream-mode code paths.  In v0.x both modes collect quads in memory and
 * serialize atomically in `close()` — stream-mode is accepted by the config
 * schema (and its incompatibility with `canonicalize`/`validate` is enforced
 * there) but the actual I/O is identical to dataset mode.  Streaming as a true
 * byte-pipe is a v1.x optimization, documented in the class remarks below.
 *
 * **Atomic write** — the serialized document is written to `<path>.tmp`,
 * optionally fsynced, then renamed to `<path>`.  On any failure the `.tmp`
 * file is left in place as `<path>.partial` for post-mortem inspection; the
 * destination path is never touched.
 *
 * **SHACL gate** — when `output.validate.shapes` is configured, the shapes
 * file is parsed with {@link Parser}, wrapped in a {@link Dataset}, and
 * validated against the buffered data via {@link ShaclGate}.  On failure
 * two quarantine artifacts are written via raw `fs.promises` to
 * `<runDir>/quarantine/output/`: `validation.report.txt` and
 * `validation.report.ttl`.  The destination output file is never created.
 *
 * **JSON-LD context** — when `output.format === 'jsonld'`, a compaction
 * context is resolved via the following priority order:
 *   1. `output.jsonldContext` is a plain object → used verbatim.
 *   2. `output.jsonldContext` is the string `'auto'` or is absent → auto-built
 *      from the buffered quads + `prefixes` via {@link JsonldContext.build}.
 *   3. `output.jsonldContext` is any other string → treated as a path resolved
 *      relative to `configDir`; loaded via {@link JsonldContext.loadFromPath}.
 *
 * @module output/FileOutput
 * @category Output
 * @since 2.2.0
 */

import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { readFile }                        from 'node:fs/promises';
import { join, dirname, resolve }          from 'node:path';

import type { Quad }                       from '@rdfjs/types';
import type { RDFFormat }                  from '../rdf/Formats.js';
import type { OutputConfigInterface }      from '../config/OutputConfig.js';
import type { OutputInterface, OutputReportInterface, BucketReportInterface } from './OutputInterface.js';
import type { PrefixResolutionInterface }  from '../classification/PrefixResolver.js';

import { Formats }                         from '../rdf/Formats.js';
import { Serializer }                      from '../rdf/Serializer.js';
import { JsonldContext }                   from '../rdf/JsonldContext.js';
import { Canonicalize }                    from '../rdf/Canonicalize.js';
import { Parser }                          from '../rdf/Parser.js';
import { Dataset }                         from '../rdf/Dataset.js';
import { dataFactory }                     from '../rdf/DataFactory.js';
import { ShaclGate }                       from '../shacl/ShaclGate.js';
import { FormatResolver }                  from './FormatResolver.js';
import { Bucketer }                        from './Bucketer.js';
import type { BucketingConfigInterface }   from './Bucketer.js';
import { FileOutputError }                 from '../errors/FileOutputError.js';
import { Logger }                          from '../modules/logger/logger.js';

const log = Logger.forComponent('FileOutput');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Counts distinct graph names in a quad collection.
 *
 * @remarks
 * The default graph is counted as one entry when present, regardless of how
 * many triples it contains.  Named graphs each contribute one count per
 * distinct IRI value.
 */
function countGraphs(quads: ReadonlyArray<Quad>): number {
  const seen = new Set<string>();
  for (const q of quads) {
    seen.add(q.graph.termType === 'DefaultGraph' ? '__default__' : q.graph.value);
  }
  return seen.size;
}

// ---------------------------------------------------------------------------
// FileOutput class
// ---------------------------------------------------------------------------

/**
 * Single-file RDF output sink that implements the three-phase
 * `open → writeBatch → close` lifecycle defined by {@link OutputInterface}.
 *
 * @remarks
 * **Lifecycle** — Create one instance per run, call `open()` once, call
 * `writeBatch()` for each batch of quads, then call `close()` to finalize.
 * The instance is single-use; do not call `open()` twice.
 *
 * **Stream mode (v0.x)** — When `output.mode === 'stream'`, quads are still
 * collected in memory and serialized in `close()`.  The v0.x implementation
 * is identical to dataset mode.  True incremental streaming — where the
 * serializer is fed quads as plugins emit them — is a v1.x performance
 * optimization.  The plan's schema constraint already enforces that
 * `canonicalize` and `validate` are both disabled in stream mode, so the
 * buffer-and-serialize approach is semantically correct for v0.x.
 *
 * **Atomic write** — The serialized string is written to `<path>.tmp`, then
 * (if the platform supports it) the file handle is fsynced, then the
 * `.tmp` is renamed to `<path>`.  On any I/O failure the `.tmp` is renamed
 * to `<path>.partial` for post-mortem inspection.  The destination file is
 * never partially overwritten.
 *
 * **SHACL validation** — Applied between canonicalization and serialization.
 * The shapes file extension is used to determine its format.  On failure,
 * `validation.report.txt` and `validation.report.ttl` are written under
 * `<runDir>/quarantine/output/`; the destination file is never touched and
 * `FileOutputError` is thrown with `metadata.stage === 'validate'`.
 *
 * **JSON-LD context** — When `output.format === 'jsonld'`, a compaction
 * context is resolved at close time from `output.jsonldContext`, the run's
 * `prefixes`, and the buffered quad set.  See the module-level remarks for the
 * full priority order.
 *
 * @example Basic usage
 * ```ts
 * const out = new FileOutput(config, runDir, prefixes, configDir);
 * await out.open();
 * await out.writeBatch(ctx.dataset);
 * const report = await out.close();
 * ```
 *
 * @example Dry run
 * ```ts
 * const out = new FileOutput({ ...config, dryRun: true }, runDir, prefixes, configDir);
 * await out.open();
 * await out.writeBatch(quads);
 * const report = await out.close();
 * assert.equal(report.bytesWritten, 0);
 * ```
 *
 * @category Output
 * @since 2.2.0
 * @see {@link OutputInterface}
 * @see {@link FormatResolver}
 * @see {@link ShaclGate}
 * @see {@link JsonldContext}
 * @group Core
 */
export class FileOutput implements OutputInterface {
  readonly #config:    OutputConfigInterface;
  readonly #runDir:    string;
  readonly #format:    RDFFormat;
  readonly #buffer:    Quad[] = [];
  readonly #prefixes:  PrefixResolutionInterface | undefined;
  readonly #configDir: string | undefined;

  #openedAt: number = 0;

  /**
   * @param config    - Validated output config from the squashage target.
   * @param runDir    - Run-scoped base directory; quarantine artifacts are written
   *   under `<runDir>/quarantine/output/`.
   * @param prefixes  - Optional resolved prefix-base pairs from the run, used to
   *   auto-build a JSON-LD compaction context when `format === 'jsonld'` and no
   *   explicit `jsonldContext` path is configured.
   * @param configDir - Optional absolute path to the directory containing the
   *   squashage config file.  Used to resolve a relative `output.jsonldContext`
   *   string path.  Falls back to `process.cwd()` when absent.
   */
  public constructor(
    config:     OutputConfigInterface,
    runDir:     string,
    prefixes?:  PrefixResolutionInterface,
    configDir?: string,
  ) {
    this.#config    = config;
    this.#runDir    = runDir;
    this.#format    = FormatResolver.resolve(config);
    this.#prefixes  = prefixes;
    this.#configDir = configDir;
  }

  // ---------------------------------------------------------------------------
  // OutputInterface — public surface
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  public get path(): string { return this.#config.path; }

  /** @inheritdoc */
  public get format(): RDFFormat { return this.#format; }

  /**
   * Initializes the output sink by ensuring the destination directory exists.
   *
   * @remarks
   * Records the wall-clock start timestamp so `close()` can compute
   * `durationMs`.  Parent directories of `config.path` are created with
   * `{ recursive: true }` — the call is idempotent and safe for concurrent
   * runs writing to distinct paths.
   *
   * @returns Resolves when the directory has been created (or already exists).
   * @throws {FileOutputError} When directory creation fails.
   */
  public async open(): Promise<void> {
    log.debug('open', 'Opening output sink', { path: this.#config.path, format: this.#format });

    this.#openedAt = Date.now();

    try {
      await mkdir(dirname(this.#config.path), { recursive: true });
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw FileOutputError.create(
        `Failed to create output directory for "${this.#config.path}"`,
        { cause, metadata: { stage: 'open', path: this.#config.path } },
      );
    }

    log.info('open', 'Output directory ready', { path: this.#config.path });
  }

  /**
   * Buffers quads for serialization in `close()`.
   *
   * @remarks
   * Both `mode === 'dataset'` and `mode === 'stream'` append quads to the
   * in-memory buffer in v0.x.  Streaming incremental I/O is deferred to v1.x.
   *
   * @param quads - Quads to buffer.
   */
  public async writeBatch(quads: Iterable<Quad>): Promise<void> {
    log.debug('writeBatch', 'Buffering quads', { path: this.#config.path });

    for (const q of quads) {
      this.#buffer.push(q);
    }

    log.debug('writeBatch', 'Batch accepted', { path: this.#config.path, bufferSize: this.#buffer.length });
  }

  /**
   * Finalizes the output: applies transforms, serializes, writes atomically,
   * and returns the output report.
   *
   * @remarks
   * When `output.bucketing.enabled === true`:
   * - Canonicalization and SHACL validation run once on the union dataset.
   * - The dataset is then classified into per-bucket groups via {@link Bucketer}.
   * - Each non-empty bucket is serialized and written atomically.
   * - The report `path` field is the bucket-root directory; `buckets` holds
   *   per-bucket detail.
   *
   * When bucketing is off, the existing single-file path runs unchanged.
   *
   * @returns The structured output report.
   * @throws {FileOutputError} On validation failure, serialization error, or I/O failure.
   */
  public async close(): Promise<OutputReportInterface> {
    log.debug('close', 'Beginning close sequence', { path: this.#config.path });

    const bucketing = (this.#config as Record<string, unknown>)['bucketing'] as BucketingConfigInterface | undefined;
    const bucketingEnabled = bucketing?.enabled === true;

    if (bucketingEnabled) {
      return this.#closeBucketed(bucketing!);
    }

    return this.#closeSingleFile();
  }

  // ---------------------------------------------------------------------------
  // Private close paths
  // ---------------------------------------------------------------------------

  /**
   * Single-file close path (bucketing off) — unchanged from pre-bucketing behaviour.
   */
  async #closeSingleFile(): Promise<OutputReportInterface> {
    let quads: ReadonlyArray<Quad> = this.#buffer;

    // Step 1 — Canonicalize
    if (this.#config.canonicalize === true) {
      quads = await this.#canonicalize(quads);
    }

    // Step 2 — Graph rewrite
    if (this.#config.graph !== undefined) {
      quads = this.#rewriteGraph(quads, this.#config.graph);
    }

    // Step 3 — SHACL validation
    if (this.#config.validate !== undefined) {
      await this.#shaclValidate(quads);
    }

    // Step 4 — Dry run
    if (this.#config.dryRun === true) {
      return this.#dryRunReport(quads);
    }

    // Step 5 — Serialize
    const { data } = await this.#serialize(quads);

    // Step 6 — Atomic write
    await this.#atomicWrite(data, this.#config.path);

    const bytesWritten = Buffer.byteLength(data, 'utf8');
    const durationMs   = Date.now() - this.#openedAt;

    const report: OutputReportInterface = {
      path:         this.#config.path,
      format:       this.#format,
      quadCount:    quads.length,
      graphCount:   countGraphs(quads),
      durationMs,
      bytesWritten,
      errors:       [],
    };

    log.info('close', 'Output written successfully', {
      path:         report.path,
      format:       report.format,
      quadCount:    report.quadCount,
      graphCount:   report.graphCount,
      durationMs:   report.durationMs,
      bytesWritten: report.bytesWritten,
    });

    return report;
  }

  /**
   * Bucketed close path — classify quads into per-bucket groups, serialize
   * and write each non-empty bucket atomically.
   *
   * @remarks
   * Canonicalization and SHACL validation run once on the full union before
   * classification. Each bucket is serialized independently.
   *
   * @param bucketing - The validated bucketing config block.
   */
  async #closeBucketed(bucketing: BucketingConfigInterface): Promise<OutputReportInterface> {
    const bucketDir = this.#config.path;

    log.debug('closeBucketed', 'Starting bucketed close', { bucketDir });

    // Ensure bucket directory exists
    await mkdir(bucketDir, { recursive: true });

    let quads: ReadonlyArray<Quad> = this.#buffer;

    // Step 1 — Canonicalize on union (before classify)
    if (this.#config.canonicalize === true) {
      quads = await this.#canonicalize(quads);
    }

    // Step 2 — SHACL validation on union (before classify)
    if (this.#config.validate !== undefined) {
      await this.#shaclValidate(quads);
    }

    // Step 3 — Dry run
    if (this.#config.dryRun === true) {
      return this.#dryRunReport(quads);
    }

    // Step 4 — Classify into per-bucket groups
    const groups  = Bucketer.classify(quads, bucketing);
    const allKeys = new Set(groups.keys());

    // Step 5 — Default-graph handling: emit warning when no defaultGraphFilename
    if (groups.has('__default__') && bucketing.defaultGraphFilename === undefined) {
      log.warn('closeBucketed', 'Default-graph quads present but bucketing.defaultGraphFilename not set — writing to "default" bucket', {
        quadCount: groups.get('__default__')?.length ?? 0,
      });
    }

    // Step 6 — Serialize + write each bucket
    const bucketReports: BucketReportInterface[] = [];
    let totalBytes = 0;
    let totalQuads = 0;

    for (const [bucketKey, bucketQuads] of groups) {
      const file = Bucketer.filenameFor(bucketKey, this.#format, bucketing, bucketDir, allKeys);

      // Determine graphIri for the report
      const graphIri = bucketKey === '__default__' || bucketKey === '__other__'
        ? null
        : bucketKey;

      if (bucketQuads.length === 0) {
        bucketReports.push({
          bucketKey,
          path:         null,
          graphIri,
          stem:         file.stem,
          format:       this.#format,
          quadCount:    0,
          bytesWritten: 0,
        });
        continue;
      }

      const { data } = await this.#serialize(bucketQuads);
      await this.#atomicWrite(data, file.path);

      const bytes = Buffer.byteLength(data, 'utf8');
      totalBytes += bytes;
      totalQuads += bucketQuads.length;

      bucketReports.push({
        bucketKey,
        path:         file.path,
        graphIri,
        stem:         file.stem,
        format:       this.#format,
        quadCount:    bucketQuads.length,
        bytesWritten: bytes,
      });

      log.info('closeBucketed', 'Bucket written', {
        bucketKey,
        path:         file.path,
        quadCount:    bucketQuads.length,
        bytesWritten: bytes,
      });
    }

    const durationMs = Date.now() - this.#openedAt;

    const report: OutputReportInterface = {
      path:         bucketDir,
      format:       this.#format,
      quadCount:    totalQuads,
      graphCount:   groups.size,
      durationMs,
      bytesWritten: totalBytes,
      errors:       [],
      buckets:      bucketReports,
    };

    log.info('closeBucketed', 'Bucketed output complete', {
      bucketDir,
      bucketCount:  bucketReports.length,
      quadCount:    totalQuads,
      bytesWritten: totalBytes,
      durationMs,
    });

    return report;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Runs RDFC-1.0 canonicalization over the quad buffer.
   */
  async #canonicalize(quads: ReadonlyArray<Quad>): Promise<ReadonlyArray<Quad>> {
    log.debug('canonicalize', 'Running RDFC-1.0 canonicalization', { count: quads.length });
    try {
      const result = await Canonicalize.run(quads);
      log.info('canonicalize', 'Canonicalization complete', { inputCount: quads.length, outputCount: result.length });
      return result;
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw FileOutputError.create(
        'Canonicalization failed',
        { cause, metadata: { stage: 'canonicalize', path: this.#config.path } },
      );
    }
  }

  /**
   * Rewrites every quad's graph component to the given named graph IRI.
   */
  #rewriteGraph(quads: ReadonlyArray<Quad>, graphIri: string): ReadonlyArray<Quad> {
    log.debug('rewriteGraph', 'Rewriting quad graphs', { graphIri, count: quads.length });
    const g = dataFactory.namedNode(graphIri);
    return quads.map(q => dataFactory.quad(q.subject, q.predicate, q.object, g));
  }

  /**
   * Runs the SHACL gate and emits quarantine artifacts on failure.
   *
   * @throws {FileOutputError} When the data graph does not conform to the shapes.
   */
  async #shaclValidate(quads: ReadonlyArray<Quad>): Promise<void> {
    const shapesPath = this.#config.validate!.shapes;
    log.debug('shaclValidate', 'Loading SHACL shapes', { shapesPath });

    let shapesText: string;
    try {
      shapesText = await readFile(shapesPath, 'utf8');
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw FileOutputError.create(
        `Failed to read SHACL shapes file "${shapesPath}"`,
        { cause, metadata: { stage: 'validate', shapesPath } },
      );
    }

    const shapesFormat = Formats.formatFromExtension(shapesPath);
    if (shapesFormat === undefined) {
      throw FileOutputError.create(
        `Cannot determine format for SHACL shapes file "${shapesPath}" — use a recognised extension (.ttl, .trig, .nt, .nq, .jsonld).`,
        { metadata: { stage: 'validate', shapesPath } },
      );
    }

    const { quads: shapeQuads } = await Parser.parse(shapesText, { format: shapesFormat });
    const shapesGraph = Dataset.from(shapeQuads);
    const dataGraph   = Dataset.from(quads);

    log.debug('shaclValidate', 'Running SHACL validation', { shapesPath, dataSize: quads.length });

    const report = await ShaclGate.run(shapesGraph, dataGraph);

    if (!report.conforms) {
      log.warn('shaclValidate', 'SHACL validation failed — emitting quarantine artifacts', {
        path:           this.#config.path,
        violationCount: report.results.length,
      });

      await this.#emitValidationQuarantine(report);

      throw FileOutputError.create(
        `SHACL validation failed — ${report.results.length} constraint violation(s)`,
        { metadata: { stage: 'validate', path: this.#config.path, shapesPath, violationCount: report.results.length } },
      );
    }

    log.info('shaclValidate', 'SHACL validation passed', { shapesPath, dataSize: quads.length });
  }

  /**
   * Writes `validation.report.txt` and `validation.report.ttl` to
   * `<runDir>/quarantine/output/`.
   */
  async #emitValidationQuarantine(
    report: Awaited<ReturnType<typeof ShaclGate.run>>,
  ): Promise<void> {
    const quarantineDir = join(this.#runDir, 'quarantine', 'output');

    try {
      await mkdir(quarantineDir, { recursive: true });

      // Plain-text human-readable summary
      const txt = ShaclGate.formatReport(report);
      await writeFile(join(quarantineDir, 'validation.report.txt'), txt, 'utf8');

      // Turtle-serialized W3C SHACL ValidationReport RDF
      const reportQuads = [...report.reportDataset] as Quad[];
      const { data: ttl } = await Serializer.serialize(reportQuads, {
        format:   'turtle',
        prefixes: { sh: 'http://www.w3.org/ns/shacl#' },
      });
      await writeFile(join(quarantineDir, 'validation.report.ttl'), ttl, 'utf8');

      log.info('emitValidationQuarantine', 'Quarantine artifacts written', {
        txt: join(quarantineDir, 'validation.report.txt'),
        ttl: join(quarantineDir, 'validation.report.ttl'),
      });
    } catch (err) {
      // Log and swallow — we are already in an error path; don't mask the primary error.
      const msg = err instanceof Error ? err.message : String(err);
      log.error('emitValidationQuarantine', 'Failed to write quarantine artifacts', { error: msg });
    }
  }

  /**
   * Resolves the JSON-LD compaction context to use for serialization.
   *
   * @remarks
   * Priority order:
   * 1. `output.jsonldContext` is a plain object → used verbatim.
   * 2. `output.jsonldContext` is `'auto'` or absent → auto-built from quads + prefixes.
   * 3. `output.jsonldContext` is any other string → treated as a path, resolved
   *    relative to `configDir` (or `process.cwd()`), loaded with
   *    {@link JsonldContext.loadFromPath}.
   *
   * @param quads - The buffered quad set (used for auto-build).
   * @returns The resolved context document.
   */
  async #resolveJsonldContext(
    quads: ReadonlyArray<Quad>,
  ): Promise<Record<string, unknown>> {
    const rawContext = (this.#config as Record<string, unknown>)['jsonldContext'];

    // Case 1: inline object → use verbatim.
    if (rawContext !== undefined && typeof rawContext === 'object' && rawContext !== null) {
      log.debug('resolveJsonldContext', 'Using inline jsonldContext object');
      return rawContext as Record<string, unknown>;
    }

    // Case 2: absent or 'auto' string → auto-build from quads + prefixes.
    if (rawContext === undefined || rawContext === 'auto') {
      log.debug('resolveJsonldContext', 'Auto-building JSON-LD context from quads and prefixes');
      if (this.#prefixes !== undefined) {
        return JsonldContext.build(quads, this.#prefixes) as Record<string, unknown>;
      }
      // No prefixes available — build with an empty-ish context (just well-known prefixes).
      // This is safe: the auto-builder seeds rdf:/xsd: regardless.
      return JsonldContext.build(quads, {
        instances:  { prefix: '', base: '' },
        graphs:     { prefix: '', base: '' },
        vocabulary: { prefix: '', base: '' },
        source:     'fallback',
      }) as Record<string, unknown>;
    }

    // Case 3: string path → resolve and load.
    const base = this.#configDir ?? process.cwd();
    const absPath = resolve(base, rawContext as string);
    log.debug('resolveJsonldContext', 'Loading JSON-LD context from path', { absPath });
    return JsonldContext.loadFromPath(absPath) as unknown as Record<string, unknown>;
  }

  /**
   * Serializes the buffered quads to a string.
   */
  async #serialize(quads: ReadonlyArray<Quad>): Promise<{ data: string }> {
    log.debug('serialize', 'Serializing quads', { format: this.#format, count: quads.length });
    try {
      const opts: Parameters<typeof Serializer.serialize>[1] = { format: this.#format };
      if (this.#config.prefixes !== undefined) {
        opts.prefixes = this.#config.prefixes as Record<string, string>;
      }
      if (this.#config.baseIRI !== undefined) {
        opts.baseIRI = this.#config.baseIRI;
      }

      // Resolve JSON-LD context when the format is jsonld.
      if (this.#format === 'jsonld') {
        opts.jsonldContext = await this.#resolveJsonldContext(quads);
      }

      const result = await Serializer.serialize([...quads], opts);
      log.debug('serialize', 'Serialization complete', { byteLength: Buffer.byteLength(result.data, 'utf8') });
      return { data: result.data };
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw FileOutputError.create(
        `Serialization to "${this.#format}" failed`,
        { cause, metadata: { stage: 'serialize', path: this.#config.path, format: this.#format } },
      );
    }
  }

  /**
   * Atomic write: `<path>.tmp` → fsync → rename.  On failure, renames the
   * `.tmp` to `<path>.partial` and re-throws.
   *
   * @param data      - UTF-8 content to write.
   * @param destPath  - Destination file path (defaults to `this.#config.path`
   *   for the single-file mode; pass the bucket path for bucketed writes).
   */
  async #atomicWrite(data: string, destPath: string): Promise<void> {
    const tmpPath     = `${destPath}.tmp`;
    const partialPath = `${destPath}.partial`;

    log.debug('atomicWrite', 'Writing to tmp path', { tmpPath });

    try {
      await writeFile(tmpPath, data, 'utf8');
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw FileOutputError.create(
        `Failed to write tmp file "${tmpPath}"`,
        { cause, metadata: { stage: 'finalize', path: destPath, tmpPath } },
      );
    }

    // fsync to flush kernel page-cache to disk before the rename
    try {
      const fh = await open(tmpPath, 'r+');
      await fh.sync();
      await fh.close();
    } catch {
      // fsync is best-effort; on platforms/filesystems that do not support
      // it (e.g. tmpfs in some CI environments), we log and continue.
      log.warn('atomicWrite', 'fsync failed — continuing without sync guarantee', { tmpPath });
    }

    // Atomic rename
    try {
      await rename(tmpPath, destPath);
    } catch (err) {
      // Rename failed: leave the tmp as .partial for inspection
      try {
        await rename(tmpPath, partialPath);
      } catch {
        // Best-effort partial rename; ignore secondary failure
      }
      const cause = err instanceof Error ? err : undefined;
      throw FileOutputError.create(
        `Atomic rename from "${tmpPath}" to "${destPath}" failed`,
        { cause, metadata: { stage: 'finalize', path: destPath, tmpPath, partialPath } },
      );
    }

    log.debug('atomicWrite', 'Rename complete', { dest: destPath });
  }

  /**
   * Builds the dry-run report (no I/O performed).
   */
  #dryRunReport(quads: ReadonlyArray<Quad>): OutputReportInterface {
    const durationMs = Date.now() - this.#openedAt;
    log.info('dryRun', 'Dry run — skipping write', { path: this.#config.path, quadCount: quads.length });
    return {
      path:         this.#config.path,
      format:       this.#format,
      quadCount:    quads.length,
      graphCount:   countGraphs(quads),
      durationMs,
      bytesWritten: 0,
      errors:       [],
    };
  }
}
