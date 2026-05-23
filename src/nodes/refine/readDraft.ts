/**
 * read-draft — reads the draft schema JSON file from disk.
 *
 * Populates `state.draftJson` on success. On any filesystem or parse error,
 * collects a structured error via `state.collectError()` and returns `'error'`.
 *
 * Outputs:
 *   loaded — draft parsed successfully into state.draftJson
 *   error  — file not found or invalid JSON
 */

import { readFile } from 'node:fs/promises';

import type { NodeInterface } from '@noocodex/dagonizer';
import type { JsonObject } from '@noocodex/dagonizer/types';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRefineState } from '../../state/SquashageRefineState.js';

type Output = 'loaded' | 'error';

export const readDraftNode: NodeInterface<SquashageRefineState, Output, SquashageServices> = {
  name:    'read-draft',
  outputs: ['loaded', 'error'],

  async execute(state, context): Promise<{ output: Output }> {
    const log = context.services.logger.forComponent('read-draft');

    let text: string;
    try {
      text = await readFile(state.draftPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('execute', 'failed to read draft file', { draftPath: state.draftPath, message });
      state.collectError({
        code:        'READ_DRAFT_IO',
        message,
        operation:   'read-draft.execute',
        recoverable: false,
        timestamp:   new Date().toISOString(),
      });
      return { output: 'error' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('execute', 'failed to parse draft JSON', { draftPath: state.draftPath, message });
      state.collectError({
        code:        'READ_DRAFT_PARSE',
        message,
        operation:   'read-draft.execute',
        recoverable: false,
        timestamp:   new Date().toISOString(),
      });
      return { output: 'error' };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const message = 'draft is not a JSON object';
      log.error('execute', message, { draftPath: state.draftPath });
      state.collectError({
        code:        'READ_DRAFT_NOT_OBJECT',
        message,
        operation:   'read-draft.execute',
        recoverable: false,
        timestamp:   new Date().toISOString(),
      });
      return { output: 'error' };
    }

    state.draftJson = parsed as JsonObject;
    log.debug('execute', 'draft loaded', { className: state.className });
    return { output: 'loaded' };
  },
};
