/**
 * NoOpClassifierNode — placeholder registered under a classifier's name when
 * that classifier has no config for the current target. Returns `'no-match'`
 * unconditionally so the parallel placement collects cleanly without
 * requiring a dynamic DAG.
 *
 * Keeps the static `recordDag` invariant: every classifier name in
 * `classifyAllParallelMembers` is always registered on the dispatcher.
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../../services/SquashageServices.js';
import type { SquashageRecordState } from '../../../state/SquashageRecordState.js';

type Output = 'proposed' | 'no-match' | 'validated' | 'narrowed' | 'no-op';

export class NoOpClassifierNode extends ScalarNode<SquashageRecordState, Output, SquashageServices> {

  public readonly name:    string;
  public readonly outputs: readonly Output[];

  constructor(name: string, outputs: readonly Output[]) {
    super();
    this.name    = name;
    this.outputs = outputs;
  }

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return {
      proposed:   { type: 'object' },
      'no-match': { type: 'object' },
      validated:  { type: 'object' },
      narrowed:   { type: 'object' },
      'no-op':    { type: 'object' },
    };
  }

  protected override async executeOne(
    _state:   SquashageRecordState,
    _context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const first = this.outputs.includes('no-match')
      ? ('no-match' as Output)
      : (this.outputs[0] as Output);
    return NodeOutputBuilder.of(first);
  }
}
