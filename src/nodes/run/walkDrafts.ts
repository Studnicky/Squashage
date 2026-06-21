/**
 * walk-drafts — discovers draft schema files in `services.schemaPaths.inferred`.
 *
 * For every `*.draft.json` file found (including those in `primitives/` and
 * `objects/` subdirectories), derives `className` from the filename (strip
 * `.draft.json` suffix) and checks whether a matching `<className>.refine.json`
 * exists in `services.schemaPaths.refinements`.
 *
 * Extracted primitive/object drafts never have refinement files; they are
 * passed through as-is with `refinementPath: null` and `subdir` set to their
 * subdirectory name so `write-final` places them correctly.
 *
 * Produces `state.drafts: DraftLocator[]`, sorted lexicographically by
 * `draftPath` for determinism.
 *
 * Outputs:
 *   walked — at least one draft file found
 *   empty  — no draft files in the inferred directory (or directory absent)
 */

import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRefineRunState } from '../../state/SquashageRefineRunState.js';
import type { DraftLocator } from '../../state/schemas/DraftLocator.js';

type Output = 'walked' | 'empty';

const DRAFT_SUFFIX       = '.draft.json';
const REFINEMENT_SUFFIX  = '.refine.json';

/** Subdirectories under the inferred dir that contain extracted schemas. */
const EXTRACTED_SUBDIRS = ['primitives', 'objects'] as const;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectDrafts(
  dir:          string,
  refinementsDir: string,
  subdir?:      string,
): Promise<DraftLocator[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const draftFiles = entries
    .filter((name) => name.endsWith(DRAFT_SUFFIX))
    .sort();

  const locators: DraftLocator[] = [];

  for (const filename of draftFiles) {
    const className = filename.slice(0, -DRAFT_SUFFIX.length);
    const draftPath = join(dir, filename);

    // Extracted schemas in subdirs do not have refinement files.
    let refinementPath: string | null = null;
    if (subdir === undefined) {
      const refineFile    = `${className}${REFINEMENT_SUFFIX}`;
      const refinementAbs = join(refinementsDir, refineFile);
      const hasRefinement = await fileExists(refinementAbs);
      refinementPath = hasRefinement ? refinementAbs : null;
    }

    locators.push({
      draftPath,
      className,
      refinementPath,
      ...(subdir !== undefined ? { subdir } : {}),
    });
  }

  return locators;
}

class WalkDraftsNodeImpl extends ScalarNode<SquashageRefineRunState, Output, SquashageServices> {
  public readonly name    = 'walk-drafts';
  public readonly outputs = ['walked', 'empty'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return {
      walked: { type: 'object' },
      empty:  { type: 'object' },
    };
  }

  protected override async executeOne(
    state:   SquashageRefineRunState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const log            = context.services.logger.forComponent('walk-drafts');
    const inferredDir    = context.services.schemaPaths.inferred;
    const refinementsDir = context.services.schemaPaths.refinements;

    // Collect top-level class drafts.
    const topLevel = await collectDrafts(inferredDir, refinementsDir, undefined);

    if (topLevel.length === 0 && !(await fileExists(inferredDir))) {
      log.info('executeOne', 'inferred directory absent or unreadable; no drafts', {
        inferredDir,
      });
      state.drafts = [];
      return NodeOutputBuilder.of('empty');
    }

    // Collect extracted-schema drafts from subdirs.
    const extracted: DraftLocator[] = [];
    for (const sub of EXTRACTED_SUBDIRS) {
      const subPath = join(inferredDir, sub);
      const subLocators = await collectDrafts(subPath, refinementsDir, sub);
      extracted.push(...subLocators);
    }

    const locators = [...topLevel, ...extracted];

    if (locators.length === 0) {
      log.info('executeOne', 'no draft files found', { inferredDir });
      state.drafts = [];
      return NodeOutputBuilder.of('empty');
    }

    // Sort lexicographically by draftPath for determinism.
    locators.sort((a, b) => (a.draftPath < b.draftPath ? -1 : a.draftPath > b.draftPath ? 1 : 0));

    state.drafts = locators;

    log.info('executeOne', 'walk-drafts complete', {
      inferredDir,
      draftCount:       locators.length,
      classCount:       topLevel.length,
      extractedCount:   extracted.length,
      refinedCount:     locators.filter((l) => l.refinementPath !== null).length,
      passthroughCount: locators.filter((l) => l.refinementPath === null).length,
    });

    return NodeOutputBuilder.of('walked');
  }
}

export const walkDraftsNode = new WalkDraftsNodeImpl();
