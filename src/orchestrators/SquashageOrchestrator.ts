/**
 * @fileoverview `SquashageOrchestrator` — run-wide context construction, per-record
 * pipeline dispatch, and drain-then-finalize lifecycle for Squashage v0.x.
 *
 * @remarks
 * The orchestrator follows the pipeline lifecycle established by plan 13
 * (§"Pipeline Lifecycle: Orchestrator-Driven Finalize"). It:
 *
 * 1. Resolves the target config and applies CLI overrides.
 * 2. Constructs the run-wide {@link PipelineContextInterface} (factory, dataset,
 *    builder, graphs, iri, output, prefixes).
 * 3. Strips `rdfjs:finalize` from the per-record pipeline so the finalize task
 *    never runs inside a per-record `ConcurrentPipeline` execution.
 * 4. Instantiates classifier task classes from `targetConfig.classification` via
 *    {@link ClassificationFactory.build} and registers each on the per-run
 *    {@link TaskRegistry} instance.
 * 5. Walks the input source (single `.json`, single `.jsonl`, or a directory
 *    that is recursively walked for `.json` and `.jsonl` files) and builds one
 *    {@link PipelineStateInterface} per record, each carrying its own augmented
 *    context with `config.recordPath` / `config.recordLine` so `json:read` can
 *    locate the record on disk.
 * 6. Drives per-record execution via {@link ConcurrentPipeline.executeAll}.
 * 7. After the per-record batch settles, invokes the finalize task once with a
 *    synthetic state carrying the run-wide context.
 * 8. Computes and returns the {@link RunResultInterface}.
 *
 * The module `'../tasks/index.js'` is imported once at the top so the global
 * {@link TaskRegistry} is populated with all built-in tasks before any pipeline
 * is assembled.
 *
 * @module orchestrators/SquashageOrchestrator
 * @category Orchestrator
 * @since 0.1.0
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import { join, extname, dirname, resolve as resolvePath } from 'node:path';

// Bootstrap built-in task registrations (json:read, rdfjs:finalize, rdfjs:stream).
import '../tasks/index.js';
import { openStreamingOutput } from '../tasks/rdfjsStream.js';

import type { SquashageConfigInterface, TargetConfigInterface } from '../config/SquashageConfig.js';
import type { OutputConfigInterface }      from '../config/OutputConfig.js';
import type { PipelineStateInterface, PipelineContextInterface } from '../types/PipelineState.js';
import type { ClassificationConfigInterface } from '../classification/ClassificationFactory.js';

import { ClassificationFactory }   from '../classification/ClassificationFactory.js';
import { PrefixResolver }          from '../classification/PrefixResolver.js';
import type { PrefixResolutionInterface } from '../classification/PrefixResolver.js';
import { Pipeline }                from '../pipeline/Pipeline.js';
import { ConcurrentPipeline }      from '../pipeline/ConcurrentPipeline.js';
import { PipelineState }           from '../registry/PipelineState.js';
import { TaskRegistry }            from '../registry/TaskRegistry.js';
import { SquashageConfigError }     from '../errors/SquashageConfigError.js';
import { dataFactory }             from '../rdf/DataFactory.js';
import { Dataset }                 from '../rdf/Dataset.js';
import { GraphBuilder }            from '../rdf/GraphBuilder.js';
import { Namespaces }              from '../rdf/Namespaces.js';
import { QuarantineWriter }        from '../quarantine/QuarantineWriter.js';
import { Logger }                  from '../modules/logger/logger.js';
import { JsonTologyOntology }      from '../ontology/JsonTologyOntology.js';
import type { JsonTologySchemaInputInterface } from '../ontology/JsonTologyOntology.js';
import { EntityLinkTask }          from '../tasks/entityLink.js';
import type { EntityLinkConfigInterface } from '../tasks/entityLink.js';

const logger = Logger.forComponent('SquashageOrchestrator');

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * The aggregate result of a single Squashage target run.
 *
 * @remarks
 * Returned by {@link SquashageOrchestrator.run} after the finalize phase
 * completes. The {@link exitCode} follows the same semantics as the CLI exit
 * code: `0` for a clean run, `1` for quarantine failures, `2` is reserved for
 * pre-run config errors thrown before this object is produced.
 *
 * @category Orchestrator
 * @since 0.1.0
 * @see {@link SquashageOrchestrator}
 * @group Types
 */
