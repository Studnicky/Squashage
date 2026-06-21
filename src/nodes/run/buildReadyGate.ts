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

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageBootstrapState } from '../../state/SquashageBootstrapState.js';
import type { SquashageServices } from '../../services/SquashageServices.js';

type Output = 'schemas-present' | 'schemas-absent';

const SCHEMA_SUFFIX = '.schema.json';

class BuildReadyGateNodeImpl extends ScalarNode<SquashageBootstrapState, Output, SquashageServices> {
  public readonly name    = 'build-ready-gate';
  public readonly outputs = ['schemas-present', 'schemas-absent'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return {
      'schemas-present': { type: 'object' },
      'schemas-absent':  { type: 'object' },
    };
  }

  protected override async executeOne(
    _state:  SquashageBootstrapState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const log       = context.services.logger.forComponent('build-ready-gate');
    const finalsDir = context.services.schemaPaths.finals;

    let entries: Dirent[];
    try {
      entries = await readdir(finalsDir, { withFileTypes: true });
    } catch {
      log.info(
        'executeOne',
        `no final schemas found under ${finalsDir} — refinement did not produce expected outputs`,
        { finalsDir },
      );
      return NodeOutputBuilder.of('schemas-absent');
    }

    // Only count direct-child files (not subdirectories) ending in .schema.json.
    const schemaFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(SCHEMA_SUFFIX),
    );

    if (schemaFiles.length === 0) {
      log.info(
        'executeOne',
        `no final schemas found under ${finalsDir} — refinement did not produce expected outputs`,
        { finalsDir },
      );
      return NodeOutputBuilder.of('schemas-absent');
    }

    log.info('executeOne', 'final schemas present; proceeding to build phase', {
      finalsDir,
      count: schemaFiles.length,
    });

    return NodeOutputBuilder.of('schemas-present');
  }
}

export const buildReadyGateNode = new BuildReadyGateNodeImpl();
