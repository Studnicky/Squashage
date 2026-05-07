/**
 * @fileoverview `classify:rules` pipeline task — decision-table classifier over compiled predicates.
 *
 * @remarks
 * Evaluates a frozen decision-table of pre-compiled rules against each record.
 * Each matching rule emits one {@link ClassificationProposalInterface} onto
 * `state.classifications`. Multiple rules may match the same record, producing
 * multiple proposals — conflict resolution is the responsibility of the
 * ConflictResolver (C4).
 *
 * While the evaluation engine is structurally identical to
 * {@link StructuralClassifier}, the two classes are intentionally kept separate:
 * they represent distinct pipeline stages with distinct config shapes and
 * operational intent. `classify:structural` gates on required-keys and
 * discriminators; `classify:rules` applies the full semantic decision-table.
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

const logger = Logger.forComponent('RulesClassifier');

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single pre-compiled decision-table rule entry.
 *
 * @remarks
 * Rules are compiled once at startup by the factory (C5) via
 * {@link Predicate.compile}; this interface only carries the compiled form.
 * The `reasons` array is pre-computed at compile time so no string
 * interpolation occurs on the hot per-record path.
 *
 * @category Classification
 * @since 0.1.0
 * @see {@link RulesClassifier}
 * @group Types
 */
export interface RuleEntryInterface {
  /** Proposed ontology class id for records matched by this rule. */
  readonly className: string;
  /** Numeric priority forwarded verbatim onto the emitted proposal; ConflictResolver picks the highest. */
  readonly priority:  number;
  /** Already-compiled predicate, evaluated per-record at hot-path speed via {@link Predicate.evaluate}. */
  readonly predicate: CompiledPredicateInterface;
  /** Pre-computed human-readable evidence reasons preserved verbatim into the final classification. */
  readonly reasons:   ReadonlyArray<string>;
}

// ── RulesClassifier ───────────────────────────────────────────────────────────

/**
 * Classifier task that evaluates a frozen decision-table of semantic rules.
 *
 * @remarks
 * Each rule carries a {@link CompiledPredicateInterface} pre-built by the
 * factory. On every record, the classifier iterates the rule list and emits
 * one {@link ClassificationProposalInterface} per matching rule with
 * `source: 'classify:rules'`. All matching rules produce proposals;
 * the ConflictResolver selects the winner based on `priority`.
 *
 * The constructor freezes the `rules` reference so the rule set is immutable
 * after construction.
 *
 * @example
 * ```ts
 * const rules: RuleEntryInterface[] = [
 *   {
 *     className: 'feat',
 *     priority:  20,
 *     predicate: Predicate.compile({
 *       all: [
 *         { path: '/_type', equals: 'feat' },
 *         { path: '/level', type: 'number' },
 *       ],
 *     }),
 *     reasons: ['_type=feat', 'level present'],
 *   },
 * ];
 * const classifier = new RulesClassifier(rules);
 * registry.register('classify:rules', classifier.execute);
 * ```
 *
 * @category Classification
 * @since 0.1.0
 * @see {@link RuleEntryInterface}
 * @see {@link ClassificationProposalInterface}
 * @group Classifiers
 */
export class RulesClassifier {
  /** Frozen rule list; evaluated per-record on the hot path. */
  readonly #rules: ReadonlyArray<RuleEntryInterface>;

  /**
   * Creates a {@link RulesClassifier} instance with the given rule set.
   *
   * @param rules - Compiled decision-table rules. The constructor freezes the
   *   array reference. Each rule's predicate evaluates to `true` iff the record
   *   matches.
   * @throws {OutputConfigError} When `rules` is empty — an empty rule set
   *   indicates a misconfigured pipeline and should fail fast at startup.
   */
  public constructor(rules: ReadonlyArray<RuleEntryInterface>) {
    if (rules.length === 0) {
      throw OutputConfigError.create(
        'RulesClassifier requires at least one rule; received an empty rules array.',
        { metadata: { ruleCount: 0 } },
      );
    }

    this.#rules = Object.freeze([...rules]);

    // Bind execute so it can be passed as a bare function reference to
    // TaskRegistry.register() without losing its `this` context.
    this.execute = this.#executeImpl.bind(this);
  }

  /**
   * Bound pipeline task function for `classify:rules`.
   *
   * @remarks
   * Public class field; safe to pass as a bare function reference to
   * {@link TaskRegistry.register} — `this` binding is captured at
   * construction time.
   */
  public readonly execute: TaskFnInterface<PipelineStateInterface>;

  // ── Private implementation ────────────────────────────────────────────────

  async #executeImpl(
    next:  NextFnInterface,
    state: PipelineStateInterface,
  ): Promise<void> {
    logger.debug('execute', 'RulesClassifier invoked', {
      targetId:  state.targetId,
      ruleCount: this.#rules.length,
    });

    const newProposals = evaluateRules(this.#rules, 'classify:rules', state.input);

    if (newProposals.length > 0) {
      (state as unknown as { classifications: ReadonlyArray<ClassificationProposalInterface> })
        .classifications = [...state.classifications, ...newProposals];

      logger.info('execute', 'Rules proposals emitted', {
        targetId:      state.targetId,
        proposalCount: newProposals.length,
      });
    } else {
      logger.debug('execute', 'No rules matched', { targetId: state.targetId });
    }

    await next();
  }
}
