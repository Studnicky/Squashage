/**
 * SquashageRun — composition root for one target run.
 *
 * Constructor wires:
 *   1. SquashageServices (from targetConfig + RunOptions).
 *   2. SquashageDagonizer (subclass of Dagonizer with inlined PROV-O hooks).
 *   3. Plugin nodes and the per-record DAG — registered by PluginLoader from
 *      the named plugin namespace.  When no plugin is loaded, the framework's
 *      minimal `squashage:record` DAG (`json-read → squash → end`) is used.
 *   4. Run-scope DAG, loaded from authored `squashage-run.dag.jsonld` with
 *      scatter concurrency patched from `targetConfig.concurrency` at runtime.
 *   5. All other framework-owned nodes bundled via `registerBundle`.
 *
 * `.execute()` returns the dagonizer `Execution<SquashageRunState>` — both
 * async-iterable (for streaming consumers) and awaitable (for file mode).
 */

import { readFileSync }  from 'node:fs';
import { join }          from 'node:path';
import type { OutputConfigInterface }          from './config/OutputConfig.js';
import { FormatResolver }                      from './output/FormatResolver.js';
import type { SquashageRunConfigInterface }    from './config/SquashageConfig.js';
import { DAGDocument }                         from '@studnicky/dagonizer';
import type { ChildStateFactoryType, DAGType, NodeStateInterface } from '@studnicky/dagonizer';

import { WorkerThreadContainer }               from '@studnicky/dagonizer-executor-node';
import type { JsonObjectType }                from '@studnicky/dagonizer/entities';
import { SquashageDagonizer }                  from './dispatcher/SquashageDagonizer.js';
import { SquashageServices }                   from './services/SquashageServices.js';
import type { SquashageServicesOptionsInterface } from './services/SquashageServices.js';
import { jsonReadNode }                        from './nodes/record/jsonRead.js';
import { sourceClassifierNode }                from './nodes/record/classifiers/SourceClassifierNode.js';
import { recordHealthGateNode }                from './nodes/record/recordHealthGate.js';
import { recordQuarantineNode }                from './nodes/record/recordQuarantine.js';
import { outputProvenanceNode }                from './nodes/record/outputProvenance.js';
import { shapeObserveNode }                    from './nodes/record/shapeObserve.js';
import { walkInputNode }                       from './nodes/run/walkInput.js';
import { indexEntitiesNode }                   from './nodes/run/indexEntities.js';
import { enrichEntityLinkNode }                from './nodes/run/enrichEntityLink.js';
import { ontologyEmitNode }                    from './nodes/run/ontologyEmit.js';
import { rdfjsFinalizeNode }                   from './nodes/run/rdfjsFinalize.js';
import { catalogEmitNode }                     from './nodes/run/catalogEmit.js';
import { mergeShapeCacheNode }                 from './nodes/run/mergeShapeCache.js';
import { induceSchemasNode }                   from './nodes/run/induceSchemas.js';
import { writeDraftsNode }                     from './nodes/run/writeDrafts.js';
import { walkDraftsNode }                      from './nodes/run/walkDrafts.js';
import { refineSyncTalliesNode }               from './nodes/run/refineSyncTallies.js';
import { refineRequiredGateNode }              from './nodes/run/refineRequiredGate.js';
import { buildReadyGateNode }                  from './nodes/run/buildReadyGate.js';
import { readDraftNode }                       from './nodes/refine/readDraft.js';
import { readRefinementNode }                  from './nodes/refine/readRefinement.js';
import { applyRefinementNode }                 from './nodes/refine/applyRefinement.js';
import { refinementMissingWarnNode }           from './nodes/refine/refinementMissingWarn.js';
import { writeFinalNode }                      from './nodes/refine/writeFinal.js';
import { defaultSquashNode } from './nodes/record/squashNode.js';
import type { SquashNodeInterface }            from './nodes/record/squashNode.js';
import { bootstrapEndNode }                    from './dag/bootstrapDag.js';
import { refineInitNode }                      from './dag/refineInitNode.js';
import { refineSummaryCollectNode }            from './dag/refineSummaryCollectNode.js';
import { SquashageRecordState }                from './state/SquashageRecordState.js';
import { SquashageRunState }                   from './state/SquashageRunState.js';
import { SquashageInduceRunState }             from './state/SquashageInduceRunState.js';
import { SquashageRefineRunState }             from './state/SquashageRefineRunState.js';
import { SquashageRefineState }                from './state/SquashageRefineState.js';
import { SquashageBootstrapState }             from './state/SquashageBootstrapState.js';
import type { DispatcherBundleType }           from '@studnicky/dagonizer';
import { PluginLoader }                        from './run/PluginLoader.js';
import './core/RecordFoldGather.js';

