/**
 * build-ready-gate — checks whether at least one `*.schema.json` file
 * exists directly under `services.schemaPaths.finals` (direct children only;
 * `inferred/` sub-directory draft files are excluded).
 *
 * Outputs:
 *   schemas-present — at least one *.schema.json direct child found
 *   schemas-absent  — directory missing, unreadable, or contains no finals
 *
 * When absent, logs a message indicating that refinement did not produce
 * expected outputs.
 */

import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageBootstrapState } from '../../state/SquashageBootstrapState.js';
import type { SquashageServices } from '../../services/SquashageServices.js';

type Output = 'schemas-present' | 'schemas-absent';

const SCHEMA_SUFFIX = '.schema.json';

export const buildReadyGateNode: NodeInterface<SquashageBootstrapState, Output, SquashageServices> = {
  name:    'build-ready-gate',
  outputs: ['schemas-present', 'schemas-absent'],

  async execute(_state, context): Promise<{ output: Output }> {
    const log      = context.services.logger.forComponent('build-ready-gate');
    const finalsDir = context.services.schemaPaths.finals;

    let entries: Dirent[];
    try {
      entries = await readdir(finalsDir, { withFileTypes: true });
    } catch {
      log.info(
        'execute',
        `no final schemas found under ${finalsDir} — refinement did not produce expected outputs`,
        { finalsDir },
      );
      return { output: 'schemas-absent' };
    }

    // Only count direct-child files (not subdirectories) ending in .schema.json.
    const schemaFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(SCHEMA_SUFFIX),
    );

    if (schemaFiles.length === 0) {
      log.info(
        'execute',
        `no final schemas found under ${finalsDir} — refinement did not produce expected outputs`,
        { finalsDir },
      );
      return { output: 'schemas-absent' };
    }

    log.info('execute', 'final schemas present; proceeding to build phase', {
      finalsDir,
      count: schemaFiles.length,
    });

    return { output: 'schemas-present' };
  },
};
