/**
 * refineDag — run-scope DAG registered under `'squashage:refine'`.
 *
 * Topology:
 *
 *   walk-drafts ──walked──► process-all-drafts (fan-out over state.drafts,
 *               ──empty──► END (null)           dispatch node=draft-dispatch)
 *
 *   process-all-drafts ──all-success──► refine-sync-tallies
 *                      ──partial    ──► refine-sync-tallies
 *                      ──all-error  ──► refine-sync-tallies
 *                      ──empty      ──► END (null)
 *
 *   refine-sync-tallies ──synced──► END (null)
 *
 * The fan-out dispatch node is named `draft-dispatch` and is registered
 * by `SquashageRun.forTarget`. The dispatch node executes `squashage:refine-one`
 * per item and writes tallies into `SquashageServices.refineSummaries`.
 * `refine-sync-tallies` copies those tallies back to the run state so that
 * `SquashageBootstrapState` stateMapping and CLI output are correct.
 */

import type { DAG } from '@noocodex/dagonizer/entities';
import type { NodeInterface } from '@noocodex/dagonizer';
import { DAGBuilder } from '@noocodex/dagonizer/builder';

import type { SquashageRefineRunState } from '../state/SquashageRefineRunState.js';
import type { SquashageServices } from '../services/SquashageServices.js';

type StubFor<TOutput extends string> =
  NodeInterface<SquashageRefineRunState, TOutput, SquashageServices>;

function stub<TOutput extends string>(name: string, outputs: readonly TOutput[]): StubFor<TOutput> {
  return {
    name,
    outputs,
    async execute() {
      throw new Error(`stub for ${name} called; the real node must be registered on the dispatcher`);
    },
  };
}

export const refineDag: DAG = new DAGBuilder('squashage:refine', '1.0')
  .node('walk-drafts', stub('walk-drafts', ['walked', 'empty'] as const), {
    walked: 'process-all-drafts',
    empty:  null,
  })

  .fanOut(
    'process-all-drafts',
    stub('draft-dispatch', ['success', 'error'] as const),
    'drafts',
    { strategy: 'append', target: '_dispatchedItems' },
    {
      'all-success': 'refine-sync-tallies',
      partial:       'refine-sync-tallies',
      'all-error':   'refine-sync-tallies',
      empty:         null,
    },
  )

  .node('refine-sync-tallies', stub('refine-sync-tallies', ['synced'] as const), {
    synced: null,
  })

  .entrypoint('walk-drafts')
  .build();
