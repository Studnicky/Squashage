/**
 * registerBootstrapNodes — registers the two gate nodes used by the
 * `squashage:bootstrap` DAG on the dispatcher.
 *
 * Nodes registered here:
 *   refine-required-gate  — checks for *.refine.json under schemaPaths.refinements
 *   build-ready-gate      — checks for *.schema.json under schemaPaths.finals
 */

import type { NodeInterface, NodeStateInterface } from '@noocodex/dagonizer';

import type { SquashageDagonizer } from '../dispatcher/SquashageDagonizer.js';
import type { SquashageServices } from '../services/SquashageServices.js';
import { refineRequiredGateNode } from '../nodes/run/refineRequiredGate.js';
import { buildReadyGateNode } from '../nodes/run/buildReadyGate.js';
import { bootstrapEndNode } from './bootstrapDag.js';

export function registerBootstrapNodes(
  dispatcher: SquashageDagonizer<NodeStateInterface>,
): void {
  dispatcher.registerNode(
    refineRequiredGateNode as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
  );
  dispatcher.registerNode(
    buildReadyGateNode as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
  );
  dispatcher.registerNode(
    bootstrapEndNode as unknown as NodeInterface<NodeStateInterface, string, SquashageServices>,
  );
}
