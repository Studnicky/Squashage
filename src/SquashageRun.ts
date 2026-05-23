/**
 * SquashageRun — composition root for one target run.
 *
 * Constructor wires:
 *   1. SquashageServices (from targetConfig + RunOptions).
 *   2. ProvObserver (writes PROV-O into the dataset's PROV graph).
 *   3. SquashageDagonizer (subclass of Dagonizer that forwards lifecycle
 *      hooks to the observer).
 *   4. ClassifyConflictNode, optional classifier classes, and the per-target
 *      squash node — instantiated from their config slices.
 *   5. Per-item dispatch nodes — `record-dispatch`, `record-dispatch-induce`,
 *      and `draft-dispatch` — registered as named nodes so that the native
 *      dagonizer fan-out placements can invoke them per item.
 *   6. Run-scope DAG, registered under name 'squashage:run'.
 *   7. Per-record deep-DAG (`recordDag`), registered under name
 *      'squashage:record'.
 *
 * `.execute()` returns the dagonizer `Execution<SquashageRunState>` — both
 * async-iterable (for streaming consumers) and awaitable (for file mode).
 */

import type { OutputConfigInterface } from './config/OutputConfig.js';
import type { TargetConfigInterface } from './config/SquashageConfig.js';
import { DAGBuilder } from '@noocodex/dagonizer/builder';
import type { NodeInterface } from '@noocodex/dagonizer';

import { SquashageDagonizer } from './dispatcher/SquashageDagonizer.js';
import { ProvObserver } from './observer/ProvObserver.js';
import { NullObserver } from './observer/NullObserver.js';
import type { ProvObserverInterface } from './observer/ProvObserverInterface.js';
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
import { defaultSquashNode, ontologyProjectionNode } from './nodes/record/squashNode.js';
import type { SquashNodeInterface } from './nodes/record/squashNode.js';
import { createRecordDispatchNode } from './nodes/run/recordDispatch.js';
import { createDraftDispatchNode } from './nodes/run/draftDispatch.js';
import { recordDag } from './dag/recordDag.js';
import { recordInduceDag } from './dag/recordInduceDag.js';
import { induceDag } from './dag/induceDag.js';
import { refineDag } from './dag/refineDag.js';
import { refineOneDag } from './dag/refineOneDag.js';
import { bootstrapDag } from './dag/bootstrapDag.js';
import { registerRecordNodes } from './dag/registerRecordNodes.js';
import { registerRunNodes } from './dag/registerRunNodes.js';
import { registerInduceNodes } from './dag/registerInduceNodes.js';
import { registerRefineNodes } from './dag/registerRefineNodes.js';
import { registerBootstrapNodes } from './dag/registerBootstrapNodes.js';
import type { SquashageRecordState } from './state/SquashageRecordState.js';
import { SquashageRunState } from './state/SquashageRunState.js';
import { SquashageInduceRunState } from './state/SquashageInduceRunState.js';
import { SquashageRefineRunState } from './state/SquashageRefineRunState.js';
import { SquashageBootstrapState } from './state/SquashageBootstrapState.js';
import type { NodeStateInterface } from '@noocodex/dagonizer';

export interface SquashageRunOptionsInterface {
  readonly target:       string;
  readonly targetConfig: TargetConfigInterface;
  readonly output:       OutputConfigInterface;
  readonly outDir:       string;
  readonly schemasBase:  string;
  /** Optional squash node — defaults to `defaultSquashNode`. */
  readonly squashNode?:  SquashNodeInterface;
  /** Optional observer — defaults to a ProvObserver writing into the run dataset. */
  readonly observer?:    ProvObserverInterface;
}

const RUN_DAG_NAME       = 'squashage:run';
const INDUCE_DAG_NAME    = 'squashage:induce';
const REFINE_DAG_NAME    = 'squashage:refine';
const BOOTSTRAP_DAG_NAME = 'squashage:bootstrap';

export class SquashageRun {
  readonly services:   SquashageServices;
  readonly observer:   ProvObserverInterface;
  readonly dispatcher: SquashageDagonizer<NodeStateInterface>;

