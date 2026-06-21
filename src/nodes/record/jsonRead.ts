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

import { ScalarNode, NodeOutputBuilder, NodeErrorBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

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

class JsonReadNodeImpl extends ScalarNode<SquashageRecordState, Output, SquashageServices> {
  public readonly name    = 'json-read';
  public readonly outputs = ['loaded', 'quarantined'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { loaded: { type: 'object' }, quarantined: { type: 'object' } };
  }

  protected override async executeOne(
    state:   SquashageRecordState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const log = context.services.logger.forComponent('json-read');
    const recordPath = state.recordPath;
    const recordLine = state.recordLine;

    let rawText: string;
    try {
      rawText = await readFile(recordPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.collectError(NodeErrorBuilder.from(
        'JSON_READ_FILE_ERROR', message, 'json-read', false, new Date().toISOString(),
      ));
      state.quarantineBucket = 'projection';
      log.warn('executeOne', 'unreadable input', { recordPath, message });
      return NodeOutputBuilder.of('quarantined');
    }

    let parsed: unknown;
    try {
      parsed = extractRecord(rawText, recordLine);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.collectError(NodeErrorBuilder.from(
        'JSON_READ_PARSE_ERROR',
        `malformed JSON at ${recordPath}:${recordLine.toString()} — ${message}`,
        'json-read', false, new Date().toISOString(),
      ));
      state.quarantineBucket = 'projection';
      return NodeOutputBuilder.of('quarantined');
    }

    if (!isPlainObject(parsed)) {
      state.collectError(NodeErrorBuilder.from(
        'JSON_READ_NON_OBJECT', 'record is not a plain object',
        'json-read', false, new Date().toISOString(),
      ));
      state.quarantineBucket = 'projection';
      return NodeOutputBuilder.of('quarantined');
    }

    // Cross-check / merge embedded `_source`.
    const embedded = parsed['_source'];
    if (isPlainObject(embedded) && typeof embedded['target'] === 'string'
        && embedded['target'] !== state.source.target) {
      state.collectError(NodeErrorBuilder.from(
        'JSON_READ_TARGET_MISMATCH',
        `_source.target "${embedded['target']}" does not match state.source.target "${state.source.target}"`,
        'json-read', false, new Date().toISOString(),
      ));
      state.quarantineBucket = 'projection';
      return NodeOutputBuilder.of('quarantined');
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

    state.input = parsed;
    log.debug('executeOne', 'record loaded', { recordPath, recordLine });
    return NodeOutputBuilder.of('loaded');
  }
}

export const jsonReadNode = new JsonReadNodeImpl();
