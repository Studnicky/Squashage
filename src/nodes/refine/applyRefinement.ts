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

import { ScalarNode, NodeOutputBuilder, NodeErrorBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';
import type { JsonObjectType } from '@studnicky/dagonizer/entities';

import { RefinementApplier } from '../../induction/RefinementApplier.js';
import type { RefineSpec } from '../../induction/RefinementApplier.js';
import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRefineState } from '../../state/SquashageRefineState.js';

type Output = 'applied' | 'error';

class ApplyRefinementNodeImpl extends ScalarNode<SquashageRefineState, Output, SquashageServices> {
  public readonly name    = 'apply-refinement';
  public readonly outputs = ['applied', 'error'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return {
      applied: { type: 'object' },
      error:   { type: 'object' },
    };
  }

  protected override async executeOne(
    state:   SquashageRefineState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const log = context.services.logger.forComponent('apply-refinement');

    if (state.draftJson === null || state.refinementJson === null) {
      const message = 'apply-refinement: draftJson or refinementJson is null';
      log.error('executeOne', message, { className: state.className });
      state.collectError(NodeErrorBuilder.from(
        'APPLY_REFINEMENT_NULL_INPUT', message, 'apply-refinement.executeOne', false, new Date().toISOString(),
      ));
      return NodeOutputBuilder.of('error');
    }

    const { final, warnings } = RefinementApplier.apply(
      state.draftJson as Record<string, unknown>,
      state.refinementJson as unknown as RefineSpec,
    );

    for (const w of warnings) {
      log.warn('executeOne', w.message, {
        className: state.className,
        code:      w.code,
        pointer:   w.pointer,
      });
    }

    state.finalJson = final as JsonObjectType;
    log.debug('executeOne', 'refinement applied', {
      className:    state.className,
      warningCount: warnings.length,
    });

    return NodeOutputBuilder.of('applied');
  }
}

export const applyRefinementNode = new ApplyRefinementNodeImpl();
