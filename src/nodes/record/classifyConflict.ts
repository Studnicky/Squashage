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

import type { NodeInterface } from '@noocodex/dagonizer';

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

function pickHighestPriority(
  proposals: ReadonlyArray<ClassificationProposal>,
): ClassificationProposal {
  let winner = proposals[0] as ClassificationProposal;
  for (let i = 1; i < proposals.length; i++) {
    const p = proposals[i] as ClassificationProposal;
    if (p.priority > winner.priority) winner = p;
  }
  return winner;
}

function buildEvidence(
  className:    string,
  proposals:    ReadonlyArray<ClassificationProposal>,
  tied:         ReadonlyArray<string> | undefined,
  preserveAll:  boolean,
): ClassificationEvidence {
  const winner   = pickHighestPriority(proposals);
  const engine   = [...new Set<string>(proposals.map((p) => p.source))].join(',');
  const reasons  = preserveAll
    ? proposals.flatMap((p) => [...p.reasons])
    : [winner.reasons[0] ?? winner.className];
  return tied !== undefined
    ? { type: className, confidence: winner.confidence, engine, reasons, candidates: [...tied] }
    : { type: className, confidence: winner.confidence, engine, reasons };
}

export class ClassifyConflictNode
  implements NodeInterface<SquashageRecordState, Output, SquashageServices> {

  readonly name    = 'classify-conflict';
  readonly outputs = ['resolved', 'tie', 'unknown'] as const;
  readonly #config: ClassifyConflictConfigInterface;

  constructor(config: ClassifyConflictConfigInterface) {
    this.#config = Object.freeze({ ...config });
  }

  async execute(
    state:    SquashageRecordState,
    _context: { readonly services: SquashageServices },
  ): Promise<{ output: Output }> {
    const all = Object.values(state.proposals).filter(
      (p) => !SENTINELS.has(p.className),
    );

    if (all.length === 0) {
      state.quarantineBucket = 'unknown';
      return { output: 'unknown' };
    }

    const classNames = new Set<string>(all.map((p) => p.className));

    if (classNames.size === 1) {
      state.classification = buildEvidence(
        (all[0] as ClassificationProposal).className, all, undefined, this.#config.evidence,
      );
      return { output: 'resolved' };
    }

    const maxPriority   = Math.max(...all.map((p) => p.priority));
    const top           = all.filter((p) => p.priority === maxPriority);
    const topClassNames = [...new Set<string>(top.map((p) => p.className))];

    if (topClassNames.length === 1) {
      const winnerClass     = topClassNames[0] as string;
      const winnerProposals = all.filter((p) => p.className === winnerClass);
      state.classification = buildEvidence(winnerClass, winnerProposals, undefined, this.#config.evidence);
      return { output: 'resolved' };
    }

    const tied = [...topClassNames].sort();

    if (this.#config.onConflict === 'quarantine') {
      state.quarantineBucket = 'conflicts';
      return { output: 'tie' };
    }

    const winnerClass = tied[0] as string;
    const winnerProposals = all.filter((p) => p.className === winnerClass);
    state.classification = buildEvidence(winnerClass, winnerProposals, tied, this.#config.evidence);
    return { output: 'resolved' };
  }
}
