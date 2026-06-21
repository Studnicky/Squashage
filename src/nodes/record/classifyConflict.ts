/**
 * classify-conflict — reduces `state.proposals` (per-classifier slots) into a
 * single `state.classification`.
 *
 * Routes downstream:
 *   resolved — a single winning class selected; state.classification populated
 *   tie      — genuine multi-class tie under 'quarantine' policy; bucket = 'conflicts'
 *   unknown  — no real proposals after sentinel filtering; bucket = 'unknown'
 *
 * Conflict policy is injected via the constructor. Recipe matches the legacy
 * `ConflictResolver` v0.x algorithm (filter sentinels → distinct-class count
 * → priority winner → lex tiebreak).
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType, NodeWarningType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { ClassificationEvidence } from '../../state/schemas/ClassificationEvidence.js';
import type { ClassificationProposal } from '../../state/schemas/ClassificationProposal.js';
import type { SquashageRecordState } from '../../state/SquashageRecordState.js';

export interface ClassifyConflictConfigInterface {
  readonly onConflict: 'quarantine' | 'pickPriority';
  readonly evidence:   boolean;
}

type Output = 'resolved' | 'tie' | 'unknown';

const SENTINELS = new Set<string>(['__source__', '__validation__', '__narrowing_applied__', 'unknown']);

export class ClassifyConflictNode
  extends ScalarNode<SquashageRecordState, Output, SquashageServices> {

  public readonly name    = 'classify-conflict';
  public readonly outputs = ['resolved', 'tie', 'unknown'] as const;
  readonly #config: ClassifyConflictConfigInterface;

  constructor(config: ClassifyConflictConfigInterface) {
    super();
    this.#config = Object.freeze({ ...config });
  }

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return {
      resolved: { type: 'object' },
      tie:      { type: 'object' },
      unknown:  { type: 'object' },
    };
  }

  protected override async executeOne(
    state:    SquashageRecordState,
    _context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const all = Object.values(state.proposals).filter(
      (p) => !SENTINELS.has(p.className),
    );

    if (all.length === 0) {
      const genericProposal: ClassificationProposal = {
        source:     'classify:generic-fallback',
        className:  'Generic',
        priority:   0,
        confidence: 0,
        reasons:    ['classify:generic-fallback'],
      };
      state.classification = ClassifyConflictNode.buildEvidence(
        'Generic', [genericProposal], undefined, this.#config.evidence,
      );
      const fallbackWarning: NodeWarningType = {
        code:      'CLASSIFY_GENERIC_FALLBACK',
        message:   `classify-conflict: no real proposals; falling back to Generic class`,
        operation: 'classify-conflict',
        timestamp: new Date().toISOString(),
      };
      state.collectWarning(fallbackWarning);
      return NodeOutputBuilder.of('resolved');
    }

    const classNames = new Set<string>(all.map((p) => p.className));

    if (classNames.size === 1) {
      state.classification = ClassifyConflictNode.buildEvidence(
        (all[0] as ClassificationProposal).className, all, undefined, this.#config.evidence,
      );
      return NodeOutputBuilder.of('resolved');
    }

    const maxPriority   = Math.max(...all.map((p) => p.priority));
    const top           = all.filter((p) => p.priority === maxPriority);
    const topClassNames = [...new Set<string>(top.map((p) => p.className))];

    if (topClassNames.length === 1) {
      const winnerClass     = topClassNames[0] as string;
      const winnerProposals = all.filter((p) => p.className === winnerClass);
      state.classification = ClassifyConflictNode.buildEvidence(
        winnerClass, winnerProposals, undefined, this.#config.evidence,
      );
      return NodeOutputBuilder.of('resolved');
    }

    const tied = [...topClassNames].sort();

    if (this.#config.onConflict === 'quarantine') {
      state.quarantineBucket = 'conflicts';
      return NodeOutputBuilder.of('tie');
    }

    const winnerClass = tied[0] as string;
    const winnerProposals = all.filter((p) => p.className === winnerClass);
    state.classification = ClassifyConflictNode.buildEvidence(
      winnerClass, winnerProposals, tied, this.#config.evidence,
    );
    return NodeOutputBuilder.of('resolved');
  }

  private static pickHighestPriority(
    proposals: ReadonlyArray<ClassificationProposal>,
  ): ClassificationProposal {
    let winner = proposals[0] as ClassificationProposal;
    for (let i = 1; i < proposals.length; i++) {
      const p = proposals[i] as ClassificationProposal;
      if (p.priority > winner.priority) winner = p;
    }
    return winner;
  }

  private static buildEvidence(
    className:    string,
    proposals:    ReadonlyArray<ClassificationProposal>,
    tied:         ReadonlyArray<string> | undefined,
    preserveAll:  boolean,
  ): ClassificationEvidence {
    const winner   = ClassifyConflictNode.pickHighestPriority(proposals);
    const engine   = [...new Set<string>(proposals.map((p) => p.source))].join(',');
    const reasons  = preserveAll
      ? proposals.flatMap((p) => [...p.reasons])
      : [winner.reasons[0] ?? winner.className];
    return tied !== undefined
      ? { type: className, confidence: winner.confidence, engine, reasons, candidates: [...tied] }
      : { type: className, confidence: winner.confidence, engine, reasons };
  }
}
