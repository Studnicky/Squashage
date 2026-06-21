import test from 'node:test';
import assert from 'node:assert/strict';

import { SquashageRunState } from '../../../src/state/SquashageRunState.js';

test('happy path', async (t) => {
  await t.test('constructs with empty arrays and the supplied target/timestamp', () => {
    const state = new SquashageRunState('aonprd', '2026-05-18T00:00:00Z');
    assert.deepEqual(state.locators, []);
    assert.deepEqual(state._dispatchedItems, []);
    assert.equal(state.target, 'aonprd');
    assert.equal(state.runStartTime, '2026-05-18T00:00:00Z');
    assert.equal(state.lifecycle.variant, 'pending');
  });

  await t.test('snapshot round-trip preserves locators + identity fields', () => {
    const state = new SquashageRunState('aonprd', '2026-05-18T00:00:00Z');
    state.locators.push({ recordPath: '/r/a.json', recordLine: 0 });
    state.locators.push({ recordPath: '/r/b.jsonl', recordLine: 2 });
    state._dispatchedItems.push('placeholder');
    const snap = state.snapshot();
    const restored = SquashageRunState.restore.call(SquashageRunState, snap);
    assert.deepEqual(restored.locators, state.locators);
    assert.deepEqual(restored._dispatchedItems, state._dispatchedItems);
    assert.equal(restored.target, 'aonprd');
    assert.equal(restored.runStartTime, '2026-05-18T00:00:00Z');
    assert.equal(restored.lifecycle.variant, 'pending');
  });

  await t.test('clone produces an independent SquashageRunState instance', () => {
    const state = new SquashageRunState('aonprd', '2026-05-18T00:00:00Z');
    state.locators.push({ recordPath: '/r/a.json', recordLine: 0 });
    const cloned = state.clone();
    cloned.locators.push({ recordPath: '/r/b.json', recordLine: 0 });
    assert.equal(state.locators.length, 1);
    assert.equal(cloned.locators.length, 2);
    assert.equal(cloned.target, state.target);
  });
});

test('edge cases', async (t) => {
  await t.test('restore tolerates missing optional snapshot fields', () => {
    const state = new SquashageRunState('aonprd', '2026-05-18T00:00:00Z');
    state.locators.push({ recordPath: '/r/a.json', recordLine: 0 });
    const partial = { locators: state.locators } as unknown as Record<string, unknown>;
    const restored = SquashageRunState.restore.call(
      SquashageRunState,
      partial as Parameters<typeof SquashageRunState.restore>[0],
    );
    assert.deepEqual(restored.locators, state.locators);
    assert.deepEqual(restored._dispatchedItems, []);
  });

  await t.test('lifecycle FSM transitions pending → running → completed', () => {
    const state = new SquashageRunState('aonprd', '2026-05-18T00:00:00Z');
    state.markRunning();
    assert.equal(state.lifecycle.variant, 'running');
    state.markCompleted();
    assert.equal(state.lifecycle.variant, 'completed');
  });
});

test('unhappy path', async (t) => {
  await t.test('restore ignores non-array locators/_dispatchedItems', () => {
    const garbage = { locators: 'not-an-array', _dispatchedItems: 42 } as unknown as Record<string, unknown>;
    const restored = SquashageRunState.restore.call(
      SquashageRunState,
      garbage as Parameters<typeof SquashageRunState.restore>[0],
    );
    assert.deepEqual(restored.locators, []);
    assert.deepEqual(restored._dispatchedItems, []);
  });

  await t.test('illegal lifecycle transition throws DAGError', () => {
    const state = new SquashageRunState('aonprd', '2026-05-18T00:00:00Z');
    state.markRunning();
    state.markCompleted();
    assert.throws(() => state.markCancelled('ignored'), /Cannot mark cancelled/);
    assert.equal(state.lifecycle.variant, 'completed');
  });
});
