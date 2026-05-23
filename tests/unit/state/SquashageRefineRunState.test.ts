import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SquashageRefineRunState } from '../../../src/state/SquashageRefineRunState.js';

const TARGET   = 'test-target';
const RUN_TIME = '2025-01-01T00:00:00.000Z';

describe('SquashageRefineRunState — construction', () => {
  it('initialises with empty/zero fields', () => {
    const state = new SquashageRefineRunState(TARGET, RUN_TIME);
    assert.deepEqual(state.drafts, []);
    assert.equal(state.refinedCount, 0);
    assert.equal(state.passthroughCount, 0);
    assert.deepEqual(state.runErrors, []);
    assert.equal(state.target, TARGET);
    assert.equal(state.runStartTime, RUN_TIME);
  });
});

describe('SquashageRefineRunState — clone', () => {
  it('clone creates an independent copy', () => {
    const state = new SquashageRefineRunState(TARGET, RUN_TIME);
    state.drafts  = [{ draftPath: '/a.draft.json', className: 'A', refinementPath: null }];
    state.refinedCount     = 3;
    state.passthroughCount = 1;
    state.runErrors        = ['oops'];

    const cloned = state.clone();
    assert.deepEqual(cloned.drafts,           state.drafts);
    assert.equal(cloned.refinedCount,         state.refinedCount);
    assert.equal(cloned.passthroughCount,     state.passthroughCount);
    assert.deepEqual(cloned.runErrors,        state.runErrors);
    assert.equal(cloned.target,               state.target);
    assert.equal(cloned.runStartTime,         state.runStartTime);

    // Mutating clone does not affect original.
    cloned.refinedCount = 99;
    cloned.runErrors.push('another');
    assert.equal(state.refinedCount, 3);
    assert.equal(state.runErrors.length, 1);
  });
});

describe('SquashageRefineRunState — snapshot / restore', () => {
  it('snapshot captures all fields; restore rehydrates them', () => {
    const state = new SquashageRefineRunState(TARGET, RUN_TIME);
    state.drafts  = [{ draftPath: '/b.draft.json', className: 'B', refinementPath: '/b.refine.json' }];
    state.refinedCount     = 2;
    state.passthroughCount = 1;
    state.runErrors        = ['err1', 'err2'];

    const snap    = state.snapshot();
    const restored = SquashageRefineRunState.restore(snap);

    assert.deepEqual(restored.drafts,           state.drafts);
    assert.equal(restored.refinedCount,         state.refinedCount);
    assert.equal(restored.passthroughCount,     state.passthroughCount);
    assert.deepEqual(restored.runErrors,        state.runErrors);
    assert.equal(restored.target,               state.target);
    assert.equal(restored.runStartTime,         state.runStartTime);
  });
});
