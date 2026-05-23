/**
 * refine-sync-tallies — copies the refine tally counters from
 * `services.refineSummaries` back into `SquashageRefineRunState` after the
 * `process-all-drafts` fan-out completes.
 *
 * The native dagonizer fan-out runs the per-item dispatch node on a cloned
 * state so mutations inside the dispatch node do not propagate to the parent.
 * `services.refineSummaries` is the shared mutable accumulator that survives
 * the clone boundary. This node is the sync barrier that reads those tallies
 * and writes them back to the run-scope state so that:
 *   - `SquashageBootstrapState.refinedCount` / `passthroughCount` are
 *     populated correctly via the deep-DAG stateMapping.
 *   - CLI output (`finalState.refinedCount`, `finalState.runErrors`) is accurate.
 */

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRefineRunState } from '../../state/SquashageRefineRunState.js';

type Output = 'synced';

export const refineSyncTalliesNode: NodeInterface<SquashageRefineRunState, Output, SquashageServices> = {
  name:    'refine-sync-tallies',
  outputs: ['synced'],
  async execute(state, context) {
    const { refinedCount, passthroughCount, runErrors } = context.services.refineSummaries;
    state.refinedCount     = refinedCount;
    state.passthroughCount = passthroughCount;
    for (const msg of runErrors) {
      state.runErrors.push(msg);
    }
    return { output: 'synced' };
  },
};
