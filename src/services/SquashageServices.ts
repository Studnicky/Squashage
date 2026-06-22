/**
 * SquashageServices — the dispatcher's services bag.
 *
 * Replaces every `context:*` lifecycle hook from the legacy
 * `TaskRegistry`-driven orchestrator with a single class whose constructor
 * eagerly builds every run-wide dependency. Passed to `new SquashageDagonizer({
 * services })` once; every node reads `context.services.<x>`.
 *
 * No bridges (`__sampleSource`, `__schemasBase`), no mutable post-construction
 * slot assignment. Every parameter is named, individually addressable, and has
 * a documented default. The class is the source of truth for what nodes can
 * read off the dispatcher.
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve as resolvePath } from 'node:path';

import AjvModule        from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { DataFactory, DatasetCore, NamedNode } from '@rdfjs/types';

import { PrefixResolver } from '../classification/PrefixResolver.js';
import type { PrefixResolutionInterface } from '../classification/PrefixResolver.js';
import { SubjectIriPolicy } from '../induction/SubjectIriPolicy.js';
import type { ShapeObservation } from '../induction/ShapeObservation.js';
import type { SquashageRunConfigInterface } from '../config/SquashageConfig.js';
import type { OutputConfigInterface } from '../config/OutputConfig.js';
import { Logger } from '../modules/logger/logger.js';
import { JsonTologyOntology } from '../ontology/JsonTologyOntology.js';
import type { JsonTologySchemaInputInterface } from '../ontology/JsonTologyOntology.js';
import { QuarantineWriter } from '../quarantine/QuarantineWriter.js';
import { dataFactory } from '../rdf/DataFactory.js';
import { Dataset } from '../rdf/Dataset.js';
import { GraphBuilder } from '../rdf/GraphBuilder.js';
import { Namespaces } from '../rdf/Namespaces.js';
import type { NamespaceBuilder } from '../rdf/Namespaces.js';
import type { AjvCtorType, AddFormatsFnInterface } from '../types/AjvInterop.js';
import type { LoggerFactoryInterface } from '../types/Logger.js';
import type { InputSource } from '../state/schemas/InputSource.js';
import { Serializer } from '../rdf/Serializer.js';
import type { RecordWriterInterface, ProvSinkInterface } from '../rdf/Serializer.js';
import type { RDFFormat } from '../rdf/Formats.js';

const Ajv        = (AjvModule        as unknown as { default?: AjvCtorType }).default        ?? (AjvModule        as unknown as AjvCtorType);
const addFormats = (addFormatsModule as unknown as { default?: AddFormatsFnInterface }).default ?? (addFormatsModule as unknown as AddFormatsFnInterface);

const log = Logger.forComponent('SquashageServices');

// ---------------------------------------------------------------------------
// Process-level core schema cache
// ---------------------------------------------------------------------------

/**
 * Resolved absolute path to the bundled `src/schemas/core/` directory.
 * Computed once from `import.meta.url` so it is correct regardless of the
 * working directory at call time.
 */
const CORE_SCHEMAS_DIR: string = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'core',
);

/**
 * Process-level cache for the core schema inputs.  Populated on first call
 * to {@link SquashageServices.#loadCoreSchemas} and reused thereafter.
 */
let coreSchemaCache: ReadonlyArray<JsonTologySchemaInputInterface> | null = null;

/**
 * Options the dispatcher needs at construction. All required; no defaults
 * inside the class — defaults live in `SquashageConfig` and the CLI.
 */
export interface SquashageServicesOptionsInterface {
  /** Resolved run config (the validated single-run squashage config). */
  readonly targetConfig: SquashageRunConfigInterface;
  /** Target identifier (the key in `targets[]`). */
  readonly target: string;
  /** Resolved output config; CLI overrides already merged. */
  readonly output: OutputConfigInterface;
  /** Output base directory; reports + quarantine artifacts land under it. */
  readonly outDir: string;
  /** Directory used to resolve relative ontology `schemaPath` entries. */
  readonly schemasBase: string;
  /** Optional first-record `_source`, used by `PrefixResolver` for URL-host derivation. */
  readonly sampleSource: InputSource | undefined;
  /** ISO 8601 timestamp frozen at run start; consumed by `output-provenance`. */
  readonly runStartTime: string;
}

