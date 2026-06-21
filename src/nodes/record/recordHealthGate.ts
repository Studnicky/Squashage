/**
 * record-health-gate — placed between the classifier parallel placement and
 * `classify-conflict`. Reads accumulated state to route the record:
 *
 *   has-proposals    → 'classify-conflict' (any classifier wrote to state.proposals)
 *   generic-fallback → 'squash' (no proposals at all; classification set to Generic)
 *   errors           → 'record-quarantine' (state.errors non-empty after parallel;
 *                                           quarantineBucket=projection)
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType, NodeWarningType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRecordState } from '../../state/SquashageRecordState.js';

type Output = 'has-proposals' | 'generic-fallback' | 'errors';

class RecordHealthGateNodeImpl extends ScalarNode<SquashageRecordState, Output, SquashageServices> {
  public readonly name    = 'record-health-gate';
  public readonly outputs = ['has-proposals', 'generic-fallback', 'errors'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return {
      'has-proposals':    { type: 'object' },
      'generic-fallback': { type: 'object' },
      errors:             { type: 'object' },
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
      state.classification = {
        type:       'Generic',
        confidence: 0,
        engine:     'classify:generic-fallback',
        reasons:    ['classify:generic-fallback'],
      };
      const fallbackWarning: NodeWarningType = {
        code:      'CLASSIFY_GENERIC_FALLBACK',
        message:   'record-health-gate: no classifier proposals; falling back to Generic class',
        operation: 'record-health-gate',
        timestamp: new Date().toISOString(),
      };
      state.collectWarning(fallbackWarning);
      return NodeOutputBuilder.of('generic-fallback');
    }
    return NodeOutputBuilder.of('has-proposals');
  }
}

export const recordHealthGateNode = new RecordHealthGateNodeImpl();
