/**
 * record-dispatch — per-item node invoked by the `process-all-records` fan-out.
 *
 * Reads `currentItem` (a `RecordLocator`) from metadata, constructs a fresh
 * `SquashageRecordState`, executes the specified record deep-DAG via the
 * dispatcher, builds a `RecordSummary`, pushes it to
 * `services.recordSummaries`, and returns `'success'` if the record was
 * squashed or `'error'` otherwise (quarantined or errored).
 *
 * The fan-out executor aggregates these into `'all-success' | 'partial' |
 * 'all-error' | 'empty'` based on whether each item returned exactly
 * `'success'`.
 */

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageDagonizer } from '../../dispatcher/SquashageDagonizer.js';
import type { SquashageServices } from '../../services/SquashageServices.js';
import { SquashageRecordState } from '../../state/SquashageRecordState.js';
import type { SquashageRunState } from '../../state/SquashageRunState.js';
import type { RecordLocator } from '../../state/schemas/RecordLocator.js';
import type { RecordSummary } from '../../state/schemas/RecordSummary.js';
import type { NodeStateInterface } from '@noocodex/dagonizer';

type Output = 'success' | 'error';

const DEFAULT_RECORD_DAG  = 'squashage:record';
const DEFAULT_NODE_NAME   = 'record-dispatch';

/**
 * Factory that creates a per-item record dispatcher node.
 *
 * @param dispatcher  - The run's dispatcher instance (shared).
 * @param dagName     - Name of the per-record deep-DAG to invoke.
 *                      Defaults to `'squashage:record'`.
 * @param nodeName    - Name this node registers under on the dispatcher.
 *                      Defaults to `'record-dispatch'`.
 */
export function createRecordDispatchNode(
  dispatcher: SquashageDagonizer<NodeStateInterface>,
  dagName  = DEFAULT_RECORD_DAG,
  nodeName = DEFAULT_NODE_NAME,
): NodeInterface<SquashageRunState, Output, SquashageServices> {
  return {
    name:    nodeName,
    outputs: ['success', 'error'],
    async execute(state, context) {
      const locator = state.getMetadata('currentItem') as RecordLocator;

      const recordState = new SquashageRecordState(
        { target: context.services.target, path: locator.recordPath },
        locator.recordPath,
        locator.recordLine,
      );

      const result = await dispatcher.execute(dagName, recordState);
      const final  = result.state as SquashageRecordState;

      let outcome: RecordSummary['outcome'];
      if (final.quarantineBucket !== null)    outcome = 'quarantined';
      else if (final.classification !== null) outcome = 'squashed';
      else                                    outcome = 'error';

      const summary: RecordSummary = {
        recordPath: locator.recordPath,
        recordLine: locator.recordLine,
        outcome,
        ...(final.classification !== null
          ? { className: final.classification.type, confidence: final.classification.confidence }
          : {}),
        quadCount: final.squashedQuads.length,
        ...(final.quarantineBucket !== null ? { quarantineBucket: final.quarantineBucket } : {}),
        ...(final.errors[0] !== undefined ? { errorMessage: final.errors[0].message } : {}),
      };
      context.services.recordSummaries.push(summary);

      return { output: outcome === 'squashed' ? 'success' : 'error' };
    },
  };
}
