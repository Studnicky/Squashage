/**
 * @fileoverview `SquashageOrchestrator` — run-wide context construction, per-record
 * pipeline dispatch, and drain-then-finalize lifecycle for Squashage v0.x.
 *
 * @remarks
 * The orchestrator follows the pipeline lifecycle established by plan 13
 * (§"Pipeline Lifecycle: Orchestrator-Driven Finalize") and the silo contract
 * documented in `docs/context-silo.md`. It:
 *
 * 1. Resolves the target config and applies CLI overrides.
 * 2. Constructs an empty `PipelineContextInterface` shell carrying the
 *    orchestration metadata (`target`, `outDir`, `config`, `output`) plus the
 *    private orchestrator-coordination bridge keys `__sampleSource` /
 *    `__schemasBase` on `ctx.config`.
 * 3. Strips end-of-run tasks (`rdfjs:finalize`, `rdfjs:stream`,
 *    `enrich:entity-link`) from the per-record pipeline so they never run
 *    inside a per-record `ConcurrentPipeline` execution.
 * 4. Runs every applicable `onRunStart` lifecycle hook on the global
 *    {@link TaskRegistry} in registration order. The hooks self-register at
 *    import time (`src/context/index.ts` populates `ctx.logger`, `ctx.ajv`,
 *    `ctx.factory`, `ctx.dataset`, `ctx.builder`, `ctx.iri`, `ctx.prefixes`,
 *    `ctx.graphs`, `ctx.jt`, `ctx.runStartTime`; `src/classification/index.ts`
 *    populates classifier-private run state). Per-record dispatch begins only
 *    after every hook completes.
 * 5. Walks the input source (single `.json`, single `.jsonl`, or a directory
 *    that is recursively walked for `.json` and `.jsonl` files) and builds one
 *    {@link PipelineStateInterface} per record, each carrying its own augmented
 *    context with `config.recordPath` / `config.recordLine` so `json:read` can
 *    locate the record on disk.
 * 6. Drives per-record execution via {@link ConcurrentPipeline.executeAll}.
 * 7. After the per-record batch settles, invokes `enrich:entity-link` (when
 *    configured) and then the finalize task once with a synthetic state
 *    carrying the run-wide context, and finally fires every registered
 *    `onRunEnd` hook.
 * 8. Computes and returns the {@link RunResultInterface}.
 *
 * The module `'../tasks/index.js'` is imported once at the top so the global
 * {@link TaskRegistry} is populated with all built-in tasks, every
 * `context:*` lifecycle hook, and every `classify:*` per-record task + hook
 * before any pipeline is assembled.
 *
 * @module orchestrators/SquashageOrchestrator
 * @category Orchestrator
 * @since 0.1.0
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import { join, extname, dirname }  from 'node:path';

// Bootstrap built-in task registrations + every context lifecycle hook + every
// classifier plugin (`src/tasks/index.js` transitively imports
// `src/context/index.js` and `src/classification/index.js`). This single
// side-effect import populates the global TaskRegistry with everything the
// orchestrator drives below — there is no per-run registry construction.
import '../tasks/index.js';
import { openStreamingOutput } from '../tasks/rdfjsStream.js';

import type { SquashageConfigInterface, TargetConfigInterface } from '../config/SquashageConfig.js';
import type { OutputConfigInterface }      from '../config/OutputConfig.js';
import type { PipelineStateInterface, PipelineContextInterface, InputSourceInterface } from '../types/PipelineState.js';

import { Pipeline }                from '../pipeline/Pipeline.js';
import { ConcurrentPipeline }      from '../pipeline/ConcurrentPipeline.js';
import { PipelineState }           from '../registry/PipelineState.js';
import { TaskRegistry }            from '../registry/TaskRegistry.js';
import { SquashageConfigError }     from '../errors/SquashageConfigError.js';
import { QuarantineWriter }        from '../quarantine/QuarantineWriter.js';
import { Logger }                  from '../modules/logger/logger.js';
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
 * 3. Strip end-of-run tasks (`rdfjs:finalize`, `rdfjs:stream`,
 *    `enrich:entity-link`) from the per-record pipeline; resolve the active
 *    finalize task by output encoding.
 * 4. Walk the input source to produce `RecordLocatorInterface[]` and derive
 *    the bridge keys (`__sampleSource`, `__schemasBase`).
 * 5. Run all `TaskRegistry.onRunStartHooks()` to populate the run-wide silo
 *    (factory, dataset, builder, prefixes, jt, runStartTime, classifier
 *    singletons). Lifecycle plugins self-register at module load time via
 *    `src/tasks/index.js` → `src/context/index.js` + `src/classification/index.js`.
 * 6. Resolve per-record task functions from the global TaskRegistry and build
 *    the {@link Pipeline}.
 * 7. Build one {@link PipelineStateInterface} per record, each augmented with
 *    `config.recordPath` / `config.recordLine`.
 * 8. Execute via {@link ConcurrentPipeline.executeAll}.
 * 9. Invoke `enrich:entity-link` (when configured) and the finalize task once
 *    with a synthetic state carrying `ctx`; fire every registered `onRunEnd`
 *    lifecycle hook.
 * 10. Return the {@link RunResultInterface}.
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

    // Step 3 — Strip end-of-run tasks (rdfjs:finalize, rdfjs:stream, enrich:entity-link) from per-record tasks.
    //
    // These are end-of-run tasks invoked by the orchestrator once after the
    // per-record batch settles, not inside the per-record pipeline loop.
    // enrich:entity-link runs BEFORE rdfjs:finalize so it can contribute quads
    // to the dataset before serialization.
    const FINALIZE_NAME    = 'rdfjs:finalize';
    const STREAM_NAME      = 'rdfjs:stream';
    const ENTITY_LINK_NAME = 'enrich:entity-link';
    const CATALOG_NAME     = 'catalog:emit';
    const perRecordNames   = targetConfig.pipeline.filter(
      name => name !== FINALIZE_NAME && name !== STREAM_NAME && name !== ENTITY_LINK_NAME && name !== CATALOG_NAME,
    );
    const pipelineSet = new Set(targetConfig.pipeline);

    // Step 4 — Walk input source so the first locator is available for prefix
    //          derivation via the `__sampleSource` bridge key.
    const inputRoot = options.inputOverride ?? targetConfig.input;
    const locators  = await SquashageOrchestrator.#walkInput(inputRoot);

    logger.info('walk', 'Input walk complete', { target, inputRoot, recordCount: locators.length });

    const firstLocator = locators[0];
    const sampleSource: InputSourceInterface | undefined = firstLocator !== undefined
      ? { target, path: firstLocator.recordPath }
      : undefined;

    const schemasBase = options.configPath !== undefined
      ? dirname(options.configPath)
      : process.cwd();

    // Step 5 — Build a skeleton PipelineContextInterface and run every applicable
    //          `onRunStart` lifecycle hook on the global TaskRegistry. Hooks
    //          self-register at module load time (`src/tasks/index.js` →
    //          `src/context/index.js` + `src/classification/index.js`); they
    //          populate the silo (`ctx.factory`, `ctx.dataset`, `ctx.builder`,
    //          `ctx.iri`, `ctx.prefixes`, `ctx.graphs`, `ctx.jt`, `ctx.runStartTime`,
    //          `ctx.ajv`, `ctx.logger`) before per-record dispatch.
    //
    //          The `__sampleSource` and `__schemasBase` keys on `ctx.config` are
    //          PRIVATE orchestrator-coordination bridge keys consumed by the
    //          `context:prefixes`, `context:ontology`, `classify:schema`, etc.
    //          plugins. They are NOT part of the silo contract documented in
    //          `docs/context-silo.md`. Tasks #27/#28 will replace the bridge
    //          with first-class init record threading.
    //
    //          Until tasks #27/#28 flip the target config to flat per-plugin
    //          namespaces, the orchestrator splats `targetConfig.classification`
    //          into top-level `ctx.config.<key>` slots (the keys classifier
    //          plugins read). The classification block also carries the
    //          legacy `ontology` key, which is renamed to `ontologyClassifier`
    //          to match `OntologyClassifier`'s namespace constant.
    const seededConfig = SquashageOrchestrator.#seedConfig(
      targetConfig,
      sampleSource,
      schemasBase,
    );

    const ctxSkeleton: Record<string, unknown> = {
      target,
      outDir,
      config:  seededConfig,
      output:  outputConfig,
    };
    const ctx = ctxSkeleton as unknown as PipelineContextInterface;

    await SquashageOrchestrator.#runOnRunStartHooks(ctx, pipelineSet, target);

    // Step 5b — Proposer-count check (Amendment A2). Counts hook + per-record
    //           manifests that declare `proposesClass: true` and asserts that
    //           `classify:conflict` is registered AND listed in the pipeline
    //           when ≥2 distinct proposers participate. Mirrors the legacy
    //           `crossValidateTarget` error message format so error consumers
    //           do not break.
    SquashageOrchestrator.#assertConflictResolverPresent(targetConfig, target);

    logger.debug('run', 'Run-wide context constructed via lifecycle hooks', {
      target,
      instanceBase:   ctx.prefixes?.instances.base,
      graphBase:      ctx.prefixes?.graphs.base,
      vocabularyBase: ctx.prefixes?.vocabulary.base,
      prefixSource:   ctx.prefixes?.source,
    });

    // Step 6 — Resolve per-record task functions from the global TaskRegistry.
    //          Classifier plugins register their per-record `execute` on the
    //          global registry at module load time (via `src/classification/index.js`),
    //          so per-record lookup falls through to `TaskRegistry.get(name)`.
    const perRecordTasks = perRecordNames.map(name => TaskRegistry.get(name));

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

    // Build per-record Pipeline.
    const pipeline = Pipeline.create<PipelineStateInterface>({ name: `squashage:${target}` });
    pipeline.addTasks(perRecordTasks);

    // Resolve `enrich:entity-link` lazily (after hooks ran). When the pipeline
    // includes the task and the config is present, build a stateful instance
    // via EntityLinkTask.create(); otherwise the post-batch path no-ops.
    let entityLinkTaskFn: ((next: () => Promise<void>, state: PipelineStateInterface) => Promise<void>) | undefined;
    if (pipelineSet.has(ENTITY_LINK_NAME)) {
      const enrichment    = targetConfig.enrichment as Record<string, unknown> | undefined;
      const entityLinkCfg = enrichment?.['entityLink'] as EntityLinkConfigInterface | undefined;
      if (entityLinkCfg !== undefined) {
        const instance = EntityLinkTask.create(entityLinkCfg);
        entityLinkTaskFn = instance.execute;
        logger.info('run', 'enrich:entity-link task instantiated', { target });
      }
    }

    // Step 8b — Open streaming output before building per-record states.
    // IMPORTANT: must run BEFORE Step 8 so that the dataset proxy installed by
    // openStreamingOutput is visible to the spread in Step 8.
    if (isStreamingOutput) {
      logger.debug('run', 'Opening streaming output before per-record dispatch', { target });
      await openStreamingOutput(ctx);
      logger.info('run', 'Streaming output opened', { target, path: outputConfig.path });
    }

    // Step 8 — Build one state per record. Each state shares the run-wide ctx
    //          object identity (stable across records and matched by classifier
    //          plugins' `WeakMap<ctx, runState>` caches). The per-record locator
    //          (`recordPath`, `recordLine`) is attached to the state's own
    //          index-signature slots (state extends `Record<string, unknown>`),
    //          which `json:read` and `output:provenance` read in preference to
    //          `ctx.config` so the silo's run-wide ctx never has to be cloned.
    const states = locators.map(({ recordPath, recordLine }) => {
      const source = { target, path: recordPath };
      const state  = PipelineState.fromInput(target, source, {});

      (state as Record<string, unknown>)['recordPath'] = recordPath;
      (state as Record<string, unknown>)['recordLine'] = recordLine;
      (state as unknown as { context: PipelineContextInterface }).context = ctx;

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

    // Invoke enrich:entity-link when configured and pipelined.
    if (entityLinkTaskFn !== undefined) {
      logger.debug('enrich', 'Invoking enrich:entity-link', { target });
      await entityLinkTaskFn(async (): Promise<void> => { /* no-op next */ }, endOfRunState);
      logger.info('enrich', 'enrich:entity-link completed', { target });
    }

    logger.debug('finalize', `Invoking ${activeFinalizeTaskName}`, { target });

    await activeFinalizeTask(async (): Promise<void> => { /* no-op next */ }, endOfRunState);

    logger.info('finalize', `${activeFinalizeTaskName} completed`, { target });

    // Invoke catalog:emit (when configured) after finalize so the output report
    // is on disk and can be read by the catalog task.
    if (pipelineSet.has(CATALOG_NAME)) {
      logger.debug('catalog', 'Invoking catalog:emit', { target });
      const catalogTask = TaskRegistry.get(CATALOG_NAME);
      await catalogTask(async (): Promise<void> => { /* no-op next */ }, endOfRunState);
      logger.info('catalog', 'catalog:emit completed', { target });
    }

    // Step 10b — Fire every registered `onRunEnd` lifecycle hook with the same
    //            run-wide context. No built-in `onRunEnd` hooks ship today, so
    //            this is forward-compatible scaffolding for future plugins.
    for (const [name, fn] of TaskRegistry.onRunEndHooks()) {
      logger.debug('onRunEnd', `Invoking onRunEnd hook: ${name}`, { target });
      await fn(ctx);
    }

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
   * Builds the frozen `ctx.config` slot the lifecycle hooks read.
   *
   * @remarks
   * The returned object is the target config spread, with two additions:
   *
   * 1. `__sampleSource` and `__schemasBase` — the orchestrator-coordination
   *    bridge keys read by `context:prefixes`, `context:ontology`,
   *    `classify:schema`, etc. NOT part of the silo contract; tasks #27 / #28
   *    will replace this back-channel with first-class init record threading.
   *
   * 2. The legacy monolithic `classification: { source, structural, rules,
   *    schemas, ontology, conflict, ... }` block is splatted into top-level
   *    keys so each classifier plugin can read its per-plugin namespace
   *    directly. The `ontology` key inside that block is renamed to
   *    `ontologyClassifier` to match {@link OntologyClassifier}'s namespace
   *    constant. This compat shim exists only until tasks #27 / #28 flip the
   *    target config schema to flat per-plugin namespaces; thereafter the
   *    splat is a no-op.
   *
   * @param targetConfig - Per-target config from the squashage config file.
   * @param sampleSource - Optional `{ target, path }` derived from the first
   *                       walked record, used by `context:prefixes` for URL-host
   *                       prefix derivation.
   * @param schemasBase  - Base directory used by `context:ontology` and
   *                       `classify:schema` to resolve relative schema paths.
   * @returns Frozen config object suitable for the silo's `ctx.config` slot.
   */
  static #seedConfig(
    targetConfig: TargetConfigInterface,
    sampleSource: InputSourceInterface | undefined,
    schemasBase:  string,
  ): Readonly<Record<string, unknown>> {
    const seeded: Record<string, unknown> = {
      ...(targetConfig as unknown as Record<string, unknown>),
      __schemasBase: schemasBase,
      ...(sampleSource !== undefined ? { __sampleSource: sampleSource } : {}),
    };

    // Compat shim: bridge the legacy `classification: { ... }` block to
    // top-level per-plugin namespaces. Removed when task #28 flips the config
    // schema to flat namespaces.
    const classification = (targetConfig as unknown as Record<string, unknown>)['classification'];
    if (classification !== undefined && classification !== null && typeof classification === 'object') {
      for (const [key, value] of Object.entries(classification as Record<string, unknown>)) {
        // Rename `ontology` → `ontologyClassifier` to match
        // `OntologyClassifier.CONFIG_NAMESPACE`.
        const targetKey = key === 'ontology' ? 'ontologyClassifier' : key;
        if (seeded[targetKey] === undefined) {
          seeded[targetKey] = value;
        }
      }
    }

    return Object.freeze(seeded);
  }

  /**
   * Runs every applicable `onRunStart` lifecycle hook on the global
   * {@link TaskRegistry} in registration order, narrowing classifier hooks
   * to those whose registered name appears in `targetConfig.pipeline`.
   *
   * @remarks
   * Hooks are filtered as follows:
   *
   * - Hooks whose name has NO matching per-record task in the registry are
   *   structural lifecycle plugins (`context:logger`, `context:ajv`,
   *   `context:dataset`, `context:prefixes`, `context:ontology`,
   *   `context:run-time`). They run unconditionally.
   *
   * - Hooks whose name matches a registered per-record task are classifier
   *   plugins (`classify:source`, `classify:rules`, …). They run only when
   *   their task is listed in the target's pipeline. This preserves the
   *   existing behavior whereby a classifier whose per-record task is NOT
   *   pipelined for this run does not perform startup work (config compile,
   *   schema load, etc.).
   *
   * Hooks fail-fast: any thrown error is decorated with the hook name and
   * re-thrown so the orchestrator log carries the failing plugin's identifier.
   *
   * @param ctx         - The skeleton context (mutable view); hooks populate slots.
   * @param pipelineSet - Set of per-record task names listed in the pipeline.
   * @param target      - Target identifier (for log + error metadata).
   * @throws Re-throws hook errors with the hook name on the metadata.
   */
  static async #runOnRunStartHooks(
    ctx:         PipelineContextInterface,
    pipelineSet: ReadonlySet<string>,
    target:      string,
  ): Promise<void> {
    const hooks = TaskRegistry.onRunStartHooks();
    for (const [name, fn] of hooks) {
      const isPerRecordTask = TaskRegistry.has(name);
      if (isPerRecordTask && !pipelineSet.has(name)) {
        logger.debug('onRunStart', `Skipping hook (not in pipeline): ${name}`, { target, name });
        continue;
      }
      logger.debug('onRunStart', `Invoking hook: ${name}`, { target, name });
      try {
        await fn(ctx);
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        logger.error('onRunStart', `Hook ${name} threw`, { target, name, error: cause?.message });
        throw err;
      }
    }
  }

  /**
   * Asserts the `≥2 class-proposers ⇒ classify:conflict required` invariant.
   *
   * @remarks
   * Counts every registered manifest with `proposesClass: true` whose name is
   * also present in `targetConfig.pipeline`, and throws
   * {@link SquashageConfigError} when the count is ≥2 AND
   * `classify:conflict` is missing from the pipeline OR not registered. The
   * error message format mirrors the legacy `crossValidateTarget`
   * implementation in `src/config/SquashageConfig.ts` so error consumers do
   * not break when task #26 deletes that legacy path.
   *
   * @param targetConfig - The resolved target config (used for pipeline list).
   * @param target       - Target identifier (for error metadata).
   * @throws {SquashageConfigError} When the invariant is violated.
   */
  static #assertConflictResolverPresent(
    targetConfig: TargetConfigInterface,
    target:       string,
  ): void {
    const pipelineSet = new Set(targetConfig.pipeline);

    const proposers = TaskRegistry.manifests()
      .filter(m => m.proposesClass === true)
      .map(m => m.name)
      .filter(name => pipelineSet.has(name));
    const distinctProposers = new Set(proposers);

    if (distinctProposers.size < 2) return;

    const conflictRegistered = TaskRegistry.has('classify:conflict');
    const conflictPipelined  = pipelineSet.has('classify:conflict');
    if (conflictRegistered && conflictPipelined) return;

    throw SquashageConfigError.create(
      `Pipeline includes ${distinctProposers.size.toString()} class-proposing classifiers ` +
      `(${[...distinctProposers].join(', ')}) but is missing "classify:conflict". ` +
      `When multiple class-proposers are active, the ConflictResolver must be ` +
      `present in the pipeline to pick the winning class.`,
      { metadata: { target, distinctProposers: [...distinctProposers] } },
    );
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
