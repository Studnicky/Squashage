/**
 * record-quarantine — terminal node on the per-record DAG's failure path.
 *
 * Writes the record + its accumulated errors into the failed-records dump via
 * `services.quarantine.write(...)` so users can inspect what was dropped and
 * why. Routes to `null` to end the per-record execution; the parent fan-out's
 * fan-in still appends a `RecordSummary` entry with the quarantine bucket.
 */

import { createHash } from 'node:crypto';

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRecordState } from '../../state/SquashageRecordState.js';
import type { QuarantineBucket } from '../../types/QuarantineRecord.js';

type Output = 'recorded';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function computeId(path: string, line: number): string {
  return createHash('sha1').update(`${path}#${String(line)}`).digest('hex');
}

export const recordQuarantineNode: NodeInterface<SquashageRecordState, Output, SquashageServices> = {
  name:    'record-quarantine',
  outputs: ['recorded'],
  async execute(state, context) {
    const log = context.services.logger.forComponent('record-quarantine');
    const bucket: QuarantineBucket = state.quarantineBucket ?? 'projection';
    const id = computeId(state.recordPath, state.recordLine);

    const firstError = state.errors[0];
    const errorPayload = firstError !== undefined
      ? { name: firstError.code, message: firstError.message }
      : undefined;

    await context.services.quarantine.write({
      id,
      target:         context.services.target,
      bucket,
      source:         state.source,
      input:          isPlainObject(state.input) ? { ...state.input } : null,
      classification: state.classification,
      ...(errorPayload !== undefined ? { error: errorPayload } : {}),
      timestamp:      new Date().toISOString(),
    });

    log.info('execute', 'record quarantined', {
      bucket, id, recordPath: state.recordPath, recordLine: state.recordLine,
    });
    return { output: 'recorded' };
  },
};
