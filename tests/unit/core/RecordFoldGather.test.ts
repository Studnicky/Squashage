/**
 * Unit tests for RecordFoldGather.
 *
 * Tests construct the strategy directly, drive `initial` + `reduce` with
 * synthetic batches of child states, and assert that the bounded accumulators
 * in the parent SquashageRunState are correct.
 *
 * The test uses DottedPathAccessor (the runtime default) and SquashageRunState
 * as the parent state so the accessor writes land on real typed fields.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Import the file so its module-load side-effect registers the strategy.
import '../../../src/core/RecordFoldGather.js';

import { Batch, NodeStateBase } from '@studnicky/dagonizer';
import { NodeErrorBuilder } from '@studnicky/dagonizer/entities';
import type { GatherRecordType } from '@studnicky/dagonizer/contracts';
import { GatherStrategies } from '@studnicky/dagonizer/core';
import { DottedPathAccessor } from '@studnicky/dagonizer/runtime';

import { SquashageRunState } from '../../../src/state/SquashageRunState.js';
import { SquashageRecordState } from '../../../src/state/SquashageRecordState.js';
import type { RecordSummary } from '../../../src/state/schemas/RecordSummary.js';
import { RecordFoldGather } from '../../../src/core/RecordFoldGather.js';

// ── Synthetic state factories ─────────────────────────────────────────────────

const DUMMY_SOURCE = { filePath: '/test/a.json', inputSource: 'file' } as unknown as ConstructorParameters<typeof SquashageRecordState>[0];

class SyntheticRecordState extends SquashageRecordState {
  constructor(
    opts: {
      quarantineBucket?: SquashageRecordState['quarantineBucket'];
      className?: string;
      errorMsg?: string;
      recordPath?: string;
      recordLine?: number;
    } = {},
  ) {
    super(DUMMY_SOURCE, opts.recordPath ?? '/test/r.json', opts.recordLine ?? 0);
    if (opts.quarantineBucket !== undefined) {
      this.quarantineBucket = opts.quarantineBucket;
    }
    if (opts.className !== undefined) {
      this.classification = {
        type:       opts.className,
        confidence: 0.9,
        engine:     'structural',
        reasons:    ['test'],
      };
      this.squashedQuads = [{}];
    }
    if (opts.errorMsg !== undefined) {
      this.collectError(NodeErrorBuilder.from(
        'TEST_ERROR',
        opts.errorMsg,
        'test',
        false,
        new Date().toISOString(),
      ));
    }
  }
}

/** Wrap a SquashageRecordState into a GatherRecordType batch item. */
function makeGatherBatch(cloneStates: SquashageRecordState[]): Batch<GatherRecordType> {
  const items = cloneStates.map((cs, i) => ({
    id:    String(i),
    state: {
      index:           i,
      item:            undefined as unknown,
      output:          'done',
      terminalOutcome: 'completed' as const,
      cloneState:      cs,
    } satisfies GatherRecordType,
  }));
  return Batch.from(items);
}

