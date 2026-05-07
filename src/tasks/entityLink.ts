/**
 * @fileoverview Built-in `enrich:entity-link` task for the Squashage pipeline.
 *
 * @remarks
 * Enrichment-tier task that runs ONCE at the end of a pipeline run (after all
 * per-record classification + plugin-emit tasks have settled, before finalize).
 * The orchestrator strips `enrich:entity-link` from the per-record pipeline and
 * invokes it once with a synthetic state carrying the run-wide context -- the
 * same lifecycle as `rdfjs:finalize`.
 *
 * The task:
 * 1. Builds a case-folded index of every typed instance in the shared dataset
 *    whose `rdf:type` is in the configured `linkAgainst` allow-list. The index
 *    maps `caseFolded(label) -> instanceIri`.
 * 2. Scans every instance subject's configured prose fields (resolved by looking
 *    up literal values on the subject IRI in the dataset).
 * 3. For each prose span that matches an index entry: emits a
 *    `<subject> <edgeIri> <matchedSubject>` quad in the subject's named graph.
 * 4. Self-links and duplicate edges within one subject are suppressed.
 *
 * Matching is case-fold exact: winkNLP tokenizes the prose, sliding-window
 * multi-token spans are generated (1-5 tokens), each lower-cased and looked up
 * in the index. No fuzzy matching, no edit distance.
 *
 * The task is a no-op when `targets.<id>.enrichment.entityLink` is absent from
 * the target config or when `engine !== "winknlp"`.
 *
 * The task self-registers a no-op stub under the name `enrich:entity-link` at
 * module load time. The orchestrator replaces the stub with a stateful instance
 * (built via {@link EntityLinkTask.create}) on the post-batch invocation path.
 *
 * @module
 * @since 0.6.0
 * @category Tasks
 */

import type { WinkMethods } from 'wink-nlp';
import winkNlpModule        from 'wink-nlp';
import modelModule          from 'wink-eng-lite-web-model';

import type { NamedNode }                          from '@rdfjs/types';
import type { NextFnInterface, TaskFnInterface }   from '../types/Pipeline.js';
import type { PipelineStateInterface }             from '../types/PipelineState.js';
import { TaskRegistry }     from '../registry/TaskRegistry.js';
import { Logger }           from '../modules/logger/logger.js';
import { OutputConfigError } from '../errors/OutputConfigError.js';
import { ExternalSchemaError } from '../errors/ExternalSchemaError.js';
import { RDF }              from '../rdf/Vocab.js';

// CJS default interop (same pattern as WinknlpEntitiesClassifier).
const winkNlp = (winkNlpModule as unknown as { default?: typeof winkNlpModule }).default
  ?? winkNlpModule;
const model = (modelModule as unknown as { default?: typeof modelModule }).default
  ?? modelModule;

const logger = Logger.forComponent('entityLink');

/** Name under which `enrich:entity-link` is registered in the {@link TaskRegistry}. */
export const TASK_NAME = 'enrich:entity-link' as const;

// Pre-declare RDF type predicate for index-building.
const RDF_TYPE_IRI = RDF('type').value;

// ---------------------------------------------------------------------------
// Config interfaces
// ---------------------------------------------------------------------------

/**
 * Configuration block for the entity-link enrichment task.
 *
 * @remarks
 * Read from `targets.<id>.enrichment.entityLink` in the squashage config.
 *
 * @category Tasks
 * @since 0.6.0
 * @group Types
 */
