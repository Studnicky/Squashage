/**
 * classify:structural — evaluates a frozen decision-table of compiled
 * predicates against `state.input` and emits one proposal per matching rule
 * (highest priority winner is written into `state.proposals[name]`).
 *
 * Predicates are compiled once in the constructor via `Predicate.compile`.
 * Per-record execute is pure CPU.
 */

import type { NodeInterface } from '@noocodex/dagonizer';

import {
  Predicate,
  type CompiledPredicateInterface,
  type RawPredicate,
} from '../../../classification/predicates/Predicate.js';
import type { SquashageServices } from '../../../services/SquashageServices.js';
import type { ClassificationProposal } from '../../../state/schemas/ClassificationProposal.js';
import type { SquashageRecordState } from '../../../state/SquashageRecordState.js';

export interface RawStructuralRuleInterface {
  readonly className: string;
  readonly priority:  number;
  readonly predicate: RawPredicate;
  readonly reasons:   ReadonlyArray<string>;
}

interface CompiledRuleInterface {
  readonly className: string;
  readonly priority:  number;
  readonly predicate: CompiledPredicateInterface;
  readonly reasons:   ReadonlyArray<string>;
}

type Output = 'proposed' | 'no-match';

export class StructuralClassifierNode
  implements NodeInterface<SquashageRecordState, Output, SquashageServices> {

  readonly name    = 'classify:structural';
  readonly outputs = ['proposed', 'no-match'] as const;
  readonly #rules: ReadonlyArray<CompiledRuleInterface>;

  constructor(rules: ReadonlyArray<RawStructuralRuleInterface>) {
    this.#rules = Object.freeze(rules.map((rule) => ({
      className: rule.className,
      priority:  rule.priority,
      predicate: Predicate.compile(rule.predicate),
      reasons:   [...rule.reasons],
    })));
  }

  async execute(
    state:    SquashageRecordState,
    _context: { readonly services: SquashageServices },
  ): Promise<{ output: Output }> {
    const matches: CompiledRuleInterface[] = [];
    for (const rule of this.#rules) {
      if (Predicate.evaluate(rule.predicate, state.input)) {
        matches.push(rule);
      }
    }
    if (matches.length === 0) return { output: 'no-match' };

    let winner = matches[0] as CompiledRuleInterface;
    for (let i = 1; i < matches.length; i++) {
      const m = matches[i] as CompiledRuleInterface;
      if (m.priority > winner.priority) winner = m;
    }

    const reasons = matches.flatMap((m) => m.reasons);
    const proposal: ClassificationProposal = {
      source:     'classify:structural',
      className:  winner.className,
      priority:   winner.priority,
      confidence: 1,
      reasons,
    };
    state.proposals['classify:structural'] = proposal;
    return { output: 'proposed' };
  }
}
