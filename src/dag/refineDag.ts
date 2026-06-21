/**
 * refineDag — run-scope DAG registered under `'squashage:refine'`.
 *
 * Topology:
 *
 *   walk-drafts ──walked──► process-all-drafts (scatter over state.drafts,
 *               ──empty──► end                  sub-dag=squashage:refine-one)
 *
 *   process-all-drafts ──all-success──► refine-sync-tallies
 *                      ──partial    ──► refine-sync-tallies
 *                      ──all-error  ──► refine-sync-tallies
 *                      ──empty      ──► end
 *
 *   refine-sync-tallies ──synced──► end
 *
 * The scatter invokes `squashage:refine-one` per draft item. Per-draft
 * outcomes accumulate in `services.refineSummaries` (side-effect sink)
 * so gather uses `{ strategy: 'discard' }`. The `refine-sync-tallies` node
 * reads `services.refineSummaries` and writes the totals back to run state.
 */

import type { DAGType } from '@studnicky/dagonizer';
import { MonadicNode } from '@studnicky/dagonizer';
import type { Batch, NodeContextType, RoutedBatchType, NodeInterface } from '@studnicky/dagonizer';
import { DAGBuilder } from '@studnicky/dagonizer/builder';

import type { SquashageRefineRunState } from '../state/SquashageRefineRunState.js';
import type { SquashageServices } from '../services/SquashageServices.js';

type StubFor<TOutput extends string> =
  NodeInterface<SquashageRefineRunState, TOutput, SquashageServices>;

function stub<TOutput extends string>(stubName: string, stubOutputs: readonly TOutput[]): StubFor<TOutput> {
  class Stub extends MonadicNode<SquashageRefineRunState, TOutput, SquashageServices> {
    public readonly name    = stubName;
    public readonly outputs = stubOutputs;
    public override get outputSchema(): Record<TOutput, { type: 'object' }> {
      return Object.fromEntries(stubOutputs.map((o) => [o, { type: 'object' }])) as Record<TOutput, { type: 'object' }>;
    }
    public override async execute(
      _b: Batch<SquashageRefineRunState>,
      _c: NodeContextType<SquashageServices>,
    ): Promise<RoutedBatchType<TOutput, SquashageRefineRunState>> {
      throw new Error(`stub '${stubName}' called; register the real node on the dispatcher`);
    }
  }
  return new Stub();
}

export const refineDag: DAGType = new DAGBuilder('squashage:refine', '1.0')
  .node('walk-drafts', stub('walk-drafts', ['walked', 'empty'] as const), {
    walked: 'process-all-drafts',
    empty:  'end',
  })

  .scatter(
    'process-all-drafts',
    'drafts',
    { dag: 'squashage:refine-one' },
    {
      'all-success': 'refine-sync-tallies',
      partial:       'refine-sync-tallies',
      'all-error':   'refine-sync-tallies',
      empty:         'end',
    },
    {
      gather: { strategy: 'discard' },
    },
  )

  .node('refine-sync-tallies', stub('refine-sync-tallies', ['synced'] as const), {
    synced: 'end',
  })

  .terminal('end')
  .entrypoint('walk-drafts')
  .build();
