/**
 * draft-dispatch — per-item node invoked by the `process-all-drafts` fan-out.
 *
 * Reads `currentItem` (a `DraftLocator`) from metadata, constructs a fresh
 * `SquashageRefineState`, executes the `'squashage:refine-one'` deep-DAG via
 * the dispatcher, updates `services.refineSummaries`, and returns `'success'`
 * if the draft was refined or passed through, or `'error'` if it errored.
 *
 * The fan-out executor aggregates these into `'all-success' | 'partial' |
 * 'all-error' | 'empty'` based on whether each item returned exactly
 * `'success'`.
 */

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageDagonizer } from '../../dispatcher/SquashageDagonizer.js';
import type { SquashageServices } from '../../services/SquashageServices.js';
import { SquashageRefineState } from '../../state/SquashageRefineState.js';
import type { SquashageRefineRunState } from '../../state/SquashageRefineRunState.js';
import type { DraftLocator } from '../../state/schemas/DraftLocator.js';
import type { NodeStateInterface } from '@noocodex/dagonizer';

type Output = 'success' | 'error';

const DEFAULT_REFINE_ONE_DAG = 'squashage:refine-one';
const DEFAULT_NODE_NAME      = 'draft-dispatch';

/**
 * Factory that creates a per-item draft dispatcher node.
 *
 * @param dispatcher    - The run's dispatcher instance (shared).
 * @param dagName       - Name of the per-draft deep-DAG to invoke.
 *                        Defaults to `'squashage:refine-one'`.
 * @param nodeName      - Name this node registers under on the dispatcher.
 *                        Defaults to `'draft-dispatch'`.
 */
export function createDraftDispatchNode(
  dispatcher: SquashageDagonizer<NodeStateInterface>,
  dagName  = DEFAULT_REFINE_ONE_DAG,
  nodeName = DEFAULT_NODE_NAME,
): NodeInterface<SquashageRefineRunState, Output, SquashageServices> {
  return {
    name:    nodeName,
    outputs: ['success', 'error'],
    async execute(state, context) {
      const locator = state.getMetadata('currentItem') as DraftLocator;

      const refineState = new SquashageRefineState(
        locator.draftPath,
        locator.className,
        locator.refinementPath,
        locator.subdir,
      );

      const result = await dispatcher.execute(dagName, refineState);
      const final  = result.state as SquashageRefineState;

      if (final.outcome === 'error') {
        for (const e of final.errors) {
          context.services.refineSummaries.runErrors.push(e.message);
        }
        return { output: 'error' };
      }

      if (final.outcome === 'refined')     context.services.refineSummaries.refinedCount     += 1;
      if (final.outcome === 'passthrough') context.services.refineSummaries.passthroughCount += 1;
      return { output: 'success' };
    },
  };
}
