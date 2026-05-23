/**
 * json-read — reads one record (json or single jsonl line) off disk and
 * populates `state.input` + merges any embedded `_source` block into
 * `state.source`.
 *
 * Outputs:
 *   loaded       — record parsed into state.input
 *   quarantined  — file unreadable / malformed / non-object / target mismatch
 */

import { readFile } from 'node:fs/promises';

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRecordState } from '../../state/SquashageRecordState.js';
import type { InputSource } from '../../state/schemas/InputSource.js';

type Output = 'loaded' | 'quarantined';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractRecord(rawText: string, recordLine: number): unknown {
  if (recordLine === 0) {
    try { return JSON.parse(rawText.trim()); } catch { /* fall through */ }
  }
  const lines = rawText.split('\n').filter((l) => l.trim().length > 0);
  return JSON.parse(lines[recordLine] ?? '');
}

export const jsonReadNode: NodeInterface<SquashageRecordState, Output, SquashageServices> = {
  name:    'json-read',
  outputs: ['loaded', 'quarantined'],
  async execute(state, context) {
    const log = context.services.logger.forComponent('json-read');
    const recordPath = state.recordPath;
    const recordLine = state.recordLine;

    let rawText: string;
    try {
      rawText = await readFile(recordPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.collectError({
        code: 'JSON_READ_FILE_ERROR', message,
        operation: 'json-read', recoverable: false,
        timestamp: new Date().toISOString(),
      });
      state.quarantineBucket = 'projection';
      log.warn('execute', 'unreadable input', { recordPath, message });
      return { output: 'quarantined' };
    }

    let parsed: unknown;
    try {
      parsed = extractRecord(rawText, recordLine);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.collectError({
        code: 'JSON_READ_PARSE_ERROR',
        message: `malformed JSON at ${recordPath}:${recordLine.toString()} — ${message}`,
        operation: 'json-read', recoverable: false,
        timestamp: new Date().toISOString(),
      });
      state.quarantineBucket = 'projection';
      return { output: 'quarantined' };
    }

    if (!isPlainObject(parsed)) {
      state.collectError({
        code: 'JSON_READ_NON_OBJECT',
        message: 'record is not a plain object',
        operation: 'json-read', recoverable: false,
        timestamp: new Date().toISOString(),
      });
      state.quarantineBucket = 'projection';
      return { output: 'quarantined' };
    }

    // Cross-check / merge embedded `_source`.
    const embedded = parsed['_source'];
    if (isPlainObject(embedded) && typeof embedded['target'] === 'string'
        && embedded['target'] !== state.source.target) {
      state.collectError({
        code: 'JSON_READ_TARGET_MISMATCH',
        message: `_source.target "${embedded['target']}" does not match state.source.target "${state.source.target}"`,
        operation: 'json-read', recoverable: false,
        timestamp: new Date().toISOString(),
      });
      state.quarantineBucket = 'projection';
      return { output: 'quarantined' };
    }

    if (isPlainObject(embedded)) {
      const merged: InputSource = {
        target:   state.source.target,
        path:     state.source.path,
        ...(typeof embedded['plugin']   === 'string' ? { plugin:   embedded['plugin']   } : {}),
        ...(typeof embedded['schemaId'] === 'string' ? { schemaId: embedded['schemaId'] } : {}),
      };
      state.source = merged;
    }

    (state as unknown as { input: Record<string, unknown> }).input = parsed;
    log.debug('execute', 'record loaded', { recordPath, recordLine });
    return { output: 'loaded' };
  },
};
