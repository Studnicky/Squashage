import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SquashageRefineState } from '../../../src/state/SquashageRefineState.js';

const DRAFT_PATH = '/schemas/inferred/Feat.draft.json';
const CLASS_NAME = 'Feat';
const REFINE_PATH = '/schemas/refinements/Feat.refine.json';

describe('SquashageRefineState — construction', () => {
  it('initialises with null json fields and "error" outcome', () => {
    const state = new SquashageRefineState(DRAFT_PATH, CLASS_NAME, REFINE_PATH);
    assert.equal(state.draftPath,      DRAFT_PATH);
    assert.equal(state.className,      CLASS_NAME);
    assert.equal(state.refinementPath, REFINE_PATH);
    assert.equal(state.draftJson,      null);
    assert.equal(state.refinementJson, null);
    assert.equal(state.finalJson,      null);
    assert.equal(state.outcome,        'error');
  });

  it('accepts null refinementPath', () => {
    const state = new SquashageRefineState(DRAFT_PATH, CLASS_NAME, null);
    assert.equal(state.refinementPath, null);
  });
});

describe('SquashageRefineState — clone', () => {
  it('clone creates an independent copy', () => {
    const state = new SquashageRefineState(DRAFT_PATH, CLASS_NAME, REFINE_PATH);
    state.draftJson = { type: 'object' };
    state.outcome   = 'refined';

    const cloned = state.clone();
    assert.deepEqual(cloned.draftJson, state.draftJson);
    assert.equal(cloned.outcome,       'refined');

    // Mutating clone does not affect original.
    cloned.outcome = 'passthrough';
    assert.equal(state.outcome, 'refined');
  });
});

describe('SquashageRefineState — snapshot / restore', () => {
  it('snapshot captures all fields; restore rehydrates them', () => {
    const state = new SquashageRefineState(DRAFT_PATH, CLASS_NAME, REFINE_PATH);
    state.draftJson      = { title: 'Feat', type: 'object', properties: {} };
    state.refinementJson = { $schema: 'x', appliesTo: 'Feat' };
    state.finalJson      = { title: 'Feat', type: 'object', properties: {} };
    state.outcome        = 'refined';

    const snap     = state.snapshot();
    const restored = SquashageRefineState.restore(snap);

    assert.equal(restored.draftPath,      state.draftPath);
    assert.equal(restored.className,      state.className);
    assert.equal(restored.refinementPath, state.refinementPath);
    assert.deepEqual(restored.draftJson,      state.draftJson);
    assert.deepEqual(restored.refinementJson, state.refinementJson);
    assert.deepEqual(restored.finalJson,      state.finalJson);
    assert.equal(restored.outcome,        state.outcome);
  });

  it('restores null refinementPath', () => {
    const state = new SquashageRefineState(DRAFT_PATH, CLASS_NAME, null);
    const snap  = state.snapshot();
    const restored = SquashageRefineState.restore(snap);
    assert.equal(restored.refinementPath, null);
  });
});
