/**
 * refinement-missing-warn — passthrough handler for drafts with no refinement.
 *
 * Logs a warning, copies `state.draftJson` to `state.finalJson`, and sets
 * `state.outcome = 'passthrough'`. The `write-final` node then writes the
 * unchanged draft as the final schema.
 *
 * Outputs:
 *   done — always
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRefineState } from '../../state/SquashageRefineState.js';

type Output = 'done';

class RefinementMissingWarnNodeImpl extends ScalarNode<SquashageRefineState, Output, SquashageServices> {
  public readonly name    = 'refinement-missing-warn';
  public readonly outputs = ['done'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { done: { type: 'object' } };
  }

  protected override async executeOne(
    state:   SquashageRefineState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const log = context.services.logger.forComponent('refinement-missing-warn');

    log.warn(
      'executeOne',
      `no refinement for ${state.className}; writing draft as final`,
      { className: state.className, draftPath: state.draftPath },
    );

    state.finalJson = state.draftJson;
    state.outcome   = 'passthrough';

    return NodeOutputBuilder.of('done');
  }
}

export const refinementMissingWarnNode = new RefinementMissingWarnNodeImpl();
