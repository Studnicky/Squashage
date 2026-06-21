import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Batch } from '@studnicky/dagonizer';
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

async function runNode(
  state: SquashageRefineState,
  context: { services: SquashageServices },
): Promise<string> {
  const result = await refinementMissingWarnNode.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof refinementMissingWarnNode.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

describe('refinementMissingWarnNode', () => {
  it('sets finalJson = draftJson and outcome = passthrough, outputs done', async () => {
    warnMessages.length = 0;
    const draft = { type: 'object', properties: { name: { type: 'string' } } };
    const state = new SquashageRefineState('/Feat.draft.json', 'Feat', null);
    state.draftJson = draft;

    const output = await runNode(state, makeContext());

    assert.equal(output,  'done');
    assert.equal(state.outcome,  'passthrough');
    assert.deepEqual(state.finalJson, draft);
  });

  it('logs a warning message containing the className', async () => {
    warnMessages.length = 0;
    const state = new SquashageRefineState('/Spell.draft.json', 'Spell', null);
    state.draftJson = {};
    await runNode(state, makeContext());

    assert.ok(warnMessages.some((m) => m.includes('Spell')));
  });
});