/** Container holding every dispatcher-scoped dependency for the run. */
export class SquashageServices {
  readonly logger:       LoggerFactoryInterface;
  readonly ajv:          InstanceType<AjvCtorType>;
  readonly factory:      DataFactory;
  readonly dataset:      DatasetCore;
  readonly builder:      GraphBuilder;
  readonly prefixes:     PrefixResolutionInterface;
  readonly iri:          NamespaceBuilder;
  readonly graphs:       Readonly<Record<string, NamedNode>>;
  readonly ontology:     JsonTologyOntology | null;
  readonly quarantine:   QuarantineWriter;
  readonly output:       OutputConfigInterface;
  readonly target:       string;
  readonly outDir:       string;
  readonly schemasBase:  string;
  readonly runStartTime: string;
  readonly targetConfig: SquashageRunConfigInterface;
  readonly subjectIri:   SubjectIriPolicy;
  /** Mutable per-run shape accumulator; populated by the `shape-observe` node. */
  readonly shapeCache:   Map<string, ShapeObservation>;
  /** Mutable per-run refine tallies; populated by `draft-dispatch` during the fan-out. */
  readonly refineSummaries: { refinedCount: number; passthroughCount: number; runErrors: string[] };
  /**
   * Mutable streaming writer for per-record ABox quads.
   *
   * When non-null, `ontologyProjection` writes quads directly to this stream
   * instead of accumulating them in `services.dataset`, avoiding the V8
   * string-length wall on large datasets (~1.4M+ quads).
   *
   * Set lazily on first write by `ontologyProjection` via
   * `services.openRecordWriter()`; closed by `rdfjs-finalize` after the
   * fan-out drains.
   *
   * Null when the output format requires batch serialization (e.g. JSON-LD)
   * or when the target has no ontology engine configured.
   */
  recordWriter: RecordWriterInterface | null;
  /**
   * Internal Promise that serializes concurrent lazy-open calls to
   * `openRecordWriter()`.  The first call in a concurrent fan-out stores its
   * Promise here so all subsequent calls await the same handle rather than
   * opening the file twice.
   *
   * @internal
   */
  recordWriterReady: Promise<RecordWriterInterface> | null;
  /**
   * Mutable synchronous sink for per-run PROV-O quads.
   *
   * When non-null, `ProvObserver` writes PROV quads directly to this sink
   * instead of accumulating them in `services.dataset`, avoiding unbounded
   * Promise and string accumulation across ~1M+ synchronous PROV events on
   * large corpora.
   *
   * Set eagerly by `SquashageRun.forTarget` (before the run starts) when
   * output mode is `'stream'`; closed by `rdfjs-finalize` after the fan-out
   * drains.
   *
   * Null when the output format requires batch serialization (e.g. JSON-LD),
   * when the output path is unknown, or in dataset mode.
   */
  provSink: ProvSinkInterface | null;
  /**
   * Internal Promise that serializes concurrent lazy-open calls to
   * `openProvSink()`.
   *
   * @internal
   */
  provSinkReady: Promise<ProvSinkInterface> | null;

  /**
   * Resolved paths for schema artefacts produced by the induction pipeline.
   *
   * `inferred`    — draft schemas written by `write-drafts`
   * `refinements` — operator refinement files consumed by `squashage:refine`
   * `finals`      — final blessed schemas consumed by `squashage:run`
   *
   * Defaults are `<schemasBase>/schemas/inferred`, `<schemasBase>/schemas/refinements`,
   * and `<schemasBase>/schemas` respectively. May be overridden via
   * `targetConfig.schemaPaths`.
   */
  readonly schemaPaths: {
    readonly inferred:    string;
    readonly refinements: string;
    readonly finals:      string;
  };

