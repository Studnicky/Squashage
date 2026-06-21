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

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRefineRunState } from '../../state/SquashageRefineRunState.js';

type Output = 'synced';

class RefineSyncTalliesNodeImpl extends ScalarNode<SquashageRefineRunState, Output, SquashageServices> {
  public readonly name    = 'refine-sync-tallies';
  public readonly outputs = ['synced'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { synced: { type: 'object' } };
  }

  protected override async executeOne(
    state:   SquashageRefineRunState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const { refinedCount, passthroughCount, runErrors } = context.services.refineSummaries;
    state.refinedCount     = refinedCount;
    state.passthroughCount = passthroughCount;
    for (const msg of runErrors) {
      state.runErrors.push(msg);
    }
    return NodeOutputBuilder.of('synced');
  }
}

export const refineSyncTalliesNode = new RefineSyncTalliesNodeImpl();
