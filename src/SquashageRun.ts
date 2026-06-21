/**
 * SquashageRun — composition root for one target run.
 *
 * Constructor wires:
 *   1. SquashageServices (from targetConfig + RunOptions).
 *   2. SquashageDagonizer (subclass of Dagonizer with inlined PROV-O hooks).
 *   3. ClassifyConflictNode, optional classifier classes, and the per-target
 *      squash node — instantiated from their config slices.
 *   4. Run-scope DAG, registered under name 'squashage:run'.
 *   5. Per-record deep-DAG (`recordDag`), registered under name
 *      'squashage:record'.
 *
 * `.execute()` returns the dagonizer `Execution<SquashageRunState>` — both
 * async-iterable (for streaming consumers) and awaitable (for file mode).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OutputConfigInterface } from './config/OutputConfig.js';
import { FormatResolver } from './output/FormatResolver.js';
import type { TargetConfigInterface } from './config/SquashageConfig.js';
import { DAGDocument } from '@studnicky/dagonizer';
import type { ChildStateFactoryType } from '@studnicky/dagonizer';

import { SquashageDagonizer } from './dispatcher/SquashageDagonizer.js';
import { SquashageServices } from './services/SquashageServices.js';
import type { SquashageServicesOptionsInterface } from './services/SquashageServices.js';
import { ClassifyConflictNode } from './nodes/record/classifyConflict.js';
import type { ClassifyConflictConfigInterface } from './nodes/record/classifyConflict.js';
import { OntologyClassifierNode } from './nodes/record/classifiers/OntologyClassifierNode.js';
import type { OntologyClassifierConfigInterface } from './nodes/record/classifiers/OntologyClassifierNode.js';
import { PropertyFingerprintClassifierNode } from './nodes/record/classifiers/PropertyFingerprintClassifierNode.js';
import type { PropertyFingerprintConfigInterface } from './nodes/record/classifiers/PropertyFingerprintClassifierNode.js';
import { RulesClassifierNode } from './nodes/record/classifiers/RulesClassifierNode.js';
import type { RawRulesEntryInterface } from './nodes/record/classifiers/RulesClassifierNode.js';
import { SchemaClassifierNode } from './nodes/record/classifiers/SchemaClassifierNode.js';
import type { RawSchemaEntryInterface } from './nodes/record/classifiers/SchemaClassifierNode.js';
import { ShaclShapeClassifierNode } from './nodes/record/classifiers/ShaclShapeClassifierNode.js';
import type { ShaclShapeClassifierConfigInterface } from './nodes/record/classifiers/ShaclShapeClassifierNode.js';
import { StructuralClassifierNode } from './nodes/record/classifiers/StructuralClassifierNode.js';
import type { RawStructuralRuleInterface } from './nodes/record/classifiers/StructuralClassifierNode.js';
import { TaxonomicNarrowingClassifierNode } from './nodes/record/classifiers/TaxonomicNarrowingClassifierNode.js';
import type { TaxonomicNarrowingConfigInterface } from './nodes/record/classifiers/TaxonomicNarrowingClassifierNode.js';
import { UrlPatternClassifierNode } from './nodes/record/classifiers/UrlPatternClassifierNode.js';
import type { UrlPatternConfigInterface } from './nodes/record/classifiers/UrlPatternClassifierNode.js';
import { WinknlpEntitiesClassifierNode } from './nodes/record/classifiers/WinknlpEntitiesClassifierNode.js';
import type { WinknlpEntitiesConfigInterface } from './nodes/record/classifiers/WinknlpEntitiesClassifierNode.js';
import { DiscriminatorClassifierNode } from './nodes/record/classifiers/DiscriminatorClassifierNode.js';
import type { DiscriminatorClassifierConfigInterface } from './nodes/record/classifiers/DiscriminatorClassifierNode.js';
import { NoOpClassifierNode } from './nodes/record/classifiers/NoOpClassifierNode.js';
import { jsonReadNode } from './nodes/record/jsonRead.js';
import { sourceClassifierNode } from './nodes/record/classifiers/SourceClassifierNode.js';
import { recordHealthGateNode } from './nodes/record/recordHealthGate.js';
import { recordQuarantineNode } from './nodes/record/recordQuarantine.js';
import { outputProvenanceNode } from './nodes/record/outputProvenance.js';
import { shapeObserveNode } from './nodes/record/shapeObserve.js';
import { walkInputNode } from './nodes/run/walkInput.js';
import { enrichEntityLinkNode } from './nodes/run/enrichEntityLink.js';
import { ontologyEmitNode } from './nodes/run/ontologyEmit.js';
import { rdfjsFinalizeNode } from './nodes/run/rdfjsFinalize.js';
import { catalogEmitNode } from './nodes/run/catalogEmit.js';
import { mergeShapeCacheNode } from './nodes/run/mergeShapeCache.js';
import { induceSchemasNode } from './nodes/run/induceSchemas.js';
import { writeDraftsNode } from './nodes/run/writeDrafts.js';
import { walkDraftsNode } from './nodes/run/walkDrafts.js';
import { refineSyncTalliesNode } from './nodes/run/refineSyncTallies.js';
import { refineRequiredGateNode } from './nodes/run/refineRequiredGate.js';
import { buildReadyGateNode } from './nodes/run/buildReadyGate.js';
import { readDraftNode } from './nodes/refine/readDraft.js';
import { readRefinementNode } from './nodes/refine/readRefinement.js';
import { applyRefinementNode } from './nodes/refine/applyRefinement.js';
import { refinementMissingWarnNode } from './nodes/refine/refinementMissingWarn.js';
import { writeFinalNode } from './nodes/refine/writeFinal.js';
import { defaultSquashNode, ontologyProjectionNode } from './nodes/record/squashNode.js';
import type { SquashNodeInterface } from './nodes/record/squashNode.js';
import { RunDag } from './dag/runDag.js';
import { bootstrapEndNode } from './dag/bootstrapDag.js';
import { recordInitNode } from './dag/recordInitNode.js';
import './core/RecordFoldGather.js';
import { refineInitNode } from './dag/refineInitNode.js';
import { refineSummaryCollectNode } from './dag/refineSummaryCollectNode.js';
import { SquashageRecordState } from './state/SquashageRecordState.js';
import { SquashageRunState } from './state/SquashageRunState.js';
import { SquashageInduceRunState } from './state/SquashageInduceRunState.js';
import { SquashageRefineRunState } from './state/SquashageRefineRunState.js';
import { SquashageRefineState } from './state/SquashageRefineState.js';
import { SquashageBootstrapState } from './state/SquashageBootstrapState.js';
import type { DispatcherBundleType, NodeStateInterface } from '@studnicky/dagonizer';

export interface SquashageRunOptionsInterface {
  readonly target:       string;
  readonly targetConfig: TargetConfigInterface;
  readonly output:       OutputConfigInterface;
  readonly outDir:       string;
  readonly schemasBase:  string;
  /** Optional squash node — defaults to `defaultSquashNode`. */
  readonly squashNode?:  SquashNodeInterface;
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

  static async forTarget(options: SquashageRunOptionsInterface): Promise<SquashageRun> {
    const runStartTime = new Date().toISOString();

    const servicesOpts: SquashageServicesOptionsInterface = {
      target:       options.target,
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

    const dispatcher = new SquashageDagonizer<NodeStateInterface>({ services });

    // Build per-record node instances from config slices.
    const classification = (options.targetConfig.classification ?? {}) as Record<string, unknown>;

    const conflictConfig = (classification['conflict'] ?? {
      onConflict: 'quarantine', evidence: true,
    }) as ClassifyConflictConfigInterface;
    const classifyConflict = new ClassifyConflictNode(conflictConfig);

    const urlPatternBlock = classification['urlPattern'] as UrlPatternConfigInterface | undefined;
    const urlPatternClassifier = urlPatternBlock !== undefined
      ? new UrlPatternClassifierNode(urlPatternBlock)
      : null;

    const structuralRules = classification['structural'] as ReadonlyArray<RawStructuralRuleInterface> | undefined;
    const structuralClassifier = structuralRules !== undefined
      ? new StructuralClassifierNode(structuralRules)
      : null;

    const rulesEntries = classification['rules'] as ReadonlyArray<RawRulesEntryInterface> | undefined;
    const rulesClassifier = rulesEntries !== undefined
      ? new RulesClassifierNode(rulesEntries)
      : null;

    const schemaEntries = classification['schemas'] as ReadonlyArray<RawSchemaEntryInterface> | undefined;
    const schemaClassifier = schemaEntries !== undefined
      ? new SchemaClassifierNode(schemaEntries, services.ajv, options.schemasBase)
      : null;

    const shaclShapeBlock = classification['shaclShape'] as ShaclShapeClassifierConfigInterface | undefined;
    const shaclShapeClassifier = shaclShapeBlock !== undefined
      ? await ShaclShapeClassifierNode.forConfig(shaclShapeBlock, options.schemasBase)
      : null;

    const propertyFingerprintBlock = classification['propertyFingerprint'] as PropertyFingerprintConfigInterface | undefined;
    const propertyFingerprintClassifier = propertyFingerprintBlock !== undefined
      ? new PropertyFingerprintClassifierNode(propertyFingerprintBlock, options.schemasBase)
      : null;

    const winknlpEntitiesBlock = classification['winknlpEntities'] as WinknlpEntitiesConfigInterface | undefined;
    const winknlpEntitiesClassifier = winknlpEntitiesBlock !== undefined
      ? new WinknlpEntitiesClassifierNode(winknlpEntitiesBlock)
      : null;

    const ontologyClassifierBlock = classification['ontologyClassifier'] as OntologyClassifierConfigInterface | undefined;
    const ontologyClassifier = ontologyClassifierBlock !== undefined
      ? new OntologyClassifierNode(ontologyClassifierBlock)
      : null;

    const taxonomicNarrowingBlock = classification['taxonomicNarrowing'] as TaxonomicNarrowingConfigInterface | undefined;
    const taxonomicNarrowingClassifier = taxonomicNarrowingBlock !== undefined
      ? await TaxonomicNarrowingClassifierNode.forConfig(taxonomicNarrowingBlock, options.schemasBase, services.ontology)
      : null;

    const discriminatorBlock = classification['discriminator'] as DiscriminatorClassifierConfigInterface | undefined;
    const discriminatorClassifier = discriminatorBlock !== undefined
      ? new DiscriminatorClassifierNode(discriminatorBlock)
      : null;

    let squashNode: SquashNodeInterface;
    if (options.squashNode !== undefined) {
      squashNode = options.squashNode;
    } else if (services.ontology !== null) {
      squashNode = ontologyProjectionNode;
    } else {
      const log = services.logger.forComponent('SquashageRun');
      log.warn('forTarget', `target "${options.target}" has no ontology engine configured; falling back to rdf:type-only defaultSquashNode`, { target: options.target });
      squashNode = defaultSquashNode;
    }

    // ── 1. State factories for child DAGs: produce the correct state class rather ─
    //       than cloning the parent (which has a different shape).
    const recordStateFactory: ChildStateFactoryType = (_parent) =>
      new SquashageRecordState(
        { target: options.target, path: '' },
        '',
        0,
      );

    const refineStateFactory: ChildStateFactoryType = (_parent) =>
      new SquashageRefineState('', '', null, undefined);

    // ── 2. Load child DAGs from authored documents (src/dag/ in dev, dist/dag/ in prod). ─
    // `import.meta.dirname` resolves to the directory of this compiled module:
    //   dev  → src/     → join(..., 'dag') = src/dag/
    //   prod → dist/    → join(..., 'dag') = dist/dag/  (populated by build:assets)
    const dagDir = join(import.meta.dirname, 'dag');
    const recordDag       = DAGDocument.load(readFileSync(join(dagDir, 'squashage-record.dag.jsonld'),        'utf-8'));
    const recordInduceDag = DAGDocument.load(readFileSync(join(dagDir, 'squashage-record-induce.dag.jsonld'), 'utf-8'));
    const induceDag       = DAGDocument.load(readFileSync(join(dagDir, 'squashage-induce.dag.jsonld'),        'utf-8'));
    const refineDag       = DAGDocument.load(readFileSync(join(dagDir, 'squashage-refine.dag.jsonld'),        'utf-8'));
    const refineOneDag    = DAGDocument.load(readFileSync(join(dagDir, 'squashage-refine-one.dag.jsonld'),    'utf-8'));
    const bootstrapDag    = DAGDocument.load(readFileSync(join(dagDir, 'squashage-bootstrap.dag.jsonld'),     'utf-8'));

    // ── 3. Build the run-scope DAG with runtime concurrency from target config. ─
    const runDag = RunDag.build(services.targetConfig.concurrency ?? 1);

    // ── 4. Register all nodes and DAGs in one bundle call. ───────────────────────
    // Nodes register first (engine contract); DAGs register in child-before-parent
    // order so orchestration DAGs' scatter references resolve. Optional classifiers
    // fall back to a NoOpClassifierNode — preserving the prior registerOrNoOp behavior.
    const bundle: DispatcherBundleType<NodeStateInterface, SquashageServices> = {
      nodes: [
        // record-scope (shared by squashage:record and squashage:record-induce)
        jsonReadNode,
        sourceClassifierNode,
        recordHealthGateNode,
        recordQuarantineNode,
        outputProvenanceNode,
        classifyConflict,
        // optional classifiers — fall back to a NoOp when not configured (preserves registerOrNoOp behavior)
        urlPatternClassifier          ?? new NoOpClassifierNode('classify:url-pattern',          ['proposed', 'no-match']),
        structuralClassifier          ?? new NoOpClassifierNode('classify:structural',           ['proposed', 'no-match']),
        rulesClassifier               ?? new NoOpClassifierNode('classify:rules',                ['proposed', 'no-match']),
        schemaClassifier              ?? new NoOpClassifierNode('classify:schema',               ['proposed', 'no-match']),
        shaclShapeClassifier          ?? new NoOpClassifierNode('classify:shacl-shape',          ['proposed', 'no-match']),
        propertyFingerprintClassifier ?? new NoOpClassifierNode('classify:property-fingerprint', ['proposed', 'no-match']),
        winknlpEntitiesClassifier     ?? new NoOpClassifierNode('classify:winknlp-entities',     ['proposed', 'no-match']),
        ontologyClassifier            ?? new NoOpClassifierNode('classify:ontology',             ['validated', 'no-match']),
        taxonomicNarrowingClassifier  ?? new NoOpClassifierNode('classify:taxonomic-narrowing',  ['narrowed', 'no-op']),
        discriminatorClassifier       ?? new NoOpClassifierNode('classify:discriminator',        ['proposed', 'no-match']),
        squashNode,
        // record induce-scope
        shapeObserveNode,
        // run-scope
        walkInputNode,
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
        recordInitNode,
        refineInitNode,
        refineSummaryCollectNode,
      ],
      dags: [
        // children before orchestrations that scatter/embed into them
        recordDag,
        recordInduceDag,
        refineOneDag,
        runDag,
        induceDag,
        refineDag,
        bootstrapDag,
      ],
      stateFactories: {
        'squashage:record':        recordStateFactory,
        'squashage:record-induce': recordStateFactory,
        'squashage:refine-one':    refineStateFactory,
      },
    };
    dispatcher.registerBundle(bundle);

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
    return SquashageRun.forTarget(options);
  }
}
