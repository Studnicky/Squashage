/**
 * classify:ontology — validates already-emitted proposals against the
 * target's ontology class map. Runs SEQUENTIALLY after the parallel
 * classifier placement so it can see every classifier's proposal in
 * `state.proposals` race-free.
 *
 * Writes one `__validation__` sentinel proposal under
 * `state.proposals['classify:ontology']` summarising any unknown className
 * votes. Never proposes a class — the conflict resolver filters sentinels.
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../../services/SquashageServices.js';
import type { ClassificationProposal } from '../../../state/schemas/ClassificationProposal.js';
import type { SquashageRecordState } from '../../../state/SquashageRecordState.js';

export interface OntologyClassifierConfigInterface {
  readonly classes: Readonly<Record<string, string>>;
}

type Output = 'validated' | 'no-match';

const SENTINELS = new Set<string>(['__source__', '__validation__', '__narrowing_applied__', 'unknown']);

export class OntologyClassifierNode extends ScalarNode<SquashageRecordState, Output, SquashageServices> {

  public readonly name    = 'classify:ontology';
  public readonly outputs = ['validated', 'no-match'] as const;
  readonly #classes: Readonly<Record<string, string>>;

  constructor(config: OntologyClassifierConfigInterface) {
    super();
    if (Object.keys(config.classes).length === 0) {
      throw new Error('classify:ontology: classes map must contain at least one entry');
    }
    this.#classes = Object.freeze({ ...config.classes });
  }

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { validated: { type: 'object' }, 'no-match': { type: 'object' } };
  }

  protected override async executeOne(
    state:    SquashageRecordState,
    _context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const unknownReasons: string[] = [];

    for (const [classifierName, proposal] of Object.entries(state.proposals)) {
      if (SENTINELS.has(proposal.className)) continue;
      if (!(proposal.className in this.#classes)) {
        unknownReasons.push(`ontology-unknown: ${proposal.className} (from ${classifierName})`);
      }
    }

    if (unknownReasons.length === 0) return NodeOutputBuilder.of('no-match');

    const proposal: ClassificationProposal = {
      source:     'classify:ontology',
      className:  '__validation__',
      priority:   0,
      confidence: 1,
      reasons:    unknownReasons,
    };
    state.proposals['classify:ontology'] = proposal;
    return NodeOutputBuilder.of('validated');
  }
}