// ─── Run options ──────────────────────────────────────────────────────────────

export interface SquashageRunOptionsInterface {
  /** Optional run identifier — defaults to `targetConfig.name ?? 'run'` when absent. */
  readonly target?:          string | undefined;
  readonly targetConfig:     SquashageRunConfigInterface;
  readonly output:           OutputConfigInterface;
  readonly outDir:           string;
  readonly schemasBase:      string;
  /** Optional squash node — defaults to `defaultSquashNode`. */
  readonly squashNode?:      SquashNodeInterface;
  /**
   * Absolute path to the top-level plugins/ directory.
   * Defaults to `join(import.meta.dirname, '..', 'plugins')`.
   */
  readonly pluginsDir?:      string | undefined;
  /**
   * Plugin namespace to load (the subdirectory name under plugins/).
   * When absent, no plugin is loaded and the framework's minimal
   * `squashage:record` DAG is used.
   */
  readonly pluginNamespace?: string | undefined;
  /**
   * Number of worker threads to use for the scatter body.
   *
   * When set and `output.mode` is `'dataset'`, a `WorkerThreadContainer` is
   * registered under the `'worker'` role and the scatter node routes each
   * `squashage:record` sub-DAG execution to a worker thread.
   *
   * Incompatible with `output.mode === 'stream'` (workers cannot write to
   * the main-process file stream). When streaming mode is detected, a warning
   * is logged and the option is silently ignored.
   */
  readonly workers?: number | undefined;
}

const RUN_DAG_NAME       = 'squashage:run';
const INDUCE_DAG_NAME    = 'squashage:induce';
const REFINE_DAG_NAME    = 'squashage:refine';
const BOOTSTRAP_DAG_NAME = 'squashage:bootstrap';

export class SquashageRun {
  readonly services:   SquashageServices;
  readonly dispatcher: SquashageDagonizer<NodeStateInterface>;

  private constructor(slots: {
    services:   SquashageServices;
    dispatcher: SquashageDagonizer<NodeStateInterface>;
  }) {
    this.services   = slots.services;
    this.dispatcher = slots.dispatcher;
  }