  private constructor(slots: {
    logger:       LoggerFactoryInterface;
    ajv:          InstanceType<AjvCtorType>;
    factory:      DataFactory;
    dataset:      DatasetCore;
    builder:      GraphBuilder;
    prefixes:     PrefixResolutionInterface;
    iri:          NamespaceBuilder;
    graphs:       Readonly<Record<string, NamedNode>>;
    ontology:     JsonTologyOntology | null;
    quarantine:   QuarantineWriter;
    output:       OutputConfigInterface;
    target:       string;
    outDir:       string;
    schemasBase:  string;
    runStartTime: string;
    targetConfig: SquashageRunConfigInterface;
    subjectIri:   SubjectIriPolicy;
    shapeCache:       Map<string, ShapeObservation>;
    refineSummaries:  { refinedCount: number; passthroughCount: number; runErrors: string[] };
    schemaPaths:  { inferred: string; refinements: string; finals: string };
    recordWriter:       RecordWriterInterface | null;
    recordWriterReady:  Promise<RecordWriterInterface> | null;
    provSink:           ProvSinkInterface | null;
    provSinkReady:      Promise<ProvSinkInterface> | null;
  }) {
    this.logger       = slots.logger;
    this.ajv          = slots.ajv;
    this.factory      = slots.factory;
    this.dataset      = slots.dataset;
    this.builder      = slots.builder;
    this.prefixes     = slots.prefixes;
    this.iri          = slots.iri;
    this.graphs       = slots.graphs;
    this.ontology     = slots.ontology;
    this.quarantine   = slots.quarantine;
    this.output       = slots.output;
    this.target       = slots.target;
    this.outDir       = slots.outDir;
    this.schemasBase  = slots.schemasBase;
    this.runStartTime = slots.runStartTime;
    this.targetConfig = slots.targetConfig;
    this.subjectIri   = slots.subjectIri;
    this.shapeCache      = slots.shapeCache;
    this.refineSummaries = slots.refineSummaries;
    this.schemaPaths     = slots.schemaPaths;
    this.recordWriter      = slots.recordWriter;
    this.recordWriterReady = slots.recordWriterReady;
    this.provSink          = slots.provSink;
    this.provSinkReady     = slots.provSinkReady;
  }

  /**
   * Concurrency-safe lazy opener for the per-record streaming writer.
   *
   * @remarks
   * The first caller in a concurrent fan-out stores a Promise in
   * `this.recordWriterReady`; all subsequent concurrent callers await the
   * same Promise rather than opening the file a second time.  Once resolved,
   * `this.recordWriter` holds the open handle for direct access without
   * re-awaiting.
   *
   * This method is a no-op when the output format is JSON-LD (which requires
   * batch serialization) — it returns `null` in that case.
   *
   * @param outputPath - Absolute path for the success graph output file.
   * @param format     - Resolved RDF format for the run.
   * @returns The open {@link RecordWriterInterface}, or `null` for JSON-LD.
   */
  async openRecordWriter(
    outputPath: string,
    format:     RDFFormat,
  ): Promise<RecordWriterInterface | null> {
    if (format === 'jsonld') return null;

    // Already open — return immediately.
    if (this.recordWriter !== null) return this.recordWriter;

    // Concurrent lazy-open: first caller wins, all others await the same promise.
    if (this.recordWriterReady !== null) {
      return this.recordWriterReady;
    }

    // `recordWriter` and `recordWriterReady` are declared non-readonly mutable
    // slots precisely for this purpose — the only mutable side-channel in services.
    const promise = Serializer.openStream(
      outputPath,
      format as Exclude<RDFFormat, 'jsonld'>,
    ).then((handle) => {
      this.recordWriter = handle;
      return handle;
    });

    this.recordWriterReady = promise;
    return promise;
  }

  /**
   * Concurrency-safe lazy opener for the PROV-O sidecar synchronous sink.
   *
   * @remarks
   * Mirrors `openRecordWriter()` but returns a {@link ProvSinkInterface} rather
   * than a {@link RecordWriterInterface}.  The sidecar path is derived from
   * `outputPath` by inserting `.prov` before the extension (e.g.
   * `out.nq` → `out.prov.nq`).
   *
   * Returns `null` for JSON-LD (which requires batch serialization).
   *
   * @param outputPath - Absolute path for the success graph output file.
   * @param format     - Resolved RDF format for the run.
   * @returns The open {@link ProvSinkInterface}, or `null` for JSON-LD.
   */
  async openProvSink(
    outputPath: string,
    format:     RDFFormat,
  ): Promise<ProvSinkInterface | null> {
    if (format === 'jsonld') return null;

    // Already open — return immediately.
    if (this.provSink !== null) return this.provSink;

    // Concurrent lazy-open: first caller wins.
    if (this.provSinkReady !== null) {
      return this.provSinkReady;
    }

    const ext      = extname(outputPath);
    const stem     = outputPath.slice(0, outputPath.length - ext.length);
    const provPath = `${stem}.prov${ext.length > 0 ? ext : '.nq'}`;

    const promise = Serializer.openProvSink(provPath).then((handle) => {
      this.provSink = handle;
      return handle;
    });

    this.provSinkReady = promise;
    return promise;
  }

