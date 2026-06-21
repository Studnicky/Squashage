/**
 * refine-init — pre-phase node for `squashage:refine-one`.
 *
 * Reads the `currentItem` metadata key (a `DraftLocator`) written by the
 * scatter and seeds the per-draft state fields before `read-draft` runs.
 *
 * Registered via `.phase('refine-init', 'pre', refineInitNode)` on the
 * `squashage:refine-one` DAG. The phase runs before the entrypoint; errors
 * abort the run.
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../services/SquashageServices.js';
import type { SquashageRefineState } from '../state/SquashageRefineState.js';
import type { DraftLocator } from '../state/schemas/DraftLocator.js';

type Output = 'done';

class RefineInitNodeImpl extends ScalarNode<SquashageRefineState, Output, SquashageServices> {
  public readonly name    = 'refine-init';
  public readonly outputs = ['done'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { done: { type: 'object' } };
  }

  protected override async executeOne(
    state:    SquashageRefineState,
    _context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const locator = state.getMetadata<DraftLocator>('currentItem');
    if (locator !== undefined) {
      state.draftPath      = locator.draftPath;
      state.className      = locator.className;
      state.refinementPath = locator.refinementPath;
      state.subdir         = locator.subdir;
    }
    return NodeOutputBuilder.of('done');
  }
}

export const refineInitNode = new RefineInitNodeImpl();
