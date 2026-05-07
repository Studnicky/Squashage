/**
 * @fileoverview Shared rule-evaluation helper for classifier task classes.
 *
 * @remarks
 * Extracted to eliminate the single repeated hot-path loop from
 * {@link StructuralClassifier} and {@link RulesClassifier}. Both classifiers
 * share an identical engine: iterate compiled rules, evaluate each predicate,
 * and emit one proposal per matching rule. The difference between the two is
 * *config-shape* and *source label*, not evaluation logic.
 *
 * This module is private to `src/classification/tasks/` — do not import it
 * from outside that directory.
 *
 * @module
 * @since 0.1.0
 * @category Classification
 */

import { Predicate } from '../predicates/Predicate.js';
import type { CompiledPredicateInterface } from '../predicates/Predicate.js';
import type { ClassificationProposalInterface } from '../../types/PipelineState.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Minimal shape required by {@link evaluateRules} — both
 * {@link StructuralRuleInterface} and {@link RuleEntryInterface} satisfy it.
 *
 * @internal
 */
export interface EvaluableRuleInterface {
  /** Proposed ontology class id for records matched by this rule. */
  readonly className: string;
  /** Numeric priority forwarded verbatim onto the emitted proposal. */
  readonly priority:  number;
  /** Already-compiled predicate, evaluated per-record at hot-path speed. */
  readonly predicate: CompiledPredicateInterface;
  /** Pre-computed human-readable evidence reasons. */
  readonly reasons:   ReadonlyArray<string>;
}

// ── Evaluator ─────────────────────────────────────────────────────────────────

/**
 * Iterates `rules` and returns one {@link ClassificationProposalInterface} for
 * every rule whose compiled predicate evaluates to `true` against `record`.
 *
 * @remarks
 * All matching rules produce proposals — the caller is responsible for pushing
 * them onto `state.classifications`. Conflict resolution is handled downstream
 * by the ConflictResolver (C4). No heap allocations beyond the result array.
 *
 * @param rules  - Frozen array of compiled rules from the classifier constructor.
 * @param source - Task source label written onto every emitted proposal
 *   (e.g. `'classify:structural'` or `'classify:rules'`).
 * @param record - The record being evaluated (typically `state.input`).
 * @returns Array of proposals for matching rules; empty when no rule matches.
 *
 * @internal
 */
export function evaluateRules(
  rules:  ReadonlyArray<EvaluableRuleInterface>,
  source: string,
  record: unknown,
): ReadonlyArray<ClassificationProposalInterface> {
  const proposals: ClassificationProposalInterface[] = [];

  for (const rule of rules) {
    if (Predicate.evaluate(rule.predicate, record)) {
      proposals.push({
        source,
        className:  rule.className,
        priority:   rule.priority,
        confidence: 1,
        reasons:    rule.reasons,
      });
    }
  }

  return proposals;
}