export interface EntityLinkConfigInterface {
  /**
   * NLP engine to use for span extraction. Only `"winknlp"` is supported.
   * Any other value causes an {@link OutputConfigError} at task construction.
   */
  readonly engine: 'winknlp';
  /**
   * Prose field names to scan on each record.
   * Fields absent on a record or with a non-string value are silently skipped.
   * Defaults to `['description']` when absent.
   */
  readonly fields?: ReadonlyArray<string> | undefined;
  /**
   * Full IRI (with prefix, e.g. `"aonprd:mentions"`) or absolute IRI of the
   * edge predicate to emit between a record subject and a matched instance.
   */
  readonly edgeIri: string;
  /**
   * Allow-list of rdf:type IRIs whose typed instances are eligible link targets.
   * Only instances with at least one of these types in the dataset are indexed.
   * Accepts full IRIs or prefixed names (resolved against instance/vocabulary prefixes).
   */
  readonly linkAgainst: ReadonlyArray<string>;
  /**
   * Minimum confidence threshold `[0,1]`. Below this value no edge is emitted.
   * winkNLP pattern matches are binary (1.0), so this effectively acts as an
   * on/off switch. Defaults to `0.85`.
   */
  readonly minConfidence?: number | undefined;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/**
 * The instance index built once at the start of the enrichment phase.
 *
 * Maps `caseFolded(label) -> instanceIri` for all subjects whose `rdf:type`
 * IRI is in the configured `linkAgainst` allow-list.
 *
 * @internal
 */
type EntityIndexType = ReadonlyMap<string, string>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves an `aonprd:`-prefixed IRI string to a full IRI using the
 * vocabulary or instances prefix bases from the pipeline context.
 *
 * @remarks
 * If the string already starts with `http://` or `https://` it is returned
 * as-is. Otherwise the prefix (text before the first `:`) is compared to the
 * vocabulary and instances prefix names; if matched, the local part is appended
 * to the matching base.
 *
 * @param iri       - Raw IRI or prefixed name from the config.
 * @param prefixes  - Resolved prefix-base pairs from `state.context.prefixes`.
 * @returns Resolved full IRI string.
 */
const resolveIri = (
  iri:      string,
  prefixes: PipelineStateInterface['context'] extends undefined ? never : NonNullable<PipelineStateInterface['context']>['prefixes'],
): string => {
  if (iri.startsWith('http://') || iri.startsWith('https://')) return iri;
  const colon = iri.indexOf(':');
  if (colon === -1) return iri;
  const prefix = iri.slice(0, colon);
  const local  = iri.slice(colon + 1);
  if (prefix === prefixes.vocabulary.prefix) return `${prefixes.vocabulary.base}${local}`;
  if (prefix === prefixes.instances.prefix)  return `${prefixes.instances.base}${local}`;
  return iri;
};

/**
 * Extracts the human-readable label for a subject IRI from the shared dataset.
 *
 * @remarks
 * Searches for `rdfs:label` or `<vocabulary:name>` literal objects whose
 * subject is the given IRI. Returns the first string literal found, or
 * `undefined` when none is present.
 *
 * @param subjectIri  - IRI of the subject whose label we want.
 * @param dataset     - The shared run-wide dataset.
 * @param factory     - RDF data factory.
 * @param vocabBase   - Vocabulary base IRI (for `<vocabBase>name` predicate).
 * @returns Label string, or `undefined`.
 */
const extractLabel = (
  subjectIri: string,
  dataset:    NonNullable<PipelineStateInterface['context']>['dataset'],
  factory:    NonNullable<PipelineStateInterface['context']>['factory'],
  vocabBase:  string,
): string | undefined => {
  const subject   = factory.namedNode(subjectIri);
  const namePred  = factory.namedNode(`${vocabBase}name`);
  const labelPred = factory.namedNode('http://www.w3.org/2000/01/rdf-schema#label');

  // Try <vocabulary:name> first (aonprd convention), then rdfs:label.
  for (const predNode of [namePred, labelPred]) {
    const matches = dataset.match(subject, predNode, null, null);
    for (const q of matches) {
      if (q.object.termType === 'Literal') {
        return q.object.value;
      }
    }
  }
  return undefined;
};

/**
 * Builds the case-folded entity index from the shared dataset.
 *
 * @remarks
 * Scans all quads in the dataset. For each subject that has an `rdf:type`
 * triple whose object IRI is in `allowedTypes`, the subject's label (from
 * `<vocabBase>name` or `rdfs:label`) is case-folded and added to the index
 * mapping to the subject IRI. When a label cannot be derived, the local part
 * of the subject IRI (after the last `/` or `#`) is used as a fallback.
 *
 * @param dataset      - The shared run-wide dataset.
 * @param factory      - RDF data factory.
 * @param allowedTypes - Resolved full IRIs of types to index.
 * @param vocabBase    - Vocabulary base IRI for name predicate lookup.
 * @returns Frozen entity index.
 */
const buildIndex = (
  dataset:      NonNullable<PipelineStateInterface['context']>['dataset'],
  factory:      NonNullable<PipelineStateInterface['context']>['factory'],
  allowedTypes: ReadonlySet<string>,
  vocabBase:    string,
): EntityIndexType => {
  // Collect subject IRIs whose rdf:type is in the allow-list.
  const eligibleSubjects = new Set<string>();
  for (const quad of dataset) {
    if (
      quad.predicate.value === RDF_TYPE_IRI
      && quad.subject.termType === 'NamedNode'
      && quad.object.termType === 'NamedNode'
      && allowedTypes.has(quad.object.value)
    ) {
      eligibleSubjects.add(quad.subject.value);
    }
  }

  // Build label -> IRI map.
  const index = new Map<string, string>();
  for (const subjectIri of eligibleSubjects) {
    const label = extractLabel(subjectIri, dataset, factory, vocabBase);
    const key = label !== undefined
      ? label.toLowerCase()
      : subjectIri.split(/[/#]/).pop()?.toLowerCase() ?? '';
    if (key.length > 0) {
      index.set(key, subjectIri);
    }
  }

  logger.debug('buildIndex', 'Entity index built', {
    eligibleSubjectCount: eligibleSubjects.size,
    indexedLabelCount:    index.size,
  });

  return index;
};

// ---------------------------------------------------------------------------
// EntityLinkTask
// ---------------------------------------------------------------------------

/**
 * Stateful enrichment task that implements `enrich:entity-link`.
 *
 * @remarks
 * Holds a shared winkNLP instance and a lazily-built entity index. The index
 * is constructed once on the first task invocation. All subsequent invocations
 * use the same frozen index.
 *
 * @category Tasks
 * @since 0.6.0
 * @group Tasks
 */
export class EntityLinkTask {
  readonly #nlp:          WinkMethods;
  readonly #config:       EntityLinkConfigInterface;
  readonly #fields:       ReadonlyArray<string>;
  readonly #minConfidence: number;
  #index:                 EntityIndexType | null = null;

  private constructor(nlp: WinkMethods, config: EntityLinkConfigInterface) {
    this.#nlp           = nlp;
    this.#config        = config;
    this.#fields        = config.fields !== undefined && config.fields.length > 0
      ? [...config.fields]
      : ['description'];
    this.#minConfidence = config.minConfidence ?? 0.85;

    // Bind execute so it can be passed as a bare function reference.
    this.execute = this.#executeImpl.bind(this);
  }

  /**
   * Creates an {@link EntityLinkTask} instance from raw config.
   *
   * @remarks
   * Validates that `engine` is `"winknlp"`. All other validation (field types,
   * IRI shape) is deferred to execution time to keep construction lightweight.
   *
   * @param config - Raw entity-link config from the target's
   *   `enrichment.entityLink` block.
   * @returns A fully constructed, ready-to-register task instance.
   * @throws {OutputConfigError} When `config.engine` is not `"winknlp"`.
   */
  public static create(config: EntityLinkConfigInterface): EntityLinkTask {
    if (config.engine !== 'winknlp') {
      throw OutputConfigError.create(
        `enrich:entity-link: unsupported engine "${String(config.engine)}". Only "winknlp" is supported.`,
        { metadata: { engine: config.engine } },
      );
    }
    const nlp = winkNlp(model);

    logger.debug('create', 'EntityLinkTask constructed', {
      engine:      config.engine,
      fields:      config.fields,
      edgeIri:     config.edgeIri,
      linkAgainst: config.linkAgainst,
    });

    return new EntityLinkTask(nlp, config);
  }

  /**
   * Bound pipeline task function for `enrich:entity-link`.
   *
   * @remarks
   * Public class field; safe to pass as a bare reference to
   * {@link TaskRegistry.register}.
   */
  public readonly execute: TaskFnInterface<PipelineStateInterface>;

  // ---------------------------------------------------------------------------
  // Private implementation
  // ---------------------------------------------------------------------------

  /**
   * Returns (building once if needed) the case-folded entity index.
   *
   * @param ctx - The run-wide pipeline context.
   * @returns The frozen entity index.
   */
  #getOrBuildIndex(
    ctx: NonNullable<PipelineStateInterface['context']>,
  ): EntityIndexType {
    if (this.#index !== null) return this.#index;

    const prefixes  = ctx.prefixes;
    const vocabBase = prefixes.vocabulary.base;

    // Resolve linkAgainst IRIs to full IRIs.
    const allowedTypes = new Set(
      this.#config.linkAgainst.map((raw) => resolveIri(raw, prefixes)),
    );

    this.#index = buildIndex(ctx.dataset, ctx.factory, allowedTypes, vocabBase);
    return this.#index;
  }

  /**
   * Extracts candidate spans from a prose string using winkNLP tokenization.
   *
   * @remarks
   * Produces all tokens (single words) plus all multi-token chunks by sliding
   * a window over adjacent tokens (up to 5-token spans). The entity index
   * typically maps multi-word entity names so this ensures we catch them.
   *
   * @param text - Raw prose text to analyze.
   * @returns Array of unique lower-cased candidate span strings.
   */
  #extractSpans(text: string): ReadonlyArray<string> {
    const doc    = this.#nlp.readDoc(text);
    const its    = this.#nlp.its;
    const tokens = doc.tokens().out(its.value) as string[];

    const spans = new Set<string>();

    // Single tokens.
    for (const tok of tokens) {
      const lower = tok.toLowerCase();
      if (lower.length > 1) spans.add(lower);
    }

    // Sliding-window multi-token spans (2-5 tokens).
    for (let width = 2; width <= 5; width++) {
      for (let i = 0; i <= tokens.length - width; i++) {
        const chunk = tokens.slice(i, i + width).join(' ').toLowerCase();
        spans.add(chunk);
      }
    }

    return [...spans];
  }

  async #executeImpl(
    next:  NextFnInterface,
    state: PipelineStateInterface,
  ): Promise<void> {
    const ctx = state.context;
    if (ctx === undefined) {
      throw ExternalSchemaError.create(
        'enrich:entity-link requires state.context to be set by the orchestrator',
        { metadata: { task: TASK_NAME } },
      );
    }

    logger.debug('execute', 'enrich:entity-link task invoked (end-of-run pass)', {
      targetId:  state.targetId,
      datasetSize: ctx.dataset.size,
    });

    // Build the entity index once from the now-complete dataset.
    const index = this.#getOrBuildIndex(ctx);

    if (index.size === 0) {
      logger.debug('skip', 'Entity index is empty; no edges to emit', { targetId: state.targetId });
      await next();
      return;
    }

    // Resolve the edge predicate IRI.
    const edgeIri  = resolveIri(this.#config.edgeIri, ctx.prefixes);
    const edgePred = ctx.factory.namedNode(edgeIri) as NamedNode;

    // Collect all typed instance subjects (subjects with rdf:type in the allow-list).
    const allowedTypes = new Set(
      this.#config.linkAgainst.map((raw) => resolveIri(raw, ctx.prefixes)),
    );

    const instanceBase  = ctx.prefixes.instances.base;
    const vocabBase     = ctx.prefixes.vocabulary.base;

    // Collect subjects of the allowed types.
    const subjectSet = new Set<string>();
    for (const quad of ctx.dataset) {
      if (
        quad.predicate.value === RDF_TYPE_IRI
        && quad.subject.termType === 'NamedNode'
        && quad.object.termType  === 'NamedNode'
        && allowedTypes.has(quad.object.value)
        && quad.subject.value.startsWith(instanceBase)
      ) {
        subjectSet.add(quad.subject.value);
      }
    }

    let totalEdgeCount = 0;

    for (const subjectIri of subjectSet) {
      const subjectNode = ctx.factory.namedNode(subjectIri);

      // Determine the named graph for this subject.
      let recordGraph: NamedNode | undefined;
      const RDF_TYPE_NODE = ctx.factory.namedNode(RDF_TYPE_IRI);
      const typeMatches = ctx.dataset.match(subjectNode, RDF_TYPE_NODE, null, null);
      for (const q of typeMatches) {
        if (q.graph.termType === 'NamedNode') {
          recordGraph = q.graph as NamedNode;
          break;
        }
      }

      if (recordGraph === undefined) continue;

      // Read the prose fields for this subject from the dataset.
      // Probe the literal values of the configured prose fields stored as
      // predicates on the subject (e.g. <vocabBase>description, <vocabBase>summary).
      const emittedTargets = new Set<string>();
      let subjectEdgeCount = 0;

      for (const fieldName of this.#fields) {
        // Derive the field predicate IRI (<vocabBase><fieldName>).
        const fieldPredIri = `${vocabBase}${fieldName}`;
        const fieldPred    = ctx.factory.namedNode(fieldPredIri);

        const fieldMatches = ctx.dataset.match(subjectNode, fieldPred, null, null);
        for (const q of fieldMatches) {
          if (q.object.termType !== 'Literal') continue;
          const raw = q.object.value;
          if (raw.length === 0) continue;

          const spans = this.#extractSpans(raw);
          for (const span of spans) {
            const targetIri = index.get(span);
            if (targetIri === undefined) continue;
            if (targetIri === subjectIri) continue; // no self-links
            if (emittedTargets.has(targetIri)) continue; // no duplicates

            // winkNLP token-match confidence is 1.0 (binary).
            if (1.0 < this.#minConfidence) continue;

            const targetNode = ctx.factory.namedNode(targetIri);
            ctx.dataset.add(ctx.factory.quad(subjectNode, edgePred, targetNode, recordGraph));
            emittedTargets.add(targetIri);
            subjectEdgeCount++;
            totalEdgeCount++;
          }
        }
      }

      if (subjectEdgeCount > 0) {
        logger.debug('execute', 'Entity-link edges emitted for subject', {
          targetId:  state.targetId,
          subject:   subjectIri,
          edgeCount: subjectEdgeCount,
        });
      }
    }

    if (totalEdgeCount > 0) {
      logger.info('execute', 'enrich:entity-link run complete', {
        targetId:       state.targetId,
        totalEdgeCount,
        subjectCount:   subjectSet.size,
      });
    } else {
      logger.debug('execute', 'enrich:entity-link: no edges emitted in this run', {
        targetId:     state.targetId,
        subjectCount: subjectSet.size,
        indexSize:    index.size,
      });
    }

    await next();
  }
}

// ---------------------------------------------------------------------------
// Default registration
// ---------------------------------------------------------------------------

// The default export of this module registers a no-op stub under `enrich:entity-link`.
// The actual stateful instance must be constructed via EntityLinkTask.create() and
// registered on the per-run registry by the orchestrator (analogous to classifier tasks).
// This stub keeps the task name discoverable in the static registry for pipeline assembly.

const stubEntityLinkTask: TaskFnInterface<PipelineStateInterface> = async (
  next:  NextFnInterface,
  _state: PipelineStateInterface,
): Promise<void> => {
  // No-op stub: enrichment.entityLink not configured for this run.
  await next();
};

TaskRegistry.register(TASK_NAME, stubEntityLinkTask);
