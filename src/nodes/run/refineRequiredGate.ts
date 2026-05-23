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

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageBootstrapState } from '../../state/SquashageBootstrapState.js';
import type { SquashageServices } from '../../services/SquashageServices.js';

type Output = 'refinements-present' | 'refinements-absent';

const REFINEMENT_SUFFIX = '.refine.json';

export const refineRequiredGateNode: NodeInterface<SquashageBootstrapState, Output, SquashageServices> = {
  name:    'refine-required-gate',
  outputs: ['refinements-present', 'refinements-absent'],

  async execute(_state, context): Promise<{ output: Output }> {
    const log            = context.services.logger.forComponent('refine-required-gate');
    const refinementsDir = context.services.schemaPaths.refinements;

    let entries: string[];
    try {
      entries = await readdir(refinementsDir);
    } catch {
      log.info(
        'execute',
        `no refinements found under ${refinementsDir} — halting; operator: review drafts, write refinements, re-run bootstrap`,
        { refinementsDir },
      );
      return { output: 'refinements-absent' };
    }

    const refinementFiles = entries.filter((name) => name.endsWith(REFINEMENT_SUFFIX));

    if (refinementFiles.length === 0) {
      log.info(
        'execute',
        `no refinements found under ${refinementsDir} — halting; operator: review drafts, write refinements, re-run bootstrap`,
        { refinementsDir },
      );
      return { output: 'refinements-absent' };
    }

    log.info('execute', 'refinements present; proceeding to refine phase', {
      refinementsDir,
      count: refinementFiles.length,
    });

    return { output: 'refinements-present' };
  },
};
