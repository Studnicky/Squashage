/**
 * induceDag — run-scope DAG registered under `'squashage:induce'`.
 *
 * Topology:
 *
 *   walk-input ─walked──► process-all-records-induce (fan-out, dispatch node=record-dispatch-induce)
 *              ─empty───► END (null)
 *
 *   process-all-records-induce ─all-success──► merge-shape-cache
 *                               ─partial─────► merge-shape-cache
 *                               ─all-error───► END (null)
 *                               ─empty───────► END (null)
 *
 *   merge-shape-cache ─merged──► induce-schemas
 *   induce-schemas ─induced──► write-drafts
 *                  ─empty───► END (null)
 *   write-drafts ─written──► END (null)
 *                ─skipped──► END (null)
 *
 * The fan-out dispatch node is named `record-dispatch-induce` and is registered
 * by `SquashageRun.forTarget`. The dispatch node executes `squashage:record-induce`
 * per item and writes shape data into `SquashageServices.shapeCache`.
 */

import type { DAG } from '@noocodex/dagonizer/entities';
import type { NodeInterface } from '@noocodex/dagonizer';
import { DAGBuilder } from '@noocodex/dagonizer/builder';

import type { SquashageInduceRunState } from '../state/SquashageInduceRunState.js';
import type { SquashageServices } from '../services/SquashageServices.js';

type StubFor<TOutput extends string> =
  NodeInterface<SquashageInduceRunState, TOutput, SquashageServices>;

function stub<TOutput extends string>(name: string, outputs: readonly TOutput[]): StubFor<TOutput> {
  return {
    name,
    outputs,
    async execute() { throw new Error(`stub for ${name} called; the real node must be registered on the dispatcher`); },
  };
}

export const induceDag: DAG = new DAGBuilder('squashage:induce', '1.0')
  .node('walk-input', stub('walk-input', ['walked', 'empty'] as const), {
    walked: 'process-all-records-induce',
    empty:  null,
  })

  .fanOut(
    'process-all-records-induce',
    stub('record-dispatch-induce', ['success', 'error'] as const),
    'locators',
    { strategy: 'append', target: '_dispatchedItems' },
    {
      'all-success': 'merge-shape-cache',
      partial:       'merge-shape-cache',
      'all-error':   null,
      empty:         null,
    },
  )

  .node('merge-shape-cache', stub('merge-shape-cache', ['merged'] as const), {
    merged: 'induce-schemas',
  })

  .node('induce-schemas', stub('induce-schemas', ['induced', 'empty'] as const), {
    induced: 'write-drafts',
    empty:   null,
  })

  .node('write-drafts', stub('write-drafts', ['written', 'skipped'] as const), {
    written: null,
    skipped: null,
  })

  .entrypoint('walk-input')
  .build();
