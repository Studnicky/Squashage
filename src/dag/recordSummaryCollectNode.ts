/**
 * record-summary-collect — post-phase node for `squashage:record`.
 *
 * After the per-record pipeline completes (success or quarantine), reads the
 * final `SquashageRecordState` and pushes a `RecordSummary` to
 * `services.recordSummaries`. This replicates the summary-collection
 * responsibility that the old `recordDispatch` node performed.
 *
 * Registered via `.phase('record-summary-collect', 'post', recordSummaryCollectNode)`.
 * Post-phase runs on every exit path; errors are collected as warnings and do
 * not change the already-set lifecycle.
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../services/SquashageServices.js';
import type { SquashageRecordState } from '../state/SquashageRecordState.js';
import type { RecordSummary } from '../state/schemas/RecordSummary.js';

type Output = 'done';

class RecordSummaryCollectNodeImpl extends ScalarNode<SquashageRecordState, Output, SquashageServices> {
  public readonly name    = 'record-summary-collect';
  public readonly outputs = ['done'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { done: { type: 'object' } };
  }

  protected override async executeOne(
    state:   SquashageRecordState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    let outcome: RecordSummary['outcome'];
    if (state.quarantineBucket !== null)    outcome = 'quarantined';
    else if (state.classification !== null) outcome = 'squashed';
    else                                    outcome = 'error';

    const summary: RecordSummary = {
      recordPath: state.recordPath,
      recordLine: state.recordLine,
      outcome,
      ...(state.classification !== null
        ? { className: state.classification.type, confidence: state.classification.confidence }
        : {}),
      quadCount: state.squashedQuads.length,
      ...(state.quarantineBucket !== null ? { quarantineBucket: state.quarantineBucket } : {}),
      ...(state.errors[0] !== undefined ? { errorMessage: state.errors[0].message } : {}),
    };
    context.services.recordSummaries.push(summary);
    return NodeOutputBuilder.of('done');
  }
}

export const recordSummaryCollectNode = new RecordSummaryCollectNodeImpl();