  private constructor(slots: {
    services:   SquashageServices;
    observer:   ProvObserverInterface;
    dispatcher: SquashageDagonizer<NodeStateInterface>;
  }) {
    this.services   = slots.services;
    this.observer   = slots.observer;
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

    const observer = options.observer ?? new ProvObserver({
      factory:           services.factory,
      dataset:           services.dataset,
      runId:             runStartTime,
      dispatcherAgentId: `squashage/${options.target}`,
      logger:            services.logger,
    });

    const dispatcher = new SquashageDagonizer<NodeStateInterface>({ services, observer });

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

    // ── 1. Register all nodes before any DAG (DAG validation checks node refs). ─

    // Record-scope nodes (shared by both squashage:record and squashage:record-induce).
    registerRecordNodes(
      dispatcher as unknown as SquashageDagonizer<SquashageRecordState>,
      {
        classifyConflict,
        urlPatternClassifier,
        structuralClassifier,
        rulesClassifier,
        schemaClassifier,
        shaclShapeClassifier,
        propertyFingerprintClassifier,
        winknlpEntitiesClassifier,
        ontologyClassifier,
        taxonomicNarrowingClassifier,
        discriminatorClassifier,
        squash: squashNode,
      },
    );

    // Run-scope nodes (walk-input, enrich, finalize, etc.).
    registerRunNodes(dispatcher as unknown as SquashageDagonizer<SquashageRunState>);

    // Induce-only nodes (shape-observe, merge-shape-cache, induce-schemas, write-drafts).
    registerInduceNodes(dispatcher);

    // Refine nodes (walk-drafts, read-draft, read-refinement, apply-refinement,
    // refinement-missing-warn, write-final).
    registerRefineNodes(dispatcher);

    // Bootstrap gate nodes (refine-required-gate, build-ready-gate).
    registerBootstrapNodes(dispatcher);

    // Per-item dispatch node (run): invokes 'squashage:record' per locator.
    const recordDispatch = createRecordDispatchNode(dispatcher);
    dispatcher.registerNode(
      recordDispatch as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
    );

    // Per-item dispatch node (induce): invokes 'squashage:record-induce' per locator.
    const recordDispatchInduce = createRecordDispatchNode(
      dispatcher,
      'squashage:record-induce',
      'record-dispatch-induce',
    );
    dispatcher.registerNode(
      recordDispatchInduce as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
    );

    // Per-item dispatch node (refine): invokes 'squashage:refine-one' per draft.
    const draftDispatch = createDraftDispatchNode(dispatcher);
    dispatcher.registerNode(
      draftDispatch as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
    );

    // ── 2. Register DAGs after all nodes are present. ─────────────────────────
    dispatcher.registerDAG(recordDag);
    dispatcher.registerDAG(recordInduceDag);

    // Build the run-scope DAG inline.
    const runDag = new DAGBuilder(RUN_DAG_NAME, '1.0')
      .node('walk-input',
        { name: 'walk-input', outputs: ['walked', 'empty'] as const, async execute() { throw new Error('stub'); } },
        { walked: 'process-all-records', empty: 'rdfjs-finalize' })
      .fanOut(
        'process-all-records',
        recordDispatch,
        'locators',
        { strategy: 'append', target: '_dispatchedItems' },
        { 'all-success': 'enrich-entity-link', partial: 'enrich-entity-link', 'all-error': 'rdfjs-finalize', empty: 'rdfjs-finalize' },
        { concurrency: services.targetConfig.concurrency ?? 1 },
      )
      .node('enrich-entity-link',
        { name: 'enrich-entity-link', outputs: ['enriched', 'skipped'] as const, async execute() { throw new Error('stub'); } },
        { enriched: 'ontology-emit', skipped: 'ontology-emit' })
      .node('ontology-emit',
        { name: 'ontology-emit', outputs: ['emitted', 'skipped'] as const, async execute() { throw new Error('stub'); } },
        { emitted: 'rdfjs-finalize', skipped: 'rdfjs-finalize' })
      .node('rdfjs-finalize',
        { name: 'rdfjs-finalize', outputs: ['written', 'empty'] as const, async execute() { throw new Error('stub'); } },
        { written: 'catalog-emit', empty: null })
      .node('catalog-emit',
        { name: 'catalog-emit', outputs: ['emitted', 'skipped'] as const, async execute() { throw new Error('stub'); } },
        { emitted: null, skipped: null })
      .entrypoint('walk-input')
      .build();

    dispatcher.registerDAG(runDag);
    dispatcher.registerDAG(induceDag);
    dispatcher.registerDAG(refineOneDag);
    dispatcher.registerDAG(refineDag);

    // Bootstrap DAG registered after all constituent DAGs are present.
    dispatcher.registerDAG(bootstrapDag);

    return new SquashageRun({ services, observer, dispatcher });
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
   * (`induceResult`, `refineResult`) from the flat fields that the deep-DAG
   * stateMapping lifted back from child states. These nested fields are
   * constructed post-hoc because the DottedPathAccessor cannot write through
   * a `null` parent field during deep-DAG completion.
   */
  async executeBootstrap(initialState?: SquashageBootstrapState): Promise<{ state: SquashageBootstrapState }> {
    const state = initialState ?? new SquashageBootstrapState(this.services.target, this.services.runStartTime);
    await this.dispatcher.execute(BOOTSTRAP_DAG_NAME, state);

    const bootstrapState = state as SquashageBootstrapState;

    // Populate induceResult if the induce phase ran (draftsWritten > 0 or
    // discoveredClasses were lifted back).
    if (bootstrapState.draftsWritten > 0 || bootstrapState.discoveredClasses.length > 0) {
      bootstrapState.induceResult = {
        discoveredClasses: bootstrapState.discoveredClasses,
        draftsWritten:     bootstrapState.draftsWritten,
      };
    }

    // Populate refineResult if the refine phase ran (either count > 0).
    if (bootstrapState.refinedCount > 0 || bootstrapState.passthroughCount > 0) {
      bootstrapState.refineResult = {
        refinedCount:     bootstrapState.refinedCount,
        passthroughCount: bootstrapState.passthroughCount,
      };
    }

    // Populate results from services.recordSummaries (populated during the
    // build fan-out by the per-item record-dispatch node).
    if (this.services.recordSummaries.length > 0) {
      bootstrapState.results = [...this.services.recordSummaries];
    }

    return { state: bootstrapState };
  }

  /** Convenience constructor for a NullObserver-equipped run (tests). */
  static async forTargetWithNullObserver(options: SquashageRunOptionsInterface): Promise<SquashageRun> {
    return SquashageRun.forTarget({ ...options, observer: new NullObserver() });
  }
}
