/**
 * refineOneDag — per-draft deep-DAG registered under `'squashage:refine-one'`.
 *
 * Invoked by the `process-all-drafts` scatter, one execution per DraftLocator.
 *
 * Topology:
 *
 *   read-draft ──loaded──► read-refinement
 *              ──error ──► end
 *
 *   read-refinement ──loaded──► apply-refinement
 *                   ──missing──► refinement-missing-warn
 *                   ──error  ──► end
 *
 *   apply-refinement ──applied──► write-final
 *                    ──error  ──► end
 *
 *   refinement-missing-warn ──done──► write-final
 *
 *   write-final ──written──► end
 */

import type { DAGType } from '@studnicky/dagonizer';
import { MonadicNode } from '@studnicky/dagonizer';
import type { Batch, NodeContextType, RoutedBatchType, NodeInterface } from '@studnicky/dagonizer';
import { DAGBuilder } from '@studnicky/dagonizer/builder';

import type { SquashageRefineState } from '../state/SquashageRefineState.js';
import type { SquashageServices } from '../services/SquashageServices.js';
import { refineInitNode } from './refineInitNode.js';
import { refineSummaryCollectNode } from './refineSummaryCollectNode.js';

type StubFor<TOutput extends string> =
  NodeInterface<SquashageRefineState, TOutput, SquashageServices>;

function stub<TOutput extends string>(stubName: string, stubOutputs: readonly TOutput[]): StubFor<TOutput> {
  class Stub extends MonadicNode<SquashageRefineState, TOutput, SquashageServices> {
    public readonly name    = stubName;
    public readonly outputs = stubOutputs;
    public override get outputSchema(): Record<TOutput, { type: 'object' }> {
      return Object.fromEntries(stubOutputs.map((o) => [o, { type: 'object' }])) as Record<TOutput, { type: 'object' }>;
    }
    public override async execute(
      _b: Batch<SquashageRefineState>,
      _c: NodeContextType<SquashageServices>,
    ): Promise<RoutedBatchType<TOutput, SquashageRefineState>> {
      throw new Error(`stub '${stubName}' called; register the real node on the dispatcher`);
    }
  }
  return new Stub();
}

export const refineOneDag: DAGType = new DAGBuilder('squashage:refine-one', '1.0')
  // refine-init seeds draftPath/className/refinementPath/subdir from
  // currentItem metadata. Runs as entrypoint (not pre-phase) because scatter
  // bodies use embedded:true, which suppresses phase placements.
  .node('refine-init', refineInitNode, {
    done: 'read-draft',
  })

  .node('read-draft', stub('read-draft', ['loaded', 'error'] as const), {
    loaded: 'read-refinement',
    error:  'refine-summary-collect',
  })

  .node('read-refinement', stub('read-refinement', ['loaded', 'missing', 'error'] as const), {
    loaded:  'apply-refinement',
    missing: 'refinement-missing-warn',
    error:   'refine-summary-collect',
  })

  .node('apply-refinement', stub('apply-refinement', ['applied', 'error'] as const), {
    applied: 'write-final',
    error:   'refine-summary-collect',
  })

  .node('refinement-missing-warn', stub('refinement-missing-warn', ['done'] as const), {
    done: 'write-final',
  })

  .node('write-final', stub('write-final', ['written'] as const), {
    written: 'refine-summary-collect',
  })

  // refine-summary-collect updates services.refineSummaries counters on every
  // exit path. Placed as a regular node (not post-phase) because scatter
  // bodies run with embedded:true, which suppresses phase placements.
  .node('refine-summary-collect', refineSummaryCollectNode, {
    done: 'end',
  })

  .terminal('end')
  .entrypoint('refine-init')
  .build();
