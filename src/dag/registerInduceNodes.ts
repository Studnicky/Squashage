/**
 * registerInduceNodes — molecular helper for the induce DAG. Registers only
 * the nodes that are unique to the induce path; classification nodes, run-scope
 * walkInputNode, and processAllRecords are registered by the caller
 * (SquashageRun.forTarget) separately since they are shared.
 *
 * Nodes registered here:
 *   shape-observe           — per-record node (new in induce path)
 *   merge-shape-cache       — sync-barrier after fan-out
 *   induce-schemas          — materialize JSON Schema drafts
 *   write-drafts            — serialize draft files
 */

import type { NodeInterface, NodeStateInterface } from '@noocodex/dagonizer';

import type { SquashageDagonizer } from '../dispatcher/SquashageDagonizer.js';
import type { SquashageServices } from '../services/SquashageServices.js';
import { shapeObserveNode } from '../nodes/record/shapeObserve.js';
import { mergeShapeCacheNode } from '../nodes/run/mergeShapeCache.js';
import { induceSchemasNode } from '../nodes/run/induceSchemas.js';
import { writeDraftsNode } from '../nodes/run/writeDrafts.js';

export function registerInduceNodes(
  dispatcher: SquashageDagonizer<NodeStateInterface>,
): void {
  dispatcher.registerNode(
    shapeObserveNode as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
  );
  dispatcher.registerNode(
    mergeShapeCacheNode as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
  );
  dispatcher.registerNode(
    induceSchemasNode as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
  );
  dispatcher.registerNode(
    writeDraftsNode as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
  );
}