export interface RunResultInterface {
  /** Target identifier from the squashage config. */
  readonly target:      string;
  /** Total number of input records discovered during the walk phase. */
  readonly recordCount: number;
  /** Number of records that completed the per-record pipeline without throwing. */
  readonly succeeded:   number;
  /** Number of records that caused the per-record pipeline to throw. */
  readonly failed:      number;
  /** Quarantine bucket counts collected by {@link QuarantineWriter}. */
  readonly quarantine:  { unknown: number; conflicts: number; projection: number; output: number };
  /** Resolved output file path (from the synthesized output config). */
  readonly outputPath:  string;
  /** Process exit code for this run. */
  readonly exitCode:    0 | 1 | 2;
}

/**
 * Options for a single {@link SquashageOrchestrator.run} invocation.
 *
 * @remarks
 * CLI-supplied flags map directly to these options. Each field overrides the
 * corresponding field in the target's config without mutating it.
 *
 * @category Orchestrator
 * @since 0.1.0
 * @see {@link SquashageOrchestrator}
 * @group Types
 */
export interface RunOptionsInterface {
  /** Override the resolved `output.path` from the target config. */
  readonly outOverride?:    string | undefined;
  /** Override the resolved `output.format` from the target config. */
  readonly formatOverride?: string | undefined;
  /** When `true`, {@link FileOutput} computes the report but does not write the file. */
  readonly dryRun?:         boolean | undefined;
  /** Override the input directory/file path (default: `targetConfig.input`). */
  readonly inputOverride?:  string | undefined;
  /** Output base directory for reports and quarantine artifacts (default: `'./graphs'`). */
  readonly outDir?:         string | undefined;
  /**
   * Absolute path to the squashage config file.
   *
   * @remarks
   * Used to derive `schemasBase` for resolving relative `schemaPath` entries in
   * `classification.schemas[]`. When absent, `process.cwd()` is used as the base.
   */
  readonly configPath?:     string | undefined;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A `{ recordPath, recordLine }` pair identifying one input record on disk. */
interface RecordLocatorInterface {
  /** Absolute or relative path to the file that contains this record. */
  readonly recordPath: string;
  /** 0-based line index within a JSONL file; always `0` for plain JSON files. */
  readonly recordLine: number;
}

// ---------------------------------------------------------------------------
// SquashageOrchestrator
// ---------------------------------------------------------------------------

/**
 * Static-only orchestrator that drives a full Squashage target run.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated. Each call to
 * {@link SquashageOrchestrator.run} is fully isolated — it constructs its own
 * run-wide context, pipeline, and quarantine writer.
 *
 * **Lifecycle** (per plan 13 §"Pipeline Lifecycle: Orchestrator-Driven Finalize"):
 *
 * 1. Validate target exists in `config.targets`.
 * 2. Apply CLI overrides to a synthesized {@link OutputConfigInterface}.
 * 3. Construct the run-wide {@link PipelineContextInterface} (including `prefixes`).
 * 4. Strip `rdfjs:finalize` from the per-record task list; hold a reference.
 * 5. Instantiate classifier tasks via {@link ClassificationFactory.build} and
 *    register them on a per-run {@link TaskRegistry} instance.
 * 6. Build a {@link Pipeline} from the remaining per-record tasks (backed by
 *    the per-run registry).
 * 7. Walk the input source to produce `RecordLocatorInterface[]`.
 * 8. Build one {@link PipelineStateInterface} per record, each augmented with
 *    `config.recordPath` / `config.recordLine`.
 * 9. Execute via {@link ConcurrentPipeline.executeAll}.
 * 10. Invoke the finalize task once with a synthetic state carrying `ctx`.
 * 11. Return the {@link RunResultInterface}.
 *
 * @example
 * ```ts
 * const config = SquashageConfig.loadFromFile('./squashage.config.json');
 * const result = await SquashageOrchestrator.run(config, 'aonprd', {
 *   outOverride: './graphs/aonprd.jsonld',
 *   outDir:      './graphs',
 *   configPath:  './squashage.config.json',
 * });
 * process.exitCode = result.exitCode;
 * ```
 *
 * @category Orchestrator
 * @since 0.1.0
 * @see {@link RunResultInterface}
 * @see {@link RunOptionsInterface}
 * @group Core
 */
export class SquashageOrchestrator {
  private constructor() { /* static-only */ }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Executes a full Squashage build for one target.
   *
   * @remarks
   * The method resolves the target config, applies CLI overrides, constructs
   * the run-wide {@link PipelineContextInterface}, walks the input source,
   * dispatches per-record tasks, drains into the finalize task, and returns
   * the {@link RunResultInterface}.
   *
   * The `rdfjs:finalize` task is invoked exactly once after the final batch
   * settles.  Any error thrown by the finalize task propagates to the caller
   * (the CLI wraps it and sets `process.exitCode = 2`).
   *
   * @param config  - Validated squashage config loaded via {@link SquashageConfig.loadFromFile}.
   * @param target  - Target key to run (must exist in `config.targets`).
   * @param options - Optional CLI override flags.
   * @returns Aggregate run result including counts, quarantine summary, and exit code.
   * @throws {SquashageConfigError} When `target` is not found in `config.targets`.
   * @throws {ExternalSchemaError}  When a task named in `pipeline` is not registered.
   * @throws Any error propagated from `rdfjs:finalize` (I/O, SHACL, serialization).
   */
  public static async run(
    config:  SquashageConfigInterface,
    target:  string,
    options: RunOptionsInterface = {},
  ): Promise<RunResultInterface> {
    logger.info('run', 'Starting Squashage run', { target, options: options as Record<string, unknown> });

    // Step 1 — Look up target config.
    const targetConfig = SquashageOrchestrator.#resolveTarget(config, target);

    // Step 2 — Apply CLI overrides to a synthesized output config.
    const outDir       = options.outDir ?? './graphs';
    const outputConfig = SquashageOrchestrator.#buildOutputConfig(targetConfig, options);

    // Step 3 — Context construction is deferred to after the input walk so that
    //           PrefixResolver.resolve() can peek at the first record's path.
    //           See Step 7b below.

    // Step 4 — Strip end-of-run tasks (rdfjs:finalize, rdfjs:stream, enrich:entity-link) from per-record tasks; retain references.
    //
    // These are end-of-run tasks invoked by the orchestrator once after the
    // per-record batch settles, not inside the per-record pipeline loop.
    // enrich:entity-link runs BEFORE rdfjs:finalize so it can contribute quads
    // to the dataset before serialization.
    const FINALIZE_NAME    = 'rdfjs:finalize';
    const STREAM_NAME      = 'rdfjs:stream';
    const ENTITY_LINK_NAME = 'enrich:entity-link';
    const perRecordNames   = targetConfig.pipeline.filter(
      name => name !== FINALIZE_NAME && name !== STREAM_NAME && name !== ENTITY_LINK_NAME,
    );

    // Step 5 — Build a per-run TaskRegistry and register classifier task instances.
    const registry = new TaskRegistry();

    // Instantiate and register classifier tasks when classification config is present.
    const classification = targetConfig.classification as ClassificationConfigInterface | undefined;
    if (classification !== undefined) {
      const schemasBase = options.configPath !== undefined
        ? dirname(options.configPath)
        : process.cwd();

      logger.debug('run', 'Building classifier instances', { target, schemasBase });
      const classifierInstances = ClassificationFactory.build(
        classification,
        outDir,
        target,
        schemasBase,
      );

      // Register only the classifier instances that are both instantiated AND
      // listed in the target's pipeline.
      const pipelineSet = new Set(targetConfig.pipeline);

      if (pipelineSet.has('classify:source') && classifierInstances['classify:source'] !== undefined) {
        registry.register('classify:source', classifierInstances['classify:source'].execute);
      }
      if (pipelineSet.has('classify:structural') && classifierInstances['classify:structural'] !== undefined) {
        registry.register('classify:structural', classifierInstances['classify:structural'].execute);
      }
      if (pipelineSet.has('classify:rules') && classifierInstances['classify:rules'] !== undefined) {
        registry.register('classify:rules', classifierInstances['classify:rules'].execute);
      }
      if (pipelineSet.has('classify:schema') && classifierInstances['classify:schema'] !== undefined) {
        registry.register('classify:schema', classifierInstances['classify:schema'].execute);
      }
      if (pipelineSet.has('classify:ontology') && classifierInstances['classify:ontology'] !== undefined) {
        registry.register('classify:ontology', classifierInstances['classify:ontology'].execute);
      }
      if (pipelineSet.has('classify:conflict') && classifierInstances['classify:conflict'] !== undefined) {
        registry.register('classify:conflict', classifierInstances['classify:conflict'].execute);
      }
      if (pipelineSet.has('classify:shacl-shape') && classifierInstances['classify:shacl-shape'] !== undefined) {
        registry.register('classify:shacl-shape', classifierInstances['classify:shacl-shape'].execute);
      }
      if (pipelineSet.has('classify:taxonomic-narrowing') && classifierInstances['classify:taxonomic-narrowing'] !== undefined) {
        registry.register('classify:taxonomic-narrowing', classifierInstances['classify:taxonomic-narrowing'].execute);
      }
      if (pipelineSet.has('classify:url-pattern') && classifierInstances['classify:url-pattern'] !== undefined) {
        registry.register('classify:url-pattern', classifierInstances['classify:url-pattern'].execute);
      }
      if (pipelineSet.has('classify:property-fingerprint') && classifierInstances['classify:property-fingerprint'] !== undefined) {
        registry.register('classify:property-fingerprint', classifierInstances['classify:property-fingerprint'].execute);
      }
      if (pipelineSet.has('classify:winknlp-entities') && classifierInstances['classify:winknlp-entities'] !== undefined) {
        registry.register('classify:winknlp-entities', classifierInstances['classify:winknlp-entities'].execute);
      }

      logger.info('run', 'Classifier tasks registered', { target, tasks: Object.keys(classifierInstances) });
    }

    // Register enrich:entity-link when configured and listed in the pipeline.
    const pipelineSet = new Set(targetConfig.pipeline);
    if (pipelineSet.has('enrich:entity-link')) {
      const enrichment = targetConfig.enrichment as Record<string, unknown> | undefined;
      const entityLinkCfg = enrichment?.['entityLink'] as EntityLinkConfigInterface | undefined;
      if (entityLinkCfg !== undefined) {
        const entityLinkTask = EntityLinkTask.create(entityLinkCfg);
        registry.register('enrich:entity-link', entityLinkTask.execute);
        logger.info('run', 'enrich:entity-link task registered', { target });
      }
    }

    // Look up all per-record tasks eagerly; classifier tasks come from the per-run registry,
    // built-in tasks (json:read, rdfjs:finalize, plugin tasks) fall back to the static registry.
    const perRecordTasks = perRecordNames.map(name => {
      if (registry.has(name)) {
        return registry.get(name);
      }
      return TaskRegistry.get(name);
    });

    // Resolve the finalize task based on output.encoding.
    const isStreamingOutput = (outputConfig as Record<string, unknown>)['encoding'] === 'stream';
    const activeFinalizeTask = isStreamingOutput
      ? TaskRegistry.get(STREAM_NAME)
      : TaskRegistry.get(FINALIZE_NAME);
    const activeFinalizeTaskName = isStreamingOutput ? STREAM_NAME : FINALIZE_NAME;

    logger.debug('run', 'Pipeline tasks resolved', {
      target,
      perRecord: perRecordNames,
      finalize:  activeFinalizeTaskName,
      streaming: isStreamingOutput,
    });

    // Step 6 — Build per-record Pipeline.
    const pipeline = Pipeline.create<PipelineStateInterface>({ name: `squashage:${target}` });
    pipeline.addTasks(perRecordTasks);

    // Step 7 — Walk input source.
    const inputRoot = options.inputOverride ?? targetConfig.input;
    const locators  = await SquashageOrchestrator.#walkInput(inputRoot);

    logger.info('walk', 'Input walk complete', { target, inputRoot, recordCount: locators.length });

    // Step 7b — Resolve prefix-base pairs.
    //
    // Peek at the first locator to produce a minimal InputSourceInterface for URL
    // derivation. This requires no additional I/O — the path is already known from
    // the walk. PrefixResolver.resolve is pure and deterministic.
    const firstLocator = locators[0];
    const sampleSource = firstLocator !== undefined
      ? { target, path: firstLocator.recordPath }
      : undefined;

    const prefixes = PrefixResolver.resolve(target, targetConfig, sampleSource);

    // Step 3a — Build optional json-tology ontology instance when engine === 'json-tology'.
    const schemasBase = options.configPath !== undefined
      ? dirname(options.configPath)
      : process.cwd();

    const jtInstance = await SquashageOrchestrator.#buildJtInstance(targetConfig, schemasBase);

    // Step 3 (deferred) — Construct run-wide PipelineContextInterface with resolved prefixes.
    // Freeze the run-start time once here so provenance timestamps are deterministic.
    const runStartTime = new Date().toISOString();
    const ctx = SquashageOrchestrator.#buildContext(target, outDir, targetConfig, outputConfig, prefixes, jtInstance, runStartTime);

    logger.debug('run', 'Run-wide context constructed', {
      target,
      instanceBase:   prefixes.instances.base,
      graphBase:      prefixes.graphs.base,
      vocabularyBase: prefixes.vocabulary.base,
      prefixSource:   prefixes.source,
    });

    // Step 8b — Open streaming output before building per-record states.
    // IMPORTANT: must run BEFORE Step 8 so that the dataset proxy installed by
    // openStreamingOutput is visible to the spread in Step 8.
    if (isStreamingOutput) {
      logger.debug('run', 'Opening streaming output before per-record dispatch', { target });
      await openStreamingOutput(ctx);
      logger.info('run', 'Streaming output opened', { target, path: outputConfig.path });
    }

    // Step 8 — Build one state per record with per-record context augmentation.
    const states = locators.map(({ recordPath, recordLine }) => {
      const source = { target, path: recordPath };
      const state  = PipelineState.fromInput(target, source, {});

      // Augment the shared context with the record-specific locator so json:read
      // can find the file.  Each record gets its own context object that spreads
      // the run-wide config and adds recordPath / recordLine.
      const recordConfig: Record<string, unknown> = {
        ...(ctx.config as Record<string, unknown>),
        recordPath,
        recordLine,
      };
      const recordCtx: PipelineContextInterface = { ...ctx, config: recordConfig };
      (state as unknown as { context: PipelineContextInterface }).context = recordCtx;

      return state;
    });

    // Step 9 — Execute per-record pipeline with bounded concurrency.
    const concurrency = targetConfig.concurrency ?? 1;
    const runner = ConcurrentPipeline.create<PipelineStateInterface>(pipeline, concurrency, {
      name: `squashage:${target}`,
    });

    logger.debug('execute', 'Dispatching per-record pipeline', {
      target,
      recordCount: states.length,
      concurrency,
    });

    const { completed, failed } = await runner.executeAll(states);

    logger.info('execute', 'Per-record pipeline settled', {
      target,
      succeeded: completed.length,
      failed:    failed.length,
    });

    // Step 10 — Invoke end-of-run tasks once with a synthetic state carrying ctx.
    //
    // Order: enrich:entity-link (enrichment) -> rdfjs:finalize (serialization).
    // Both receive the same synthetic state.
    const endOfRunState: PipelineStateInterface = {
      targetId:        target,
      source:          { target, path: '__end-of-run__' },
      input:           {},
      classification:  null,
      classifications: [],
      output:          null,
      context:         ctx,
    };

    // Invoke enrich:entity-link when it was listed in the pipeline and is registered.
    if (targetConfig.pipeline.includes(ENTITY_LINK_NAME)) {
      const entityLinkTask = registry.has(ENTITY_LINK_NAME)
        ? registry.get(ENTITY_LINK_NAME)
        : undefined;

      if (entityLinkTask !== undefined) {
        logger.debug('enrich', 'Invoking enrich:entity-link', { target });
        await entityLinkTask(async (): Promise<void> => { /* no-op next */ }, endOfRunState);
        logger.info('enrich', 'enrich:entity-link completed', { target });
      }
    }

    logger.debug('finalize', `Invoking ${activeFinalizeTaskName}`, { target });

    await activeFinalizeTask(async (): Promise<void> => { /* no-op next */ }, endOfRunState);

    logger.info('finalize', `${activeFinalizeTaskName} completed`, { target });

    // Step 11 — Compute RunResultInterface.
    const qw         = QuarantineWriter.forRun(outDir, target);
    const quarantine = qw.summary();
    const exitCode   = failed.length > 0
      ? (1 as const)
      : QuarantineWriter.exitCodeFor(quarantine, false);

    const result: RunResultInterface = {
      target,
      recordCount: locators.length,
      succeeded:   completed.length,
      failed:      failed.length,
      quarantine,
      outputPath:  outputConfig.path,
      exitCode,
    };

    logger.info('summarize', 'Run complete', {
      target,
      recordCount: result.recordCount,
      succeeded:   result.succeeded,
      failed:      result.failed,
      exitCode:    result.exitCode,
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolves the `TargetConfigInterface` from the config by key.
   *
   * @param config - Root squashage config.
   * @param target - Target key to look up.
   * @returns The resolved target config.
   * @throws {SquashageConfigError} When the key is absent from `config.targets`.
   */
  static #resolveTarget(
    config: SquashageConfigInterface,
    target: string,
  ): TargetConfigInterface {
    const targetConfig = config.targets[target];
    if (targetConfig === undefined) {
      throw SquashageConfigError.create(
        `Target "${target}" not found in squashage config. Available targets: ${Object.keys(config.targets).join(', ')}`,
        { metadata: { target, available: Object.keys(config.targets) } },
      );
    }
    return targetConfig;
  }

  /**
   * Synthesizes a final {@link OutputConfigInterface} from the target config,
   * applying any CLI overrides from `options`.
   *
   * @param targetConfig - Per-target config from the squashage config file.
   * @param options      - CLI override options from the caller.
   * @returns A new, frozen output config object with CLI overrides applied.
   */
  static #buildOutputConfig(
    targetConfig: TargetConfigInterface,
    options:      RunOptionsInterface,
  ): OutputConfigInterface {
    // Build mutable copy then apply overrides imperatively; exactOptionalPropertyTypes
    // forbids spreading conditional `{ dryRun: true }` over an `OutputConfigInterface`
    // whose `dryRun?` is typed as `boolean | undefined`.
    const out: Record<string, unknown> = { ...targetConfig.output as unknown as Record<string, unknown> };

    if (options.outOverride    !== undefined) out['path']   = options.outOverride;
    if (options.formatOverride !== undefined) out['format'] = options.formatOverride;
    if (options.dryRun === true)              out['dryRun'] = true;

    return Object.freeze(out as unknown as OutputConfigInterface);
  }

  /**
   * Constructs the run-wide {@link PipelineContextInterface} from the target
   * config, resolved output config, and resolved prefix-base pairs.
   *
   * @param target       - Target identifier.
   * @param outDir       - Output base directory.
   * @param targetConfig - Validated target config.
   * @param outputConfig - Synthesized output config (CLI overrides already applied).
   * @param prefixes     - Resolved prefix-base pairs from {@link PrefixResolver.resolve}.
   * @param jt           - Optional json-tology ontology instance (present when engine === "json-tology").
   * @returns Fully populated `PipelineContextInterface`.
   */
  static #buildContext(
    target:        string,
    outDir:        string,
    targetConfig:  TargetConfigInterface,
    outputConfig:  OutputConfigInterface,
    prefixes:      PrefixResolutionInterface,
    jt?:           JsonTologyOntology,
    runStartTime?: string,
  ): PipelineContextInterface {
    const ontology = targetConfig.ontology;
    const baseIri  =
      (typeof ontology?.['baseIri'] === 'string' ? ontology['baseIri'] : undefined) ??
      'https://example.org/';

    const graphs = Object.fromEntries(
      Object.entries(targetConfig.graphs ?? {}).map(([k, v]) => [k, dataFactory.namedNode(v)]),
    );

    const ctx: PipelineContextInterface = {
      target,
      outDir,
      config:  Object.freeze({ ...(targetConfig as unknown as Record<string, unknown>) }),
      factory: dataFactory,
      dataset: Dataset.empty(),
      builder: new GraphBuilder(baseIri),
      graphs:  Object.freeze(graphs),
      iri:     Namespaces.for(baseIri),
      output:  outputConfig,
      prefixes,
      ...(jt !== undefined ? { jt } : {}),
      ...(runStartTime !== undefined ? { runStartTime } : {}),
    };

    return ctx;
  }

