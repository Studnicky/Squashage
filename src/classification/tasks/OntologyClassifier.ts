/**
 * @fileoverview `classify:ontology` pipeline task — class IRI validation gate.
 *
 * @remarks
 * Inspects each proposal on `state.classifications` emitted by upstream
 * `classify:*` tasks and, for any proposal whose `className` is not present in
 * the configured ontology class map, emits a new `__validation__` proposal that
 * flags the unknown class. The ConflictResolver (C4) downstream reads these
 * sentinel proposals as evidence when building the final
 * {@link ClassificationEvidenceInterface}.
 *
 * This task does NOT vote for a class — its sole job is to annotate the
 * proposal trail with ontology-awareness so that downstream review tooling and
 * the ConflictResolver can surface unknown-class problems.
 *
 * **Usage**: instantiate once per pipeline run with the target's class map and
 * register the bound `execute` method onto the run's {@link TaskRegistry}.
 * The factory (C5) handles registration.
 *
 * @module
 * @since 0.1.0
 * @category Classification
 */

import type { NextFnInterface, TaskFnInterface } from '../../types/Pipeline.js';
import type { PipelineStateInterface, ClassificationProposalInterface } from '../../types/PipelineState.js';
import { OutputConfigError } from '../../errors/OutputConfigError.js';
import { Logger } from '../../modules/logger/logger.js';

const logger = Logger.forComponent('OntologyClassifier');

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Configuration for the ontology class IRI validator.
 *
 * @category Classification
 * @since 0.1.0
 * @see {@link OntologyClassifier}
 * @group Types
 */
export interface OntologyConfigInterface {
  /**
   * Map from className (matches proposal.className) to its canonical class IRI
   * in the target's ontology. Proposals whose className is missing from this
   * map are flagged as "ontology-unknown" — the ConflictResolver downstream
   * decides how to handle them.
   */
  readonly classes: Readonly<Record<string, string>>;
}

// ── Metadata sentinels ────────────────────────────────────────────────────────

/**
 * Set of className sentinels that should never be validated against the
 * ontology map. These are internal coordination tokens, not class proposals.
 *
 * @internal
 */
const METADATA_SENTINELS = new Set<string>(['__source__', '__validation__', 'unknown']);

// ── OntologyClassifier ────────────────────────────────────────────────────────

/**
 * Classifier task that validates upstream proposals against a known ontology
 * class map and emits `__validation__` sentinel proposals for unknown classes.
 *
 * @remarks
 * Iterates `state.classifications` and, for each proposal whose `className` is
 * absent from the configured `classes` map AND is not a metadata sentinel
 * (`__source__`, `__validation__`, `unknown`), emits a new
 * {@link ClassificationProposalInterface} with `className: '__validation__'`.
 * These sentinel proposals are preserved in the evidence chain so the
 * ConflictResolver and downstream tooling can surface unknown-class problems.
 *
 * Metadata sentinels are intentionally skipped — they are coordination tokens
 * that carry no class vote and should not themselves trigger further validation.
 *
 * @example
 * ```ts
 * const classifier = new OntologyClassifier({
 *   classes: {
 *     feat:  'https://squashage.dev/vocabulary/aonprd#Feat',
 *     spell: 'https://squashage.dev/vocabulary/aonprd#Spell',
 *   },
 * });
 * registry.register('classify:ontology', classifier.execute);
 * ```
 *
 * @category Classification
 * @since 0.1.0
 * @see {@link OntologyConfigInterface}
 * @see {@link ClassificationProposalInterface}
 * @group Classifiers
 */
export class OntologyClassifier {
  /** Frozen ontology class map; keyed by className, value is the canonical IRI. */
  readonly #classes: Readonly<Record<string, string>>;

  /**
   * Creates an {@link OntologyClassifier} instance.
   *
   * @remarks
   * The constructor freezes the `classes` map reference so the ontology
   * configuration is immutable after construction. An empty map throws
   * {@link OutputConfigError} — targets that opt out of the ontology gate
   * should not include `classify:ontology` in their pipeline.
   *
   * @param config - Ontology class map. Empty map throws OutputConfigError.
   * @throws {OutputConfigError} When `config.classes` is empty — a target that
   *   configures `classify:ontology` must supply at least one known class.
   */
  public constructor(config: OntologyConfigInterface) {
    const classCount = Object.keys(config.classes).length;

    if (classCount === 0) {
      throw OutputConfigError.create(
        'OntologyClassifier requires at least one entry in config.classes; ' +
        'received an empty classes map. Remove classify:ontology from the ' +
        'pipeline or supply the ontology class map.',
        { metadata: { task: 'classify:ontology', classCount: 0 } },
      );
    }

    this.#classes = Object.freeze({ ...config.classes });

    // Bind execute so it can be passed as a bare function reference to
    // TaskRegistry.register() without losing its `this` context.
    this.execute = this.#executeImpl.bind(this);
  }

  /**
   * Bound pipeline task function for `classify:ontology`.
   *
   * @remarks
   * Public class field; safe to pass as a bare reference to
   * {@link TaskRegistry.register} — `this` binding is captured at
   * construction time.
   */
  public readonly execute: TaskFnInterface<PipelineStateInterface>;

  // ── Private implementation ────────────────────────────────────────────────

  async #executeImpl(
    next:  NextFnInterface,
    state: PipelineStateInterface,
  ): Promise<void> {
    logger.debug('execute', 'OntologyClassifier invoked', {
      targetId:        state.targetId,
      proposalCount:   state.classifications.length,
      knownClassCount: Object.keys(this.#classes).length,
    });

    const validationProposals: ClassificationProposalInterface[] = [];

    for (const proposal of state.classifications) {
      // Skip metadata sentinels — they are not class proposals.
      if (METADATA_SENTINELS.has(proposal.className)) {
        continue;
      }

      if (!(proposal.className in this.#classes)) {
        const reason = `ontology-unknown: ${proposal.className} (from ${proposal.source})`;

        validationProposals.push({
          source:     'classify:ontology',
          className:  '__validation__',
          priority:   0,
          confidence: 1,
          reasons:    [reason],
        });

        logger.debug('execute', 'Unknown className flagged', {
          targetId:  state.targetId,
          className: proposal.className,
          source:    proposal.source,
        });
      }
    }

    if (validationProposals.length > 0) {
      (state as unknown as { classifications: ReadonlyArray<ClassificationProposalInterface> })
        .classifications = [...state.classifications, ...validationProposals];

      logger.info('execute', 'Ontology validation proposals emitted', {
        targetId:        state.targetId,
        validationCount: validationProposals.length,
      });
    } else {
      logger.debug('execute', 'All proposals passed ontology validation', {
        targetId: state.targetId,
      });
    }

    await next();
  }
}
