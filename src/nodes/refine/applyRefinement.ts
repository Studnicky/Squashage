/**
 * apply-refinement — calls the pure RefinementApplier and stores the result.
 *
 * Reads `state.draftJson` and `state.refinementJson`, delegates to
 * `RefinementApplier.apply(...)`, stores the result in `state.finalJson`.
 *
 * On warnings (unresolvable pointers), logs each warning via
 * `services.logger.warn` and proceeds — "warn loud, write the final anyway"
 * is the contract. The caller (CLI) may exit-code 1 when warnings are present.
 *
 * Outputs:
 *   applied — finalJson is set; warnings were emitted (or none)
 *   error   — draftJson or refinementJson is null (programming error)
 */

import type { NodeInterface } from '@noocodex/dagonizer';
import type { JsonObject } from '@noocodex/dagonizer/types';

import { RefinementApplier } from '../../induction/RefinementApplier.js';
import type { RefineSpec } from '../../induction/RefinementApplier.js';
import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRefineState } from '../../state/SquashageRefineState.js';

type Output = 'applied' | 'error';

export const applyRefinementNode: NodeInterface<SquashageRefineState, Output, SquashageServices> = {
  name:    'apply-refinement',
  outputs: ['applied', 'error'],

  async execute(state, context): Promise<{ output: Output }> {
    const log = context.services.logger.forComponent('apply-refinement');

    if (state.draftJson === null || state.refinementJson === null) {
      const message = 'apply-refinement: draftJson or refinementJson is null';
      log.error('execute', message, { className: state.className });
      state.collectError({
        code:        'APPLY_REFINEMENT_NULL_INPUT',
        message,
        operation:   'apply-refinement.execute',
        recoverable: false,
        timestamp:   new Date().toISOString(),
      });
      return { output: 'error' };
    }

    const { final, warnings } = RefinementApplier.apply(
      state.draftJson as Record<string, unknown>,
      state.refinementJson as unknown as RefineSpec,
    );

    for (const w of warnings) {
      log.warn('execute', w.message, {
        className: state.className,
        code:      w.code,
        pointer:   w.pointer,
      });
    }

    state.finalJson = final as JsonObject;
    log.debug('execute', 'refinement applied', {
      className:    state.className,
      warningCount: warnings.length,
    });

    return { output: 'applied' };
  },
};
