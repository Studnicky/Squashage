/**
 * classify:rules — full semantic decision-table classifier. Structurally
 * identical engine to `classify:structural` but separate config slot so the
 * two stages remain distinct.
 *
 * Predicates compiled once in the constructor; the per-record execute picks
 * the highest-priority match and writes it into `state.proposals[name]`.
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import {
  Predicate,
  type CompiledPredicateInterface,
  type RawPredicate,
} from '../../../classification/predicates/Predicate.js';
import type { SquashageServices } from '../../../services/SquashageServices.js';
import type { ClassificationProposal } from '../../../state/schemas/ClassificationProposal.js';
import type { SquashageRecordState } from '../../../state/SquashageRecordState.js';

export interface RawRulesEntryInterface {
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

export class RulesClassifierNode extends ScalarNode<SquashageRecordState, Output, SquashageServices> {

  public readonly name    = 'classify:rules';
  public readonly outputs = ['proposed', 'no-match'] as const;
  readonly #rules: ReadonlyArray<CompiledRuleInterface>;

  constructor(rules: ReadonlyArray<RawRulesEntryInterface>) {
    super();
    this.#rules = Object.freeze(rules.map((rule) => ({
      className: rule.className,
      priority:  rule.priority,
      predicate: Predicate.compile(rule.predicate),
      reasons:   [...rule.reasons],
    })));
  }

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { proposed: { type: 'object' }, 'no-match': { type: 'object' } };
  }

  protected override async executeOne(
    state:    SquashageRecordState,
    _context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const matches: CompiledRuleInterface[] = [];
    for (const rule of this.#rules) {
      if (Predicate.evaluate(rule.predicate, state.input)) {
        matches.push(rule);
      }
    }
    if (matches.length === 0) return NodeOutputBuilder.of('no-match');

    let winner = matches[0] as CompiledRuleInterface;
    for (let i = 1; i < matches.length; i++) {
      const m = matches[i] as CompiledRuleInterface;
      if (m.priority > winner.priority) winner = m;
    }

    const reasons = matches.flatMap((m) => m.reasons);
    const proposal: ClassificationProposal = {
      source:     'classify:rules',
      className:  winner.className,
      priority:   winner.priority,
      confidence: 1,
      reasons,
    };
    state.proposals['classify:rules'] = proposal;
    return NodeOutputBuilder.of('proposed');
  }
}
