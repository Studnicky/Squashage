/**
 * registerRefineNodes — molecular helper for the refine DAGs.
 *
 * Registers:
 *   walk-drafts              — run-scope node (refine entry)
 *   read-draft               — per-draft node
 *   read-refinement          — per-draft node
 *   apply-refinement         — per-draft node
 *   refinement-missing-warn  — per-draft node
 *   write-final              — per-draft node
 */

import type { NodeInterface, NodeStateInterface } from '@noocodex/dagonizer';

import type { SquashageDagonizer } from '../dispatcher/SquashageDagonizer.js';
import type { SquashageServices } from '../services/SquashageServices.js';
import { walkDraftsNode } from '../nodes/run/walkDrafts.js';
import { refineSyncTalliesNode } from '../nodes/run/refineSyncTallies.js';
import { readDraftNode } from '../nodes/refine/readDraft.js';
import { readRefinementNode } from '../nodes/refine/readRefinement.js';
import { applyRefinementNode } from '../nodes/refine/applyRefinement.js';
import { refinementMissingWarnNode } from '../nodes/refine/refinementMissingWarn.js';
import { writeFinalNode } from '../nodes/refine/writeFinal.js';

export function registerRefineNodes(
  dispatcher: SquashageDagonizer<NodeStateInterface>,
): void {
  dispatcher.registerNode(
    walkDraftsNode as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
  );
  dispatcher.registerNode(
    refineSyncTalliesNode as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
  );
  dispatcher.registerNode(
    readDraftNode as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
  );
  dispatcher.registerNode(
    readRefinementNode as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
  );
  dispatcher.registerNode(
    applyRefinementNode as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
  );
  dispatcher.registerNode(
    refinementMissingWarnNode as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
  );
  dispatcher.registerNode(
    writeFinalNode as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
  );
}
