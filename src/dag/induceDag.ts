/**
 * induceDag — run-scope DAG registered under `'squashage:induce'`.
 *
 * Topology:
 *
 *   walk-input ─walked──► process-all-records-induce (scatter over state.locators,
 *              ─empty───► end                          sub-dag=squashage:record-induce)
 *
 *   process-all-records-induce ─all-success──► merge-shape-cache
 *                               ─partial─────► merge-shape-cache
 *                               ─all-error───► end
 *                               ─empty───────► end
 *
 *   merge-shape-cache ─merged──► induce-schemas
 *   induce-schemas ─induced──► write-drafts
 *                  ─empty───► end
 *   write-drafts ─written──► end
 *                ─skipped──► end
 *
 * The scatter fan-out invokes `squashage:record-induce` per locator item.
 * Each child DAG writes shape data into `SquashageServices.shapeCache`.
 * The scatter uses `{ strategy: 'discard' }` gather since shape accumulation
 * is a service-level side effect (not state-level gather needed here).
 */

import type { DAGType } from '@studnicky/dagonizer';
import { MonadicNode } from '@studnicky/dagonizer';
import type { Batch, NodeContextType, RoutedBatchType, NodeInterface } from '@studnicky/dagonizer';
import { DAGBuilder } from '@studnicky/dagonizer/builder';

import type { SquashageInduceRunState } from '../state/SquashageInduceRunState.js';
import type { SquashageServices } from '../services/SquashageServices.js';

type StubFor<TOutput extends string> =
  NodeInterface<SquashageInduceRunState, TOutput, SquashageServices>;

function stub<TOutput extends string>(stubName: string, stubOutputs: readonly TOutput[]): StubFor<TOutput> {
  class Stub extends MonadicNode<SquashageInduceRunState, TOutput, SquashageServices> {
    public readonly name    = stubName;
    public readonly outputs = stubOutputs;
    public override get outputSchema(): Record<TOutput, { type: 'object' }> {
      return Object.fromEntries(stubOutputs.map((o) => [o, { type: 'object' }])) as Record<TOutput, { type: 'object' }>;
    }
    public override async execute(
      _b: Batch<SquashageInduceRunState>,
      _c: NodeContextType<SquashageServices>,
    ): Promise<RoutedBatchType<TOutput, SquashageInduceRunState>> {
      throw new Error(`stub '${stubName}' called; register the real node on the dispatcher`);
    }
  }
  return new Stub();
}

export const induceDag: DAGType = new DAGBuilder('squashage:induce', '1.0')
  .node('walk-input', stub('walk-input', ['walked', 'empty'] as const), {
    walked: 'process-all-records-induce',
    empty:  'end',
  })

  .scatter(
    'process-all-records-induce',
    'locators',
    { dag: 'squashage:record-induce' },
    {
      'all-success': 'merge-shape-cache',
      partial:       'merge-shape-cache',
      'all-error':   'end',
      empty:         'end',
    },
    {
      gather:  { strategy: 'discard' },
      itemKey: 'currentLocator',
    },
  )

  .node('merge-shape-cache', stub('merge-shape-cache', ['merged'] as const), {
    merged: 'induce-schemas',
  })

  .node('induce-schemas', stub('induce-schemas', ['induced', 'empty'] as const), {
    induced: 'write-drafts',
    empty:   'end',
  })

  .node('write-drafts', stub('write-drafts', ['written', 'skipped'] as const), {
    written: 'end',
    skipped: 'end',
  })

  .terminal('end')
  .entrypoint('walk-input')
  .build();
