import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { refinementMissingWarnNode } from '../../../../src/nodes/refine/refinementMissingWarn.js';
import { SquashageRefineState } from '../../../../src/state/SquashageRefineState.js';
import type { SquashageServices } from '../../../../src/services/SquashageServices.js';

const warnMessages: string[] = [];

const noopLogger = {
  forComponent: () => ({
    debug: () => undefined,
    info:  () => undefined,
    warn:  (_op: string, msg: string) => { warnMessages.push(msg); },
    error: () => undefined,
  }),
} as unknown as SquashageServices['logger'];

function makeContext(): { services: SquashageServices } {
  return { services: { logger: noopLogger } as unknown as SquashageServices };
}

describe('refinementMissingWarnNode', () => {
  it('sets finalJson = draftJson and outcome = passthrough, outputs done', async () => {
    warnMessages.length = 0;
    const draft = { type: 'object', properties: { name: { type: 'string' } } };
    const state = new SquashageRefineState('/Feat.draft.json', 'Feat', null);
    state.draftJson = draft;

    const result = await refinementMissingWarnNode.execute(state, makeContext());

    assert.equal(result.output,  'done');
    assert.equal(state.outcome,  'passthrough');
    assert.deepEqual(state.finalJson, draft);
  });

  it('logs a warning message containing the className', async () => {
    warnMessages.length = 0;
    const state = new SquashageRefineState('/Spell.draft.json', 'Spell', null);
    state.draftJson = {};
    await refinementMissingWarnNode.execute(state, makeContext());

    assert.ok(warnMessages.some((m) => m.includes('Spell')));
  });
});