  static async forRun(options: SquashageRunOptionsInterface): Promise<SquashageRun> {
    const runStartTime = new Date().toISOString();
    const target = options.target ?? options.targetConfig.name ?? 'run';

    const servicesOpts: SquashageServicesOptionsInterface = {
      target,
      targetConfig: options.targetConfig,
      output:       options.output,
      outDir:       options.outDir,
      schemasBase:  options.schemasBase,
      sampleSource: undefined,
      runStartTime,
    };
    const services = await SquashageServices.forTarget(servicesOpts);

    // In stream mode, open the PROV sidecar sink eagerly so SquashageDagonizer
    // can write PROV quads synchronously to the stream rather than accumulating
    // them in the dataset.
    if (options.output.mode === 'stream') {
      try {
        const resolvedFormat = FormatResolver.resolve(options.output);
        if (options.output.path.length > 0) {
          await services.openProvSink(options.output.path, resolvedFormat);
        }
      } catch {
        // Format not streamable (e.g. jsonld) or path unresolvable — fall back
        // to dataset mode for prov quads (provSink remains null).
      }
    }

    // ── Worker container wiring ──────────────────────────────────────────────
    // Workers require dataset mode: the scatter body runs in a thread that
    // cannot write to the main-process file stream. If stream mode is active,
    // log a warning and fall back to in-process execution.
    let workerContainer: WorkerThreadContainer | undefined;
    if (options.workers !== undefined && options.workers > 0) {
      if (options.output.mode === 'stream') {
        const log = services.logger.forComponent('SquashageRun');
        log.warn('forRun', 'WorkerThreadContainer requires dataset mode; ignoring --workers (output.mode is "stream")', { workers: options.workers });
      } else {
        const registryUrl = new URL('../../plugins/aonprd/registry.js', import.meta.url).href;
        workerContainer = new WorkerThreadContainer({
          registryModule:  registryUrl,
          registryVersion: '0.7.1',
          servicesConfig: {
            targetConfig:  options.targetConfig as unknown as JsonObjectType,
            target,
            schemasBase:   options.schemasBase,
            outDir:        options.outDir,
            runStartTime,
          },
          poolSize: options.workers,
        });
      }
    }

    const dispatcher = new SquashageDagonizer<NodeStateInterface>({
      services,
      ...(workerContainer !== undefined ? { containers: { worker: workerContainer } } : {}),
    });

    // ── 1. Plugin loading — nodes registered now; DAGs deferred until after bundle. ─
    // PluginLoader imports plugins/<ns>/index.js, calls register(dispatcher)
    // (which adds classifier nodes), and returns the plugin's DAGs sorted in
    // registration order.  DAGs are registered AFTER registerBundle so that all
    // framework nodes the plugin DAGs reference are already present.
    // Resolve plugins/ relative to this module file. new URL() with import.meta.url
    // is always defined in ESM and resolves correctly in both tsx (source) and
    // compiled dist/ contexts — unlike import.meta.dirname which was added in Node 21.2.
    const pluginsDir = options.pluginsDir
      ?? new URL('../plugins', import.meta.url).pathname;
    const pluginNs   = options.pluginNamespace;
    let pluginDags: ReadonlyArray<DAGType> | null = null;
    if (pluginNs !== undefined) {
      pluginDags = await PluginLoader.registerPluginsFromEntry(dispatcher, pluginsDir, pluginNs);
    }
    const pluginDagNames = new Set(pluginDags?.map((d) => d.name) ?? []);

    // ── 2. Squash node selection ─────────────────────────────────────────────
    // Priority: explicit option → plugin-registered → defaultSquashNode.
    // Plugins provide their own squash node via their register() call
    // (e.g. new OntologyProjectionNode(ontology)). When a plugin registers
    // 'squash', `squashNodeForBundle` is null and the bundle skips it —
    // the already-registered node is used by the DAG engine directly.
    let squashNodeForBundle: SquashNodeInterface | null;
    if (options.squashNode !== undefined) {
      squashNodeForBundle = options.squashNode;
    } else if (dispatcher.getNode('squash') !== undefined) {
      // Plugin already registered a squash node — don't add to bundle.
      squashNodeForBundle = null;
    } else {
      const log = services.logger.forComponent('SquashageRun');
      log.warn('forRun', `run "${target}" has no squash node configured; falling back to rdf:type-only defaultSquashNode`, { target });
      squashNodeForBundle = defaultSquashNode;
    }

    // ── 3. State factories for child DAGs: produce the correct state class ───
    //       rather than cloning the parent (which has a different shape).
    //
    // The scatter sets currentLocator on the child state AFTER the factory runs
    // (via itemKey). json-read reads currentLocator from child metadata at
    // execution time to seed recordPath/recordLine.
    const recordStateFactory: ChildStateFactoryType = (_parent) =>
      new SquashageRecordState(
        { target, path: '' },
        '',
        0,
      );

    const refineStateFactory: ChildStateFactoryType = (_parent) =>
      new SquashageRefineState('', '', null, undefined);

    // ── 4. Load authored DAGs from src/dag/ (dev) or dist/dag/ (prod). ───────
    // `import.meta.dirname` resolves to the directory of this compiled module.
    const dagDir = join(import.meta.dirname, 'dag');
    const recordInduceDag = DAGDocument.load(readFileSync(join(dagDir, 'squashage-record-induce.dag.jsonld'), 'utf-8'));
    const induceDag       = DAGDocument.load(readFileSync(join(dagDir, 'squashage-induce.dag.jsonld'),        'utf-8'));
    const refineDag       = DAGDocument.load(readFileSync(join(dagDir, 'squashage-refine.dag.jsonld'),        'utf-8'));
    const refineOneDag    = DAGDocument.load(readFileSync(join(dagDir, 'squashage-refine-one.dag.jsonld'),    'utf-8'));
    const bootstrapDag    = DAGDocument.load(readFileSync(join(dagDir, 'squashage-bootstrap.dag.jsonld'),     'utf-8'));

    // Load framework DAGs but skip any whose name the plugin already provides.
    const recordDag = pluginDagNames.has('squashage:record')
      ? null
      : DAGDocument.load(readFileSync(join(dagDir, 'squashage-record.dag.jsonld'), 'utf-8'));
    const recordInduceDagOrNull = pluginDagNames.has('squashage:record-induce')
      ? null
      : recordInduceDag;

    // ── 5. Load squashage-run.dag.jsonld, then patch scatter concurrency. ────
    // DAGType is fully readonly, so we parse the JSON to a plain object, mutate
    // the scatter node's concurrency field, then validate via DAGDocument.ofValue.
    const concurrency = services.targetConfig.concurrency ?? 1;
    const runDagRaw = JSON.parse(
      readFileSync(join(dagDir, 'squashage-run.dag.jsonld'), 'utf-8'),
    ) as Record<string, unknown>;

    {
      const nodes = runDagRaw['nodes'] as Array<Record<string, unknown>> | undefined;
      if (nodes !== undefined) {
        const scatterNode = nodes.find((n) => n['name'] === 'process-all-records');
        if (scatterNode !== undefined) {
          if (concurrency !== 1) {
            scatterNode['concurrency'] = concurrency;
          }
          // Patch container role onto scatter body when workers are wired in.
          // Only applied when a WorkerThreadContainer was actually constructed
          // above; dagonizer throws at registerDAG time if a container role is
          // declared but no container is registered for that role.
          if (workerContainer !== undefined) {
            scatterNode['container'] = 'worker';
          }
        }
      }
    }
    const runDag = DAGDocument.ofValue(runDagRaw);

    // ── 6. Register all framework nodes and DAGs in one bundle call. ──────────
    // Classifier nodes are intentionally absent here — the plugin's register()
    // call already added them. Only framework-owned nodes appear in this bundle.
    // squashNodeForBundle is null when the plugin already registered 'squash'.
    const bundle: DispatcherBundleType<NodeStateInterface, SquashageServices> = {
      nodes: [
        // record-scope framework builtins
        jsonReadNode,
        sourceClassifierNode,
        recordHealthGateNode,
        recordQuarantineNode,
        outputProvenanceNode,
        ...(squashNodeForBundle !== null ? [squashNodeForBundle] : []),
        // record induce-scope
        shapeObserveNode,
        // run-scope
        walkInputNode,
        indexEntitiesNode,
        enrichEntityLinkNode,
        ontologyEmitNode,
        rdfjsFinalizeNode,
        catalogEmitNode,
        // induce-scope (run-level)
        mergeShapeCacheNode,
        induceSchemasNode,
        writeDraftsNode,
        // refine-scope
        walkDraftsNode,
        refineSyncTalliesNode,
        readDraftNode,
        readRefinementNode,
        applyRefinementNode,
        refinementMissingWarnNode,
        writeFinalNode,
        // bootstrap gate nodes
        refineRequiredGateNode,
        buildReadyGateNode,
        bootstrapEndNode,
        // scatter phase nodes
        refineInitNode,
        refineSummaryCollectNode,
      ],
      dags: [
        // Only register DAGs that have no inter-DAG dependencies on plugin-provided DAGs.
        // refineOneDag: no record DAG references.
        refineOneDag,
        // All other DAGs are registered after plugin DAGs (see step 7 below).
      ],
      stateFactories: {
        'squashage:record':        recordStateFactory,
        'squashage:record-induce': recordStateFactory,
        'squashage:refine-one':    refineStateFactory,
      },
    };
    dispatcher.registerBundle(bundle);

    // ── 7. Register DAGs that depend on plugin-provided DAGs (squashage:record,
    //       squashage:record-induce), in dependency order:
    //
    //   (a) Plugin DAGs first — they provide squashage:record and squashage:record-induce.
    //       Each DAG that matches a stateFactories key from the bundle receives the
    //       correct isolation factory; others default to cloneParent.
    //   (b) Framework DAGs that may have been excluded from the bundle because the
    //       plugin provides them (record, record-induce).
    //   (c) Orchestration DAGs that scatter/embed into (a)+(b): run, induce, refine, bootstrap.
    //
    const stateFactoryForDag = (dagName: string): typeof recordStateFactory | typeof refineStateFactory | undefined => {
      if (dagName === 'squashage:record' || dagName === 'squashage:record-induce') {
        return recordStateFactory;
      }
      if (dagName === 'squashage:refine-one') return refineStateFactory;
      return undefined;
    };

    if (pluginDags !== null) {
      for (const dag of pluginDags) {
        dispatcher.registerDAG(dag, stateFactoryForDag(dag.name));
      }
    }

    // Framework record/record-induce DAGs if not overridden by plugin.
    if (recordDag !== null) dispatcher.registerDAG(recordDag, recordStateFactory);
    if (recordInduceDagOrNull !== null) dispatcher.registerDAG(recordInduceDagOrNull, recordStateFactory);

    // Orchestration DAGs: squashage:run scatters into squashage:record,
    // squashage:induce scatters into squashage:record-induce,
    // squashage:bootstrap embeds squashage:run and squashage:induce.
    dispatcher.registerDAG(runDag);
    dispatcher.registerDAG(induceDag);
    dispatcher.registerDAG(refineDag);
    dispatcher.registerDAG(bootstrapDag);

    return new SquashageRun({ services, dispatcher });
  }

