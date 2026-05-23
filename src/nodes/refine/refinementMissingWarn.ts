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

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRefineState } from '../../state/SquashageRefineState.js';

type Output = 'done';

export const refinementMissingWarnNode: NodeInterface<SquashageRefineState, Output, SquashageServices> = {
  name:    'refinement-missing-warn',
  outputs: ['done'],

  async execute(state, context): Promise<{ output: Output }> {
    const log = context.services.logger.forComponent('refinement-missing-warn');

    log.warn(
      'execute',
      `no refinement for ${state.className}; writing draft as final`,
      { className: state.className, draftPath: state.draftPath },
    );

    state.finalJson = state.draftJson;
    state.outcome   = 'passthrough';

    return { output: 'done' };
  },
};
