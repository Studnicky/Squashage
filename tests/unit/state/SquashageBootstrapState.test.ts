import test from 'node:test';
import assert from 'node:assert/strict';

import { SquashageBootstrapState } from '../../../src/state/SquashageBootstrapState.js';

const TARGET    = 'bootstrap-test';
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

function makeState(): SquashageBootstrapState {
  return new SquashageBootstrapState(TARGET, TIMESTAMP);
}

type Snap = Parameters<typeof SquashageBootstrapState.restore>[0];

function restore(snap: Snap): SquashageBootstrapState {
  return SquashageBootstrapState.restore.call(
    SquashageBootstrapState,
    snap,
  ) as SquashageBootstrapState;
}

test('SquashageBootstrapState — construction', async (t) => {
  await t.test('initialises with correct defaults', () => {
    const s = makeState();
    assert.equal(s.target,           TARGET);
    assert.equal(s.runStartTime,     TIMESTAMP);
    assert.equal(s.induceResult,     null);
    assert.equal(s.refineResult,     null);
    assert.equal(s.buildResult,      null);
    assert.deepEqual(s.locators,         []);
    assert.equal(s.observedRecords,  0);
    assert.deepEqual(s.discoveredClasses, []);
    assert.equal(s.inducedSchemas,         null);
    assert.equal(s.draftsWritten,    0);
    assert.deepEqual(s.drafts,           []);
    assert.equal(s.refinedCount,     0);
    assert.equal(s.passthroughCount, 0);
    assert.deepEqual(s.runErrors,        []);
    assert.deepEqual(s.results,          []);
    assert.equal(s.lifecycle.variant,   'pending');
  });
});

test('SquashageBootstrapState — clone', async (t) => {
  await t.test('clone produces an independent copy of array fields', () => {
    const s = makeState();
    s.discoveredClasses = ['Feat', 'Spell'];
    s.draftsWritten     = 2;
    s.induceResult      = { discoveredClasses: ['Feat', 'Spell'], draftsWritten: 2 };

    const c = s.clone() as SquashageBootstrapState;

    assert.deepEqual(c.discoveredClasses, ['Feat', 'Spell']);
    assert.equal(c.draftsWritten, 2);
    assert.deepEqual(c.induceResult, { discoveredClasses: ['Feat', 'Spell'], draftsWritten: 2 });

    // Mutating the clone must not affect the original.
    (c.discoveredClasses as string[]).push('Trait');
    assert.equal(s.discoveredClasses.length, 2, 'original array should be unaffected');
  });

  await t.test('clone copies numeric and null fields', () => {
    const s = makeState();
    s.refinedCount     = 3;
    s.passthroughCount = 1;
    s.refineResult     = { refinedCount: 3, passthroughCount: 1 };

    const c = s.clone() as SquashageBootstrapState;
    assert.equal(c.refinedCount,     3);
    assert.equal(c.passthroughCount, 1);
    assert.deepEqual(c.refineResult, { refinedCount: 3, passthroughCount: 1 });
  });

  await t.test('clone of null result fields stays null', () => {
    const s = makeState();
    const c = s.clone() as SquashageBootstrapState;
    assert.equal(c.induceResult, null);
    assert.equal(c.refineResult, null);
    assert.equal(c.buildResult,  null);
  });
});

test('SquashageBootstrapState — snapshot / restore', async (t) => {
  await t.test('round-trips all fields through snapshot and restore', () => {
    const s = makeState();
    s.induceResult = { discoveredClasses: ['Feat'], draftsWritten: 1 };
    s.refineResult = { refinedCount: 1, passthroughCount: 0 };
    s.discoveredClasses = ['Feat'];
    s.draftsWritten     = 1;
    s.refinedCount      = 1;
    s.runErrors         = ['some warning'];

    const snap = s.snapshot();
    const s2   = restore(snap);

    assert.equal(s2.target,        TARGET);
    assert.equal(s2.runStartTime,  TIMESTAMP);
    assert.deepEqual(s2.induceResult, { discoveredClasses: ['Feat'], draftsWritten: 1 });
    assert.deepEqual(s2.refineResult, { refinedCount: 1, passthroughCount: 0 });
    assert.equal(s2.buildResult,   null);
    assert.deepEqual(s2.discoveredClasses, ['Feat']);
    assert.equal(s2.draftsWritten, 1);
    assert.equal(s2.refinedCount,  1);
    assert.deepEqual(s2.runErrors, ['some warning']);
    assert.equal(s2.lifecycle.variant, 'pending');
  });

  await t.test('restore with null result fields preserves null', () => {
    const s  = makeState();
    const s2 = restore(s.snapshot());
    assert.equal(s2.induceResult, null);
    assert.equal(s2.refineResult, null);
    assert.equal(s2.buildResult,  null);
  });

  await t.test('restore tolerates missing optional snapshot fields', () => {
    const partial = { target: TARGET, runStartTime: TIMESTAMP } as unknown as Snap;
    const s2      = restore(partial);
    assert.equal(s2.target,        TARGET);
    assert.equal(s2.draftsWritten, 0);
    assert.deepEqual(s2.locators,  []);
    assert.deepEqual(s2.runErrors, []);
  });
});