  /**
   * Eagerly build the services bag for one run.
   *
   * Construction order matches the legacy `context:*` hook order:
   * logger → ajv → factory → dataset → builder → prefixes → iri → graphs →
   * ontology → quarantine. Each step is synchronous except ontology
   * (filesystem reads for schemas).
   */
  static async forTarget(options: SquashageServicesOptionsInterface): Promise<SquashageServices> {
    const logger  = Logger as unknown as LoggerFactoryInterface;
    const ajv     = SquashageServices.#buildAjv();
    const factory = dataFactory;
    const dataset = Dataset.empty();
    const builder = new GraphBuilder(SquashageServices.#resolveBaseIri(options.targetConfig));
    const prefixes = PrefixResolver.resolve(
      options.target,
      options.targetConfig,
      options.sampleSource,
    );
    const iri    = Namespaces.for(SquashageServices.#resolveBaseIri(options.targetConfig));
    const graphs = SquashageServices.#mintGraphs(options.targetConfig, factory);
    const ontology   = await SquashageServices.#buildOntology(options.targetConfig, options.schemasBase);
    const quarantine = QuarantineWriter.forRun(options.outDir, options.target);
    const subjectIri = SubjectIriPolicy.fromTargetConfig(
      options.targetConfig,
      prefixes.instances.base,
    );

    const schemaPaths = SquashageServices.#buildSchemaPaths(
      options.targetConfig,
      options.schemasBase,
    );

    log.debug('forTarget', 'services bag built', {
      target:       options.target,
      prefixSource: prefixes.source,
      hasOntology:  ontology !== null,
    });

    return new SquashageServices({
      logger, ajv, factory, dataset, builder, prefixes, iri, graphs,
      ontology, quarantine, output: options.output, target: options.target,
      outDir: options.outDir, schemasBase: options.schemasBase,
      runStartTime: options.runStartTime, targetConfig: options.targetConfig,
      subjectIri, shapeCache: new Map(),
      refineSummaries: { refinedCount: 0, passthroughCount: 0, runErrors: [] },
      schemaPaths,
      recordWriter:      null,
      recordWriterReady: null,
      provSink:          null,
      provSinkReady:     null,
    });
  }

  static #buildAjv(): InstanceType<AjvCtorType> {
    const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: false });
    addFormats(ajv);
    return ajv;
  }

  static #resolveBaseIri(targetConfig: SquashageRunConfigInterface): string {
    const ontology  = targetConfig.ontology as Readonly<Record<string, unknown>> | undefined;
    const candidate = ontology?.['baseIri'];
    return typeof candidate === 'string' && candidate.length > 0
      ? candidate
      : 'https://example.org/';
  }

  static #mintGraphs(
    targetConfig: SquashageRunConfigInterface,
    factory:      DataFactory,
  ): Readonly<Record<string, NamedNode>> {
    const rawGraphs = targetConfig.graphs ?? {};
    const entries   = Object.entries(rawGraphs).map<[string, NamedNode]>(
      ([key, iri]) => [key, factory.namedNode(iri)],
    );
    return Object.freeze(Object.fromEntries(entries));
  }

  static #buildSchemaPaths(
    targetConfig: SquashageRunConfigInterface,
    schemasBase:  string,
  ): { inferred: string; refinements: string; finals: string } {
    const raw = targetConfig as unknown as Readonly<Record<string, unknown>>;
    const override = raw['schemaPaths'] as Readonly<Record<string, string>> | undefined;

    return {
      inferred:    override?.['inferred']    ?? join(schemasBase, 'schemas', 'inferred'),
      refinements: override?.['refinements'] ?? join(schemasBase, 'schemas', 'refinements'),
      finals:      override?.['finals']      ?? join(schemasBase, 'schemas'),
    };
  }

  static async #buildOntology(
    targetConfig: SquashageRunConfigInterface,
    schemasBase:  string,
  ): Promise<JsonTologyOntology | null> {
    const ontologyBlock = targetConfig.ontology as Readonly<Record<string, unknown>> | undefined;
    if (ontologyBlock === undefined) return null;
    if (ontologyBlock['engine'] !== 'json-tology') return null;

    const baseIRI    = ontologyBlock['baseIRI'] as string;
    const rawSchemas = ontologyBlock['schemas'] as ReadonlyArray<{ schemaPath: string }> | undefined;
    if (rawSchemas === undefined || rawSchemas.length === 0) return null;

    const schemaInputs: JsonTologySchemaInputInterface[] = await Promise.all(
      rawSchemas.map(async (entry) => {
        const absPath = resolvePath(schemasBase, entry.schemaPath);
        const text    = await readFile(absPath, 'utf8');
        const schema  = JSON.parse(text) as Record<string, unknown> & { readonly '$id': string };
        return { schemaPath: entry.schemaPath, schema };
      }),
    );

    // Load the bundled core upper-ontology schemas (Layer 0) first so that any
    // per-target class may use allOf + $ref to extend them in a later phase.
    const coreInputs = await SquashageServices.#loadCoreSchemas();

    // Auto-discover extracted primitive/object finals alongside the listed schemas.
    // The finals directory is inferred from the schemasBase (parallel to the listed
    // schema paths). We scan for schemas/primitives/ and schemas/objects/ under
    // schemasBase to pick up all $ref targets produced by the induction pipeline.
    const extractedInputs = await SquashageServices.#loadExtractedSchemas(schemasBase);
    const allInputs = [...coreInputs, ...schemaInputs, ...extractedInputs];

    return JsonTologyOntology.create({ baseIRI, schemas: allInputs });
  }

  /**
   * Loads the bundled core upper-ontology schemas from `src/schemas/core/`.
   *
   * Scans the top-level core directory and any recognised subdirectories
   * (`primitives/`). Primitives are emitted first so that class schemas that
   * `$ref` them are always registered after their `$id` targets.
   *
   * The result is cached in a process-level variable so subsequent runs within
   * the same process avoid redundant filesystem reads.
   */
  static async #loadCoreSchemas(): Promise<ReadonlyArray<JsonTologySchemaInputInterface>> {
    if (coreSchemaCache !== null) return coreSchemaCache;

    // Check whether the core directory exists at all before proceeding.
    let topEntries: string[];
    try {
      topEntries = await readdir(CORE_SCHEMAS_DIR);
    } catch {
      log.warn('#loadCoreSchemas', 'core schemas directory not found; continuing without upper ontology', {
        dir: CORE_SCHEMAS_DIR,
      });
      coreSchemaCache = [];
      return coreSchemaCache;
    }

    const inputs: JsonTologySchemaInputInterface[] = [];

    // 1. Load primitives/ first (they are $ref targets for class schemas).
    const primitivesDir = join(CORE_SCHEMAS_DIR, 'primitives');
    let primEntries: string[];
    try {
      primEntries = await readdir(primitivesDir);
    } catch {
      primEntries = [];
    }
    for (const filename of primEntries.filter((f) => f.endsWith('.schema.json')).sort()) {
      const absPath    = join(primitivesDir, filename);
      const schemaPath = join('schemas', 'core', 'primitives', filename);
      const text   = await readFile(absPath, 'utf8');
      const schema = JSON.parse(text) as Record<string, unknown> & { readonly '$id': string };
      inputs.push({ schemaPath, schema });
    }

    // 2. Load top-level class schemas.
    for (const filename of topEntries.filter((f) => f.endsWith('.schema.json')).sort()) {
      const absPath    = join(CORE_SCHEMAS_DIR, filename);
      const schemaPath = join('schemas', 'core', filename);
      const text   = await readFile(absPath, 'utf8');
      const schema = JSON.parse(text) as Record<string, unknown> & { readonly '$id': string };
      inputs.push({ schemaPath, schema });
    }

    log.debug('#loadCoreSchemas', 'core schemas loaded', { count: inputs.length });
    coreSchemaCache = inputs;
    return coreSchemaCache;
  }

  /**
   * Scan `schemasBase/schemas/primitives/` and `schemasBase/schemas/objects/`
   * for `*.schema.json` files and return them as schema inputs.
   * Returns an empty array when the directories are absent.
   */
  static async #loadExtractedSchemas(
    schemasBase: string,
  ): Promise<JsonTologySchemaInputInterface[]> {
    const subdirs = ['schemas/primitives', 'schemas/objects'];
    const inputs: JsonTologySchemaInputInterface[] = [];

    for (const sub of subdirs) {
      const dir = join(schemasBase, sub);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const filename of entries.filter((f) => f.endsWith('.schema.json')).sort()) {
        const absPath   = join(dir, filename);
        const schemaPath = join(sub, filename);
        try {
          const text   = await readFile(absPath, 'utf8');
          const schema = JSON.parse(text) as Record<string, unknown> & { readonly '$id': string };
          inputs.push({ schemaPath, schema });
        } catch {
          // Skip unreadable or malformed files; the build step will surface errors
          // at JsonTologyOntology.create time if a $ref target is missing.
        }
      }
    }

    return inputs;
  }
}
