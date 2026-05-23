/**
 * classify:source — emits a `__source__` metadata-gate proposal when the
 * record carries a `_source` block. Never proposes a class; the conflict
 * resolver filters this sentinel before picking a winner.
 *
 * Stateless — const literal node.
 */

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageServices } from '../../../services/SquashageServices.js';
import type { SquashageRecordState } from '../../../state/SquashageRecordState.js';

type Output = 'proposed' | 'no-match';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const sourceClassifierNode: NodeInterface<SquashageRecordState, Output, SquashageServices> = {
  name:    'classify:source',
  outputs: ['proposed', 'no-match'],
  async execute(state, _context) {
    const raw = state.input['_source'];
    if (!isPlainObject(raw)) {
      return { output: 'no-match' };
    }

    const reasons: string[] = [];
    if (typeof raw['target']   === 'string') reasons.push(`source.target=${raw['target']}`);
    if (typeof raw['plugin']   === 'string') reasons.push(`source.plugin=${raw['plugin']}`);
    if (typeof raw['schemaId'] === 'string') reasons.push(`source.schemaId=${raw['schemaId']}`);

    state.proposals['classify:source'] = {
      source:     'classify:source',
      className:  '__source__',
      priority:   0,
      confidence: 1,
      reasons,
    };
    return { output: 'proposed' };
  },
};
