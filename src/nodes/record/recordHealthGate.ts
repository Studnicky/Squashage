/**
 * record-health-gate — placed between the classifier parallel placement and
 * `classify-conflict`. Reads accumulated state to route the record:
 *
 *   has-proposals → 'classify-conflict' (any classifier wrote to state.proposals)
 *   none          → 'record-quarantine' (no proposals; quarantineBucket=unknown)
 *   errors        → 'record-quarantine' (state.errors non-empty after parallel;
 *                                        quarantineBucket=projection)
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRecordState } from '../../state/SquashageRecordState.js';

type Output = 'has-proposals' | 'none' | 'errors';

class RecordHealthGateNodeImpl extends ScalarNode<SquashageRecordState, Output, SquashageServices> {
  public readonly name    = 'record-health-gate';
  public readonly outputs = ['has-proposals', 'none', 'errors'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return {
      'has-proposals': { type: 'object' },
      none:            { type: 'object' },
      errors:          { type: 'object' },
    };
  }

  protected override async executeOne(
    state:    SquashageRecordState,
    _context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    if (state.errors.length > 0) {
      state.quarantineBucket = 'projection';
      return NodeOutputBuilder.of('errors');
    }
    if (Object.keys(state.proposals).length === 0) {
      state.quarantineBucket = 'unknown';
      return NodeOutputBuilder.of('none');
    }
    return NodeOutputBuilder.of('has-proposals');
  }
}

export const recordHealthGateNode = new RecordHealthGateNodeImpl();
