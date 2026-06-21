/**
 * refine-summary-collect — post-phase node for `squashage:refine-one`.
 *
 * After the per-draft pipeline completes, reads the final
 * `SquashageRefineState.outcome` and updates `services.refineSummaries`.
 * This replicates the tally-collection that the old `draftDispatch` node
 * performed.
 *
 * Registered via `.phase('refine-summary-collect', 'post', refineSummaryCollectNode)`.
 * Post-phase runs on every exit path; errors are collected as warnings.
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../services/SquashageServices.js';
import type { SquashageRefineState } from '../state/SquashageRefineState.js';

type Output = 'done';

class RefineSummaryCollectNodeImpl extends ScalarNode<SquashageRefineState, Output, SquashageServices> {
  public readonly name    = 'refine-summary-collect';
  public readonly outputs = ['done'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { done: { type: 'object' } };
  }

  protected override async executeOne(
    state:   SquashageRefineState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    if (state.outcome === 'error') {
      for (const e of state.errors) {
        context.services.refineSummaries.runErrors.push(e.message);
      }
    } else if (state.outcome === 'refined') {
      context.services.refineSummaries.refinedCount     += 1;
    } else if (state.outcome === 'passthrough') {
      context.services.refineSummaries.passthroughCount += 1;
    }
    return NodeOutputBuilder.of('done');
  }
}

export const refineSummaryCollectNode = new RefineSummaryCollectNodeImpl();
