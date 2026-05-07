/**
 * @fileoverview `classify:structural` pipeline task — required-keys and literal-discriminator gate.
 *
 * @remarks
 * Evaluates a frozen set of pre-compiled structural rules against each record.
 * Each matching rule emits one {@link ClassificationProposalInterface} onto
 * `state.classifications`. Multiple rules may match the same record, producing
 * multiple proposals — conflict resolution is the responsibility of the
 * ConflictResolver (C4).
 *
 * **Usage**: instantiate once per pipeline run (after compiling rules via
 * {@link Predicate.compile}) and register the bound `execute` method onto the
 * run's {@link TaskRegistry}. The factory (C5) handles registration.
 *
 * @module
 * @since 0.1.0
 * @category Classification
 */

import type { NextFnInterface, TaskFnInterface } from '../../types/Pipeline.js';
import type { PipelineStateInterface, ClassificationProposalInterface } from '../../types/PipelineState.js';
import type { CompiledPredicateInterface } from '../predicates/Predicate.js';
import { OutputConfigError } from '../../errors/OutputConfigError.js';
import { Logger } from '../../modules/logger/logger.js';
import { evaluateRules } from './_shared.js';

const logger = Logger.forComponent('StructuralClassifier');

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single pre-compiled structural classification rule.
 *
 * @remarks
 * Rules are compiled once at startup by the factory (C5) via
 * {@link Predicate.compile}; this interface only carries the compiled form.
 * The `reasons` array is pre-computed at compile time so no string
 * interpolation occurs on the hot per-record path.
 *
 * @category Classification
 * @since 0.1.0
 * @see {@link StructuralClassifier}
 * @group Types
 */
export interface StructuralRuleInterface {
  /** Proposed ontology class id for records matched by this rule. */
  readonly className: string;
  /** Numeric priority forwarded verbatim onto the emitted proposal; ConflictResolver picks the highest. */
  readonly priority:  number;
  /** Already-compiled predicate, evaluated per-record at hot-path speed via {@link Predicate.evaluate}. */
  readonly predicate: CompiledPredicateInterface;
  /** Pre-computed human-readable evidence reasons preserved verbatim into the final classification. */
  readonly reasons:   ReadonlyArray<string>;
}

// ── StructuralClassifier ──────────────────────────────────────────────────────

/**
 * Classifier task that evaluates a frozen decision-table of structural rules.
 *
 * @remarks
 * Each rule carries a {@link CompiledPredicateInterface} pre-built by the
 * factory. On every record, the classifier iterates the rule list and emits
 * one {@link ClassificationProposalInterface} per matching rule with
 * `source: 'classify:structural'`. All matching rules produce proposals;
 * the ConflictResolver selects the winner based on `priority`.
 *
 * The constructor freezes the `rules` reference so the rule set is immutable
 * after construction.
 *
 * @example
 * ```ts
 * const rules: StructuralRuleInterface[] = [
 *   {
 *     className: 'feat',
 *     priority:  10,
 *     predicate: Predicate.compile({ path: '/_type', equals: 'feat' }),
 *     reasons:   ['_type=feat'],
 *   },
 * ];
 * const classifier = new StructuralClassifier(rules);
 * registry.register('classify:structural', classifier.execute);
 * ```
 *
 * @category Classification
 * @since 0.1.0
 * @see {@link StructuralRuleInterface}
 * @see {@link ClassificationProposalInterface}
 * @group Classifiers
 */
export class StructuralClassifier {
  /** Frozen rule list; evaluated per-record on the hot path. */
  readonly #rules: ReadonlyArray<StructuralRuleInterface>;

  /**
   * Creates a {@link StructuralClassifier} instance with the given rule set.
   *
   * @param rules - Already-compiled structural rules. The constructor freezes
   *   the array reference. Each rule's predicate evaluates to `true` iff the
   *   record matches.
   * @throws {OutputConfigError} When `rules` is empty — an empty rule set
   *   indicates a misconfigured pipeline and should fail fast at startup.
   */
  public constructor(rules: ReadonlyArray<StructuralRuleInterface>) {
    if (rules.length === 0) {
      throw OutputConfigError.create(
        'StructuralClassifier requires at least one rule; received an empty rules array.',
        { metadata: { ruleCount: 0 } },
      );
    }

    this.#rules = Object.freeze([...rules]);

    // Bind execute so it can be passed as a bare function reference to
    // TaskRegistry.register() without losing its `this` context.
    this.execute = this.#executeImpl.bind(this);
  }

  /**
   * Bound pipeline task function for `classify:structural`.
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
    logger.debug('execute', 'StructuralClassifier invoked', {
      targetId:  state.targetId,
      ruleCount: this.#rules.length,
    });

    const newProposals = evaluateRules(this.#rules, 'classify:structural', state.input);

    if (newProposals.length > 0) {
      (state as unknown as { classifications: ReadonlyArray<ClassificationProposalInterface> })
        .classifications = [...state.classifications, ...newProposals];

      logger.info('execute', 'Structural proposals emitted', {
        targetId:      state.targetId,
        proposalCount: newProposals.length,
      });
    } else {
      logger.debug('execute', 'No structural rules matched', { targetId: state.targetId });
    }

    await next();
  }
}
