/**
 * record-health-gate — placed between the classifier parallel placement and
 * `classify-conflict`. Reads accumulated state to route the record:
 *
 *   has-proposals → 'classify-conflict' (any classifier wrote to state.proposals)
 *   none          → 'record-quarantine' (no proposals; quarantineBucket=unknown)
 *   errors        → 'record-quarantine' (state.errors non-empty after parallel;
 *                                        quarantineBucket=projection)
 */

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRecordState } from '../../state/SquashageRecordState.js';

type Output = 'has-proposals' | 'none' | 'errors';

export const recordHealthGateNode: NodeInterface<SquashageRecordState, Output, SquashageServices> = {
  name:    'record-health-gate',
  outputs: ['has-proposals', 'none', 'errors'],
  async execute(state, _context) {
    if (state.errors.length > 0) {
      state.quarantineBucket = 'projection';
      return { output: 'errors' };
    }
    if (Object.keys(state.proposals).length === 0) {
      state.quarantineBucket = 'unknown';
      return { output: 'none' };
    }
    return { output: 'has-proposals' };
  },
};