  /**
   * Builds a {@link JsonTologyOntology} instance when
   * `targetConfig.ontology.engine === "json-tology"`, otherwise returns `undefined`.
   *
   * @param targetConfig - Per-target config containing the optional ontology block.
   * @param schemasBase  - Base directory for resolving relative schemaPath entries.
   * @returns The constructed instance, or `undefined` when the engine is absent or "map".
   */
  static async #buildJtInstance(
    targetConfig: TargetConfigInterface,
    schemasBase:  string,
  ): Promise<JsonTologyOntology | undefined> {
    const ontologyBlock = targetConfig.ontology as Record<string, unknown> | undefined;
    if (ontologyBlock === undefined) return undefined;

    const engine = ontologyBlock['engine'];
    if (engine !== 'json-tology') return undefined;

    const baseIRI  = ontologyBlock['baseIRI'] as string;
    const rawSchemas = ontologyBlock['schemas'] as ReadonlyArray<{ readonly schemaPath: string }> | undefined;
    if (rawSchemas === undefined || rawSchemas.length === 0) return undefined;

    const schemaInputs: JsonTologySchemaInputInterface[] = await Promise.all(
      rawSchemas.map(async entry => {
        const absPath = resolvePath(schemasBase, entry.schemaPath);
        const text    = await readFile(absPath, 'utf8');
        const schema  = JSON.parse(text) as Record<string, unknown> & { readonly '$id': string };
        return { schemaPath: entry.schemaPath, schema };
      }),
    );

    logger.debug('run', 'Building JsonTologyOntology instance', {
      baseIRI,
      schemaCount: schemaInputs.length,
    });

    return JsonTologyOntology.create({ baseIRI, schemas: schemaInputs });
  }

