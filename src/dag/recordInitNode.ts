/**
 * record-init — entrypoint node for `squashage:record` and
 * `squashage:record-induce`.
 *
 * Reads the `currentLocator` metadata key (a `RecordLocator`) written by the
 * scatter and seeds the per-record state fields before `json-read` runs.
 *
 * Wired as the record DAG `.node` entrypoint (`record-init` → `json-read`) on
 * both record DAGs. It is the first node each scattered record traverses;
 * errors abort the run.
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../services/SquashageServices.js';
import type { SquashageRecordState } from '../state/SquashageRecordState.js';
import type { RecordLocator } from '../state/schemas/RecordLocator.js';

type Output = 'done';

class RecordInitNodeImpl extends ScalarNode<SquashageRecordState, Output, SquashageServices> {
  public readonly name    = 'record-init';
  public readonly outputs = ['done'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { done: { type: 'object' } };
  }

  protected override async executeOne(
    state:    SquashageRecordState,
    _context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const locator = state.getMetadata<RecordLocator>('currentLocator');
    if (locator !== undefined) {
      state.recordPath = locator.recordPath;
      state.recordLine = locator.recordLine;
      state.source     = {
        target:  state.source.target,
        path:    locator.recordPath,
      };
    }
    return NodeOutputBuilder.of('done');
  }
}

export const recordInitNode = new RecordInitNodeImpl();
