import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Batch } from '@studnicky/dagonizer';
import { applyRefinementNode } from '../../../../src/nodes/refine/applyRefinement.js';
import { SquashageRefineState } from '../../../../src/state/SquashageRefineState.js';
import type { SquashageServices } from '../../../../src/services/SquashageServices.js';

const noopLogger = {
  forComponent: () => ({
    debug: () => undefined,
    info:  () => undefined,
    warn:  () => undefined,
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
  const result = await applyRefinementNode.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof applyRefinementNode.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

function makeState(
  draftJson:      Record<string, unknown> | null,
  refinementJson: Record<string, unknown> | null,
): SquashageRefineState {
  const state = new SquashageRefineState('/Feat.draft.json', 'Feat', '/Feat.refine.json');
  state.draftJson      = draftJson;
  state.refinementJson = refinementJson;
  return state;
}

describe('applyRefinementNode — null inputs', () => {
  it('returns error when draftJson is null', async () => {
    const state  = makeState(null, { $schema: 'x', appliesTo: 'Feat' });
    const output = await runNode(state, makeContext());
    assert.equal(output, 'error');
    assert.ok(state.errors.length > 0);
  });

  it('returns error when refinementJson is null', async () => {
    const state  = makeState({ type: 'object', properties: {} }, null);
    const output = await runNode(state, makeContext());
    assert.equal(output, 'error');
    assert.ok(state.errors.length > 0);
  });
});

describe('applyRefinementNode — happy path', () => {
  it('returns applied and populates finalJson', async () => {
    const draft = {
      $schema:    'https://json-schema.org/draft/2020-12/schema',
      title:      'Feat',
      type:       'object',
      properties: { name: { type: 'string' }, raw_html: { type: 'string' } },
    };
    const refinement = {
      $schema:   'https://squashage.dev/schemas/refinement.schema.json',
      appliesTo: 'Feat',
      drop:      ['/raw_html'],
    };
    const state  = makeState(draft, refinement);
    const output = await runNode(state, makeContext());
    assert.equal(output, 'applied');
    assert.ok(state.finalJson !== null);
    const props = state.finalJson['properties'] as Record<string, unknown>;
    assert.ok(!Object.prototype.hasOwnProperty.call(props, 'raw_html'));
    assert.ok(Object.prototype.hasOwnProperty.call(props, 'name'));
  });
});
