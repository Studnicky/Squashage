/**
 * NoOpClassifierNode — placeholder registered under a classifier's name when
 * that classifier has no config for the current target. Returns `'no-match'`
 * unconditionally so the parallel placement collects cleanly without
 * requiring a dynamic DAG.
 *
 * Keeps the static `recordDag` invariant: every classifier name in
 * `classifyAllParallelMembers` is always registered on the dispatcher.
 */

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageServices } from '../../../services/SquashageServices.js';
import type { SquashageRecordState } from '../../../state/SquashageRecordState.js';

type Output = 'proposed' | 'no-match' | 'validated' | 'narrowed' | 'no-op';

export class NoOpClassifierNode
  implements NodeInterface<SquashageRecordState, Output, SquashageServices> {

  readonly name:    string;
  readonly outputs: readonly Output[];

  constructor(name: string, outputs: readonly Output[]) {
    this.name    = name;
    this.outputs = outputs;
  }

  async execute(
    _state:   SquashageRecordState,
    _context: { readonly services: SquashageServices },
  ): Promise<{ output: Output }> {
    return { output: this.outputs.includes('no-match') ? 'no-match' as Output : (this.outputs[0] as Output) };
  }
}
