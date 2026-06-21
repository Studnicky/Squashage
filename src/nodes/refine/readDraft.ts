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

import { ScalarNode, NodeOutputBuilder, NodeErrorBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';
import type { JsonObjectType } from '@studnicky/dagonizer/entities';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRefineState } from '../../state/SquashageRefineState.js';

type Output = 'loaded' | 'error';

class ReadDraftNodeImpl extends ScalarNode<SquashageRefineState, Output, SquashageServices> {
  public readonly name    = 'read-draft';
  public readonly outputs = ['loaded', 'error'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return {
      loaded: { type: 'object' },
      error:  { type: 'object' },
    };
  }

  protected override async executeOne(
    state:   SquashageRefineState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const log = context.services.logger.forComponent('read-draft');

    let text: string;
    try {
      text = await readFile(state.draftPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('executeOne', 'failed to read draft file', { draftPath: state.draftPath, message });
      state.collectError(NodeErrorBuilder.from(
        'READ_DRAFT_IO', message, 'read-draft.executeOne', false, new Date().toISOString(),
      ));
      return NodeOutputBuilder.of('error');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('executeOne', 'failed to parse draft JSON', { draftPath: state.draftPath, message });
      state.collectError(NodeErrorBuilder.from(
        'READ_DRAFT_PARSE', message, 'read-draft.executeOne', false, new Date().toISOString(),
      ));
      return NodeOutputBuilder.of('error');
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const message = 'draft is not a JSON object';
      log.error('executeOne', message, { draftPath: state.draftPath });
      state.collectError(NodeErrorBuilder.from(
        'READ_DRAFT_NOT_OBJECT', message, 'read-draft.executeOne', false, new Date().toISOString(),
      ));
      return NodeOutputBuilder.of('error');
    }

    state.draftJson = parsed as JsonObjectType;
    log.debug('executeOne', 'draft loaded', { className: state.className });
    return NodeOutputBuilder.of('loaded');
  }
}

export const readDraftNode = new ReadDraftNodeImpl();
