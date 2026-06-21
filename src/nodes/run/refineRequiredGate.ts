/**
 * refine-required-gate — checks whether at least one `*.refine.json` file
 * exists under `services.schemaPaths.refinements`.
 *
 * Outputs:
 *   refinements-present — at least one *.refine.json file found
 *   refinements-absent  — directory missing, unreadable, or empty
 *
 * When absent, logs a clear operator-facing message explaining that the
 * bootstrap halted and what action to take.
 */

import { readdir } from 'node:fs/promises';

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageBootstrapState } from '../../state/SquashageBootstrapState.js';
import type { SquashageServices } from '../../services/SquashageServices.js';

type Output = 'refinements-present' | 'refinements-absent';

const REFINEMENT_SUFFIX = '.refine.json';

class RefineRequiredGateNodeImpl extends ScalarNode<SquashageBootstrapState, Output, SquashageServices> {
  public readonly name    = 'refine-required-gate';
  public readonly outputs = ['refinements-present', 'refinements-absent'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return {
      'refinements-present': { type: 'object' },
      'refinements-absent':  { type: 'object' },
    };
  }

  protected override async executeOne(
    _state:  SquashageBootstrapState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const log            = context.services.logger.forComponent('refine-required-gate');
    const refinementsDir = context.services.schemaPaths.refinements;

    let entries: string[];
    try {
      entries = await readdir(refinementsDir);
    } catch {
      log.info(
        'executeOne',
        `no refinements found under ${refinementsDir} — halting; operator: review drafts, write refinements, re-run bootstrap`,
        { refinementsDir },
      );
      return NodeOutputBuilder.of('refinements-absent');
    }

    const refinementFiles = entries.filter((name) => name.endsWith(REFINEMENT_SUFFIX));

    if (refinementFiles.length === 0) {
      log.info(
        'executeOne',
        `no refinements found under ${refinementsDir} — halting; operator: review drafts, write refinements, re-run bootstrap`,
        { refinementsDir },
      );
      return NodeOutputBuilder.of('refinements-absent');
    }

    log.info('executeOne', 'refinements present; proceeding to refine phase', {
      refinementsDir,
      count: refinementFiles.length,
    });

    return NodeOutputBuilder.of('refinements-present');
  }
}

export const refineRequiredGateNode = new RefineRequiredGateNodeImpl();
