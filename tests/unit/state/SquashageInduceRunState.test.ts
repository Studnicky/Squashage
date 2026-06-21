import test from 'node:test';
import assert from 'node:assert/strict';

import { SquashageInduceRunState } from '../../../src/state/SquashageInduceRunState.js';

const TARGET    = 'test';
const TIMESTAMP = '2026-05-18T00:00:00Z';

test('happy path', async (t) => {
  await t.test('constructs with zero-value defaults and supplied identity fields', () => {
    const state = new SquashageInduceRunState(TARGET, TIMESTAMP);
    assert.deepEqual(state.locators,          []);
    assert.equal(state.observedRecords,       0);
    assert.deepEqual(state.discoveredClasses, []);
    assert.equal(state.inducedSchemas,         null);
    assert.equal(state.draftsWritten,         0);
    assert.equal(state.target,                TARGET);
    assert.equal(state.runStartTime,          TIMESTAMP);
    assert.equal(state.lifecycle.variant,        'pending');
  });

  await t.test('snapshot round-trip preserves all fields', () => {
    const state = new SquashageInduceRunState(TARGET, TIMESTAMP);
    state.locators.push({ recordPath: '/a.json', recordLine: 0 });
    state.observedRecords   = 42;
    state.discoveredClasses = ['Feat', 'Spell'];
    state.inducedSchemas    = {
      classes:    [{ className: 'Feat', schemaId: 'https://example.org/Feat.draft.json', kind: 'class', schema: { '$id': 'x' } }],
      primitives: [],
      objects:    [],
    };
    state.draftsWritten     = 1;

    const snap     = state.snapshot();
    const restored = SquashageInduceRunState.restore.call(SquashageInduceRunState, snap);

    assert.deepEqual(restored.locators,          state.locators);
    assert.equal(restored.observedRecords,        state.observedRecords);
    assert.deepEqual(restored.discoveredClasses,  state.discoveredClasses);
    assert.ok(restored.inducedSchemas !== null, 'inducedSchemas should be restored');
    assert.equal(restored.inducedSchemas?.classes.length,    1);
    assert.equal(restored.inducedSchemas?.primitives.length, 0);
    assert.equal(restored.inducedSchemas?.objects.length,    0);
    assert.equal(restored.draftsWritten,          1);
    assert.equal(restored.target,                 TARGET);
    assert.equal(restored.runStartTime,           TIMESTAMP);
    assert.equal(restored.lifecycle.variant,         'pending');
  });

  await t.test('clone produces an independent instance', () => {
    const state = new SquashageInduceRunState(TARGET, TIMESTAMP);
    state.locators.push({ recordPath: '/a.json', recordLine: 0 });
    state.discoveredClasses = ['Feat'];
    state.observedRecords   = 10;
    state.draftsWritten     = 1;

    const cloned = state.clone();
    // Mutation of cloned array must not affect original.
    (cloned.locators as Array<{ recordPath: string; recordLine: number }>).push({ recordPath: '/b.json', recordLine: 0 });
    (cloned.discoveredClasses as string[]).push('Spell');

    assert.equal(state.locators.length,          1);
    assert.equal(state.discoveredClasses.length, 1);
    assert.equal(cloned.locators.length,         2);
    assert.equal(cloned.discoveredClasses.length, 2);
    assert.equal(cloned.target,                  state.target);
    assert.equal(cloned.runStartTime,            state.runStartTime);
    assert.equal(cloned.observedRecords,         state.observedRecords);
    assert.equal(cloned.draftsWritten,           state.draftsWritten);
  });
});

test('edge cases', async (t) => {
  await t.test('restore tolerates missing optional snapshot fields', () => {
    const state  = new SquashageInduceRunState(TARGET, TIMESTAMP);
    state.locators.push({ recordPath: '/a.json', recordLine: 0 });
    const partial = { locators: state.locators } as unknown as Record<string, unknown>;
    const restored = SquashageInduceRunState.restore.call(
      SquashageInduceRunState,
      partial as Parameters<typeof SquashageInduceRunState.restore>[0],
    );
    assert.deepEqual(restored.locators,          state.locators);
    assert.equal(restored.observedRecords,       0);
    assert.deepEqual(restored.discoveredClasses, []);
    assert.equal(restored.draftsWritten,         0);
  });

  await t.test('lifecycle FSM transitions pending → running → completed', () => {
    const state = new SquashageInduceRunState(TARGET, TIMESTAMP);
    state.markRunning();
    assert.equal(state.lifecycle.variant, 'running');
    state.markCompleted();
    assert.equal(state.lifecycle.variant, 'completed');
  });
});

test('unhappy path', async (t) => {
  await t.test('restore ignores non-array locators/discoveredClasses', () => {
    const garbage = { locators: 'not-an-array', discoveredClasses: 42 } as unknown as Record<string, unknown>;
    const restored = SquashageInduceRunState.restore.call(
      SquashageInduceRunState,
      garbage as Parameters<typeof SquashageInduceRunState.restore>[0],
    );
    assert.deepEqual(restored.locators,          []);
    assert.deepEqual(restored.discoveredClasses, []);
  });
});
