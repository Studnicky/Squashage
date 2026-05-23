/**
 * catalog-emit — placeholder. Writes the per-target catalog manifest after
 * the success graph is on disk. The full algorithm lives in
 * `src/tasks/emitCatalog.ts`. Currently a pass-through so the run-scope DAG
 * wires correctly; full port queued.
 */

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRunState } from '../../state/SquashageRunState.js';

type Output = 'emitted' | 'skipped';

export const catalogEmitNode: NodeInterface<SquashageRunState, Output, SquashageServices> = {
  name:    'catalog-emit',
  outputs: ['emitted', 'skipped'],
  async execute(_state, context) {
    const bucketing = (context.services.output as Record<string, unknown>)['bucketing'];
    if (bucketing === undefined) return { output: 'skipped' };
    return { output: 'skipped' };
  },
};