  /**
   * Walks an input path and returns one {@link RecordLocatorInterface} per record.
   *
   * @remarks
   * Resolution rules:
   * - A path ending `.json`: one record, `recordLine = 0`.
   * - A path ending `.jsonl`: count non-blank lines; one locator per line.
   * - A directory: recursively walked; every `.json` and `.jsonl` file yields
   *   one or more locators.
   * - Anything else (or an inaccessible path): returns an empty array after logging.
   *
   * @param inputPath - Absolute or CWD-relative path to the input file or directory.
   * @returns Array of record locators, one per discoverable input record.
   */
  static async #walkInput(inputPath: string): Promise<RecordLocatorInterface[]> {
    logger.debug('walk', 'Walking input path', { inputPath });

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(inputPath);
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      logger.warn('walk', 'Input path not accessible; returning empty record list', {
        inputPath,
        error: cause?.message,
      });
      return [];
    }

    if (info.isDirectory()) {
      return SquashageOrchestrator.#walkDirectory(inputPath);
    }

    const ext = extname(inputPath).toLowerCase();
    if (ext === '.jsonl') {
      return SquashageOrchestrator.#locatorsFromJsonl(inputPath);
    }

    // Plain .json or unrecognised extension: single record.
    return [{ recordPath: inputPath, recordLine: 0 }];
  }

  /**
   * Recursively walks a directory and collects locators for every `.json`
   * and `.jsonl` file found.
   *
   * @param dirPath - Absolute path to the directory to walk.
   * @returns Flat array of all record locators found under the directory.
   */
  static async #walkDirectory(dirPath: string): Promise<RecordLocatorInterface[]> {
    const results: RecordLocatorInterface[] = [];
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const nested = await SquashageOrchestrator.#walkDirectory(fullPath);
        results.push(...nested);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (ext === '.json') {
          results.push({ recordPath: fullPath, recordLine: 0 });
        } else if (ext === '.jsonl') {
          const locators = await SquashageOrchestrator.#locatorsFromJsonl(fullPath);
          results.push(...locators);
        }
      }
    }

    return results;
  }

  /**
   * Reads a JSONL file and produces one {@link RecordLocatorInterface} per
   * non-blank line.
   *
   * @remarks
   * The file is read once to count lines. Record content is read by `json:read`
   * at pipeline execution time; this method only counts lines and produces locators.
   *
   * @param filePath - Absolute path to the JSONL file.
   * @returns Array of locators, one per non-blank line.
   */
  static async #locatorsFromJsonl(filePath: string): Promise<RecordLocatorInterface[]> {
    const text  = await readFile(filePath, 'utf8');
    const lines = text.split('\n');

    const locators: RecordLocatorInterface[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line !== undefined && line.trim().length > 0) {
        locators.push({ recordPath: filePath, recordLine: i });
      }
    }
    return locators;
  }
}