const CONFIG = { strategy: 'squashage:record-fold' };
const ACCESSOR = new DottedPathAccessor();

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshState(): SquashageRunState {
  return new SquashageRunState('test-target', '2026-06-21T00:00:00.000Z');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('RecordFoldGather — registration', async (t) => {
  await t.test('is registered under squashage:record-fold', () => {
    const strategy = GatherStrategies.resolve('squashage:record-fold');
    assert.ok(strategy instanceof RecordFoldGather);
    assert.equal(strategy.name, 'squashage:record-fold');
  });

  await t.test('retainsRecordsForFinalize is false (compactable)', () => {
    const strategy = GatherStrategies.resolve('squashage:record-fold');
    assert.equal(strategy.retainsRecordsForFinalize, false);
  });
});

test('RecordFoldGather — initial', async (t) => {
  await t.test('seeds all fold fields to zero/empty on parent state', () => {
    const strategy = new RecordFoldGather();
    const parent   = freshState();

    strategy.initial(CONFIG, parent, ACCESSOR);

    assert.equal(parent.squashedCount,    0);
    assert.equal(parent.quarantinedCount, 0);
    assert.equal(parent.errorCount,       0);
    assert.deepEqual(parent.sampleSummaries, []);
    assert.equal(parent.perClassCounts.size, 0);
    assert.equal(parent.errorRollup.errorRecordCount, 0);
    assert.deepEqual(parent.errorRollup.sampleMessages, []);
  });
});

test('RecordFoldGather — outcome counts', async (t) => {
  await t.test('squashed records increment squashedCount', () => {
    const strategy = new RecordFoldGather();
    const parent   = freshState();
    strategy.initial(CONFIG, parent, ACCESSOR);

    const batch = makeGatherBatch([
      new SyntheticRecordState({ className: 'feat' }),
      new SyntheticRecordState({ className: 'spell' }),
    ]);
    strategy.reduce(CONFIG, batch, parent, ACCESSOR);

    assert.equal(parent.squashedCount,    2);
    assert.equal(parent.quarantinedCount, 0);
    assert.equal(parent.errorCount,       0);
  });

  await t.test('quarantined records increment quarantinedCount', () => {
    const strategy = new RecordFoldGather();
    const parent   = freshState();
    strategy.initial(CONFIG, parent, ACCESSOR);

    const batch = makeGatherBatch([
      new SyntheticRecordState({ quarantineBucket: 'conflicts' }),
      new SyntheticRecordState({ quarantineBucket: 'unknown' }),
    ]);
    strategy.reduce(CONFIG, batch, parent, ACCESSOR);

    assert.equal(parent.squashedCount,    0);
    assert.equal(parent.quarantinedCount, 2);
    assert.equal(parent.errorCount,       0);
  });

  await t.test('records with neither classification nor quarantine count as error', () => {
    const strategy = new RecordFoldGather();
    const parent   = freshState();
    strategy.initial(CONFIG, parent, ACCESSOR);

    const batch = makeGatherBatch([new SyntheticRecordState()]);
    strategy.reduce(CONFIG, batch, parent, ACCESSOR);

    assert.equal(parent.errorCount, 1);
  });

  await t.test('mixed batch: exact per-outcome counts', () => {
    const strategy = new RecordFoldGather();
    const parent   = freshState();
    strategy.initial(CONFIG, parent, ACCESSOR);

    const batch = makeGatherBatch([
      new SyntheticRecordState({ className: 'feat' }),
      new SyntheticRecordState({ className: 'feat' }),
      new SyntheticRecordState({ quarantineBucket: 'output' }),
      new SyntheticRecordState(),
    ]);
    strategy.reduce(CONFIG, batch, parent, ACCESSOR);

    assert.equal(parent.squashedCount,    2);
    assert.equal(parent.quarantinedCount, 1);
    assert.equal(parent.errorCount,       1);
  });
});

test('RecordFoldGather — per-class counts', async (t) => {
  await t.test('accumulates exact counts per className', () => {
    const strategy = new RecordFoldGather();
    const parent   = freshState();
    strategy.initial(CONFIG, parent, ACCESSOR);

    const batch = makeGatherBatch([
      new SyntheticRecordState({ className: 'feat' }),
      new SyntheticRecordState({ className: 'feat' }),
      new SyntheticRecordState({ className: 'spell' }),
    ]);
    strategy.reduce(CONFIG, batch, parent, ACCESSOR);

    assert.equal(parent.perClassCounts.get('feat'),  2);
    assert.equal(parent.perClassCounts.get('spell'), 1);
    assert.equal(parent.perClassCounts.size, 2);
  });

  await t.test('quarantined records do not contribute to perClassCounts', () => {
    const strategy = new RecordFoldGather();
    const parent   = freshState();
    strategy.initial(CONFIG, parent, ACCESSOR);

    const batch = makeGatherBatch([
      new SyntheticRecordState({ quarantineBucket: 'conflicts' }),
    ]);
    strategy.reduce(CONFIG, batch, parent, ACCESSOR);

    assert.equal(parent.perClassCounts.size, 0);
  });

  await t.test('counts accumulate correctly across multiple reduce calls', () => {
    const strategy = new RecordFoldGather();
    const parent   = freshState();
    strategy.initial(CONFIG, parent, ACCESSOR);

    strategy.reduce(CONFIG, makeGatherBatch([new SyntheticRecordState({ className: 'feat' })]), parent, ACCESSOR);
    strategy.reduce(CONFIG, makeGatherBatch([new SyntheticRecordState({ className: 'feat' })]), parent, ACCESSOR);
    strategy.reduce(CONFIG, makeGatherBatch([new SyntheticRecordState({ className: 'spell' })]), parent, ACCESSOR);

    assert.equal(parent.perClassCounts.get('feat'),  2);
    assert.equal(parent.perClassCounts.get('spell'), 1);
  });
});

test('RecordFoldGather — sample ring cap', async (t) => {
  // Build more records than the cap (200) to verify eviction.
  const CAP = 200;
  const OVER = CAP + 20;

  await t.test(`sample ring is capped at ${CAP} entries when ${OVER} records are folded`, () => {
    const strategy = new RecordFoldGather();
    const parent   = freshState();
    strategy.initial(CONFIG, parent, ACCESSOR);

    const cloneStates: SquashageRecordState[] = Array.from({ length: OVER }, (_, i) =>
      new SyntheticRecordState({ className: 'feat', recordPath: `/r/${i}.json`, recordLine: i }),
    );
    strategy.reduce(CONFIG, makeGatherBatch(cloneStates), parent, ACCESSOR);

    assert.equal(parent.sampleSummaries.length, CAP);
  });

  await t.test('sample ring retains the most-recent entries (FIFO eviction)', () => {
    const strategy = new RecordFoldGather();
    const parent   = freshState();
    strategy.initial(CONFIG, parent, ACCESSOR);

    const cloneStates: SquashageRecordState[] = Array.from({ length: OVER }, (_, i) =>
      new SyntheticRecordState({ className: 'feat', recordPath: `/r/${i}.json`, recordLine: i }),
    );
    strategy.reduce(CONFIG, makeGatherBatch(cloneStates), parent, ACCESSOR);

    // The ring holds the most-recent CAP entries (indices OVER-CAP..OVER-1).
    const firstRetained = parent.sampleSummaries[0] as RecordSummary;
    assert.equal(firstRetained.recordPath, `/r/${OVER - CAP}.json`);
    const lastRetained = parent.sampleSummaries[CAP - 1] as RecordSummary;
    assert.equal(lastRetained.recordPath, `/r/${OVER - 1}.json`);
  });
});

test('RecordFoldGather — error rollup', async (t) => {
  await t.test('records with errors increment errorRecordCount exactly', () => {
    const strategy = new RecordFoldGather();
    const parent   = freshState();
    strategy.initial(CONFIG, parent, ACCESSOR);

    const batch = makeGatherBatch([
      new SyntheticRecordState({ errorMsg: 'parse failed' }),
      new SyntheticRecordState({ errorMsg: 'schema mismatch' }),
      new SyntheticRecordState({ className: 'feat' }), // no error
    ]);
    strategy.reduce(CONFIG, batch, parent, ACCESSOR);

    assert.equal(parent.errorRollup.errorRecordCount, 2);
  });

  await t.test('distinct error messages are sampled into sampleMessages', () => {
    const strategy = new RecordFoldGather();
    const parent   = freshState();
    strategy.initial(CONFIG, parent, ACCESSOR);

    const batch = makeGatherBatch([
      new SyntheticRecordState({ errorMsg: 'err-alpha' }),
      new SyntheticRecordState({ errorMsg: 'err-beta' }),
      new SyntheticRecordState({ errorMsg: 'err-alpha' }), // duplicate — should not inflate
    ]);
    strategy.reduce(CONFIG, batch, parent, ACCESSOR);

    assert.equal(parent.errorRollup.errorRecordCount, 3);
    // Distinct messages only — 'err-alpha' is deduplicated.
    assert.deepEqual(
      [...parent.errorRollup.sampleMessages].sort(),
      ['err-alpha', 'err-beta'],
    );
  });

  await t.test('error message sample is bounded at 50 distinct messages', () => {
    const ERROR_CAP = 50;
    const OVER_CAP  = ERROR_CAP + 10;

    const strategy = new RecordFoldGather();
    const parent   = freshState();
    strategy.initial(CONFIG, parent, ACCESSOR);

    const cloneStates: SquashageRecordState[] = Array.from({ length: OVER_CAP }, (_, i) =>
      new SyntheticRecordState({ errorMsg: `unique-error-${i}` }),
    );
    strategy.reduce(CONFIG, makeGatherBatch(cloneStates), parent, ACCESSOR);

    assert.equal(parent.errorRollup.errorRecordCount, OVER_CAP);
    assert.equal(parent.errorRollup.sampleMessages.length, ERROR_CAP);
  });

  await t.test('records without errors do not affect rollup', () => {
    const strategy = new RecordFoldGather();
    const parent   = freshState();
    strategy.initial(CONFIG, parent, ACCESSOR);

    const batch = makeGatherBatch([
      new SyntheticRecordState({ className: 'feat' }),
      new SyntheticRecordState({ quarantineBucket: 'unknown' }),
    ]);
    strategy.reduce(CONFIG, batch, parent, ACCESSOR);

    assert.equal(parent.errorRollup.errorRecordCount, 0);
    assert.deepEqual(parent.errorRollup.sampleMessages, []);
  });
});

test('RecordFoldGather — state mirroring', async (t) => {
  await t.test('accessor.set mirrors are live on parent state after reduce', () => {
    const strategy = new RecordFoldGather();
    const parent   = freshState();
    strategy.initial(CONFIG, parent, ACCESSOR);

    strategy.reduce(
      CONFIG,
      makeGatherBatch([new SyntheticRecordState({ className: 'feat' })]),
      parent,
      ACCESSOR,
    );

    // Verify that the accessor-written path lands on the typed SquashageRunState field.
    assert.equal(ACCESSOR.get(parent, 'squashedCount'),    1);
    assert.equal(ACCESSOR.get(parent, 'quarantinedCount'), 0);
    assert.equal(ACCESSOR.get(parent, 'errorCount'),       0);
    assert.ok(ACCESSOR.get(parent, 'perClassCounts') instanceof Map);
    assert.ok(Array.isArray(ACCESSOR.get(parent, 'sampleSummaries')));
    const rollup = ACCESSOR.get<{ errorRecordCount: number }>(parent, 'errorRollup');
    assert.ok(rollup !== null);
    assert.equal(rollup.errorRecordCount, 0);
  });
});

test('RecordFoldGather — initial resets accumulator between executions', async (t) => {
  await t.test('calling initial after a previous run zeroes all counts', () => {
    const strategy = new RecordFoldGather();
    const parent   = freshState();

    // First run.
    strategy.initial(CONFIG, parent, ACCESSOR);
    strategy.reduce(
      CONFIG,
      makeGatherBatch([
        new SyntheticRecordState({ className: 'feat' }),
        new SyntheticRecordState({ className: 'feat' }),
      ]),
      parent,
      ACCESSOR,
    );
    assert.equal(parent.squashedCount, 2);

    // Second run on a fresh parent — initial must reset the internal accumulator.
    const parent2 = freshState();
    strategy.initial(CONFIG, parent2, ACCESSOR);
    strategy.reduce(
      CONFIG,
      makeGatherBatch([new SyntheticRecordState({ className: 'spell' })]),
      parent2,
      ACCESSOR,
    );

    assert.equal(parent2.squashedCount, 1);
    assert.equal(parent2.perClassCounts.get('spell'), 1);
    assert.equal(parent2.perClassCounts.get('feat'), undefined);
  });
});

test('RecordFoldGather — NodeStateBase.errors dependency', async (t) => {
  await t.test('NodeStateBase is importable and works as expected for test setup', () => {
    // Sanity: verify that SyntheticRecordState extends NodeStateBase.
    const s = new SyntheticRecordState({ errorMsg: 'oops' });
    assert.ok(s instanceof NodeStateBase);
    assert.equal(s.errors.length, 1);
    assert.equal(s.errors[0]?.message, 'oops');
  });
});
