/**
 * refineOneDag — per-draft deep-DAG registered under `'squashage:refine-one'`.
 *
 * Invoked by the `process-all-drafts` fan-out, one execution per DraftLocator.
 *
 * Topology:
 *
 *   read-draft ──loaded──► read-refinement
 *              ──error ──► END (null)
 *
 *   read-refinement ──loaded──► apply-refinement
 *                   ──missing──► refinement-missing-warn
 *                   ──error  ──► END (null)
 *
 *   apply-refinement ──applied──► write-final
 *                    ──error  ──► END (null)
 *
 *   refinement-missing-warn ──done──► write-final
 *
 *   write-final ──written──► END (null)
 */

import type { DAG } from '@noocodex/dagonizer/entities';
import type { NodeInterface } from '@noocodex/dagonizer';
import { DAGBuilder } from '@noocodex/dagonizer/builder';

import type { SquashageRefineState } from '../state/SquashageRefineState.js';
import type { SquashageServices } from '../services/SquashageServices.js';

type StubFor<TOutput extends string> =
  NodeInterface<SquashageRefineState, TOutput, SquashageServices>;

function stub<TOutput extends string>(name: string, outputs: readonly TOutput[]): StubFor<TOutput> {
  return {
    name,
    outputs,
    async execute() {
      throw new Error(`stub for ${name} called; the real node must be registered on the dispatcher`);
    },
  };
}

export const refineOneDag: DAG = new DAGBuilder('squashage:refine-one', '1.0')
  .node('read-draft', stub('read-draft', ['loaded', 'error'] as const), {
    loaded: 'read-refinement',
    error:  null,
  })

  .node('read-refinement', stub('read-refinement', ['loaded', 'missing', 'error'] as const), {
    loaded:  'apply-refinement',
    missing: 'refinement-missing-warn',
    error:   null,
  })

  .node('apply-refinement', stub('apply-refinement', ['applied', 'error'] as const), {
    applied: 'write-final',
    error:   null,
  })

  .node('refinement-missing-warn', stub('refinement-missing-warn', ['done'] as const), {
    done: 'write-final',
  })

  .node('write-final', stub('write-final', ['written'] as const), {
    written: null,
  })

  .entrypoint('read-draft')
  .build();