  /** Returns the dagonizer Execution for the run-scope DAG. */
  execute(initialState?: SquashageRunState): ReturnType<SquashageDagonizer<NodeStateInterface>['execute']> {
    const state = initialState ?? new SquashageRunState(this.services.target, this.services.runStartTime);
    return this.dispatcher.execute(RUN_DAG_NAME, state);
  }

  /** Returns the dagonizer Execution for the induce-scope DAG. */
  executeInduce(initialState?: SquashageInduceRunState): ReturnType<SquashageDagonizer<NodeStateInterface>['execute']> {
    const state = initialState ?? new SquashageInduceRunState(this.services.target, this.services.runStartTime);
    return this.dispatcher.execute(INDUCE_DAG_NAME, state);
  }

  /** Returns the dagonizer Execution for the refine-scope DAG. */
  executeRefine(initialState?: SquashageRefineRunState): ReturnType<SquashageDagonizer<NodeStateInterface>['execute']> {
    const state = initialState ?? new SquashageRefineRunState(this.services.target, this.services.runStartTime);
    return this.dispatcher.execute(REFINE_DAG_NAME, state);
  }

  /**
   * Returns the dagonizer Execution for the bootstrap-scope DAG.
   *
   * After execution completes, populates the convenience summary fields
   * (`induceResult`, `refineResult`) from the flat fields that the embedded-DAG
   * outputs mapping lifted back from child states.
   */
  async executeBootstrap(initialState?: SquashageBootstrapState): Promise<{ state: SquashageBootstrapState }> {
    const state = initialState ?? new SquashageBootstrapState(this.services.target, this.services.runStartTime);
    await this.dispatcher.execute(BOOTSTRAP_DAG_NAME, state);

    const bootstrapState = state as SquashageBootstrapState;

    // Populate induceResult if the induce phase ran.
    if (bootstrapState.draftsWritten > 0 || bootstrapState.discoveredClasses.length > 0) {
      bootstrapState.induceResult = {
        discoveredClasses: bootstrapState.discoveredClasses,
        draftsWritten:     bootstrapState.draftsWritten,
      };
    }

    // Populate refineResult if the refine phase ran.
    if (bootstrapState.refinedCount > 0 || bootstrapState.passthroughCount > 0) {
      bootstrapState.refineResult = {
        refinedCount:     bootstrapState.refinedCount,
        passthroughCount: bootstrapState.passthroughCount,
      };
    }

    // Populate results from the bounded fold gather.
    // RecordFoldGather wrote squashedCount/quarantinedCount/sampleSummaries into
    // bootstrapState during the build scatter (the bootstrap state IS the run-scope
    // state during the build scatter — clones fold back into it).
    if (bootstrapState.squashedCount > 0 || bootstrapState.quarantinedCount > 0) {
      bootstrapState.results = [...bootstrapState.sampleSummaries];
    }

    return { state: bootstrapState };
  }

  /** Convenience constructor alias (tests and smoke paths). */
  static async forTargetWithNullObserver(options: SquashageRunOptionsInterface): Promise<SquashageRun> {
    return SquashageRun.forRun(options);
  }
}
