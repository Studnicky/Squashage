/**
 * registerRunNodes — molecular helper for the run-scope DAG. Every node here
 * is a const-literal stateless node, registered as-is on the dispatcher.
 */

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageDagonizer } from '../dispatcher/SquashageDagonizer.js';
import type { SquashageServices } from '../services/SquashageServices.js';
import { catalogEmitNode } from '../nodes/run/catalogEmit.js';
import { enrichEntityLinkNode } from '../nodes/run/enrichEntityLink.js';
import { ontologyEmitNode } from '../nodes/run/ontologyEmit.js';
import { rdfjsFinalizeNode } from '../nodes/run/rdfjsFinalize.js';
import { walkInputNode } from '../nodes/run/walkInput.js';
import type { SquashageRunState } from '../state/SquashageRunState.js';

export function registerRunNodes(
  dispatcher: SquashageDagonizer<SquashageRunState>,
): void {
  dispatcher.registerNode(walkInputNode as unknown as NodeInterface<SquashageRunState, string, SquashageServices>);
  dispatcher.registerNode(enrichEntityLinkNode as unknown as NodeInterface<SquashageRunState, string, SquashageServices>);
  dispatcher.registerNode(ontologyEmitNode as unknown as NodeInterface<SquashageRunState, string, SquashageServices>);
  dispatcher.registerNode(rdfjsFinalizeNode as unknown as NodeInterface<SquashageRunState, string, SquashageServices>);
  dispatcher.registerNode(catalogEmitNode as unknown as NodeInterface<SquashageRunState, string, SquashageServices>);
}
