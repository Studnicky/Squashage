import test from 'node:test';
import assert from 'node:assert/strict';

import { SquashageRecordState } from '../../../src/state/SquashageRecordState.js';

const source = { target: 'aonprd', path: '/r/a.json' } as const;

test('happy path', async (t) => {
  await t.test('constructs with empty slots and the supplied locator', () => {
    const state = new SquashageRecordState(source, '/r/a.json', 0);
    assert.deepEqual(state.source, source);
    assert.deepEqual(state.input, {});
    assert.deepEqual(state.proposals, {});
    assert.equal(state.classification, null);
    assert.deepEqual(state.squashedQuads, []);
    assert.equal(state.quarantineBucket, null);
    assert.equal(state.recordPath, '/r/a.json');
    assert.equal(state.recordLine, 0);
  });

  await t.test('snapshot round-trip preserves typed slots', () => {
    const state = new SquashageRecordState(source, '/r/a.json', 3);
    (state as unknown as { input: Record<string, unknown> }).input = { _type: 'feat', name: 'Power Attack' };
    state.proposals['classify:rules'] = {
      source: 'classify:rules', className: 'feat', priority: 100, confidence: 1, reasons: ['rule:r1'],
    };
    state.classification = {
      type: 'feat', confidence: 1, engine: 'rules', reasons: ['rule:r1'],
    };
    state.quarantineBucket = null;

    const snap = state.snapshot();
    const restored = SquashageRecordState.restore.call(
      SquashageRecordState as unknown as new () => SquashageRecordState,
      snap,
    );
    assert.deepEqual(restored.source, state.source);
    assert.deepEqual(restored.input, state.input);
    assert.deepEqual(restored.proposals, state.proposals);
    assert.deepEqual(restored.classification, state.classification);
    assert.equal(restored.quarantineBucket, null);
    assert.equal(restored.recordPath, '/r/a.json');
    assert.equal(restored.recordLine, 3);
  });

  await t.test('clone produces an independent SquashageRecordState instance', () => {
    const state = new SquashageRecordState(source, '/r/a.json', 0);
    state.proposals['classify:rules'] = {
      source: 'classify:rules', className: 'feat', priority: 100, confidence: 1, reasons: [],
    };
    const cloned = state.clone();
    cloned.proposals['classify:schema'] = {
      source: 'classify:schema', className: 'spell', priority: 50, confidence: 0.8, reasons: [],
    };
    assert.equal(Object.keys(state.proposals).length, 1);
    assert.equal(Object.keys(cloned.proposals).length, 2);
  });
});

test('edge cases', async (t) => {
  await t.test('quarantineBucket round-trips every valid bucket', () => {
    for (const bucket of ['unknown', 'conflicts', 'projection', 'output'] as const) {
      const state = new SquashageRecordState(source, '/r/a.json', 0);
      state.quarantineBucket = bucket;
      const restored = SquashageRecordState.restore.call(
        SquashageRecordState as unknown as new () => SquashageRecordState,
        state.snapshot(),
      );
      assert.equal(restored.quarantineBucket, bucket);
    }
  });

  await t.test('lifecycle pending → running → completed', () => {
    const state = new SquashageRecordState(source, '/r/a.json', 0);
    state.markRunning();
    assert.equal(state.lifecycle.variant, 'running');
    state.markCompleted();
    assert.equal(state.lifecycle.variant, 'completed');
  });
});

test('unhappy path', async (t) => {
  await t.test('restore ignores unknown quarantineBucket value', () => {
    const state = new SquashageRecordState(source, '/r/a.json', 0);
    const snap = { ...state.snapshot(), quarantineBucket: 'definitely-bogus' };
    const restored = SquashageRecordState.restore.call(
      SquashageRecordState as unknown as new () => SquashageRecordState,
      snap,
    );
    assert.equal(restored.quarantineBucket, null);
  });

  await t.test('illegal lifecycle transition throws DAGError', () => {
    const state = new SquashageRecordState(source, '/r/a.json', 0);
    state.markRunning();
    state.markCompleted();
    assert.throws(() => state.markFailed(new Error('boom')), /Cannot mark failed/);
  });
});
