import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QuarantineWriter } from '../../../src/quarantine/QuarantineWriter.js';
import { QuarantineError } from '../../../src/errors/QuarantineError.js';
import type { QuarantineRecordInterface, QuarantineSummaryInterface } from '../../../src/types/QuarantineRecord.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<QuarantineRecordInterface> = {}): QuarantineRecordInterface {
  return {
    id:             'abc123def456',
    target:         'aonprd',
    bucket:         'unknown',
    source:         { target: 'aonprd', path: 'feat-power-attack.json' },
    input:          { name: 'Bulbasaur', ndex: 1 },
    classification: null,
    timestamp:      '2026-05-03T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let tmpDir = '';

describe('QuarantineWriter', () => {
  before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'quarantine-writer-')); });
  after(async  () => { await rm(tmpDir, { recursive: true, force: true }); });

  // -------------------------------------------------------------------------
  // forRun factory
  // -------------------------------------------------------------------------

  describe('forRun()', () => {
    it('returns a QuarantineWriter instance', () => {
      const qw = QuarantineWriter.forRun(tmpDir, 'aonprd');
      assert.ok(qw instanceof QuarantineWriter);
    });
  });

  // -------------------------------------------------------------------------
  // write() — bucket: unknown
  // -------------------------------------------------------------------------

  describe('write() — unknown bucket', () => {
    it('writes the JSON file and increments the unknown counter', async () => {
      const qw = QuarantineWriter.forRun(tmpDir, 'aonprd');
      const record = makeRecord({ bucket: 'unknown', id: 'u001' });

      await qw.write(record);

      const expectedPath = join(tmpDir, 'aonprd', 'quarantine', 'unknown', 'u001.json');
      const raw = await readFile(expectedPath, 'utf8');
      const parsed = JSON.parse(raw) as QuarantineRecordInterface;

      assert.equal(parsed.id, 'u001');
      assert.equal(parsed.bucket, 'unknown');
      assert.equal(qw.summary().unknown, 1);
    });

    it('accumulates multiple unknown records', async () => {
      const qw = QuarantineWriter.forRun(tmpDir, 'aonprd');

      await qw.write(makeRecord({ bucket: 'unknown', id: 'u-multi-1' }));
      await qw.write(makeRecord({ bucket: 'unknown', id: 'u-multi-2' }));
      await qw.write(makeRecord({ bucket: 'unknown', id: 'u-multi-3' }));

      assert.equal(qw.summary().unknown, 3);
    });
  });

  // -------------------------------------------------------------------------
  // write() — bucket: conflicts
  // -------------------------------------------------------------------------

  describe('write() — conflicts bucket', () => {
    it('writes to quarantine/conflicts/ directory', async () => {
      const qw = QuarantineWriter.forRun(tmpDir, 'aonprd');
      const record = makeRecord({ bucket: 'conflicts', id: 'c001' });

      await qw.write(record);

      const expectedPath = join(tmpDir, 'aonprd', 'quarantine', 'conflicts', 'c001.json');
      const raw = await readFile(expectedPath, 'utf8');
      const parsed = JSON.parse(raw) as QuarantineRecordInterface;

      assert.equal(parsed.bucket, 'conflicts');
      assert.equal(qw.summary().conflicts, 1);
    });
  });

  // -------------------------------------------------------------------------
  // write() — bucket: projection
  // -------------------------------------------------------------------------

  describe('write() — projection bucket', () => {
    it('writes to quarantine/projection/ directory', async () => {
      const qw = QuarantineWriter.forRun(tmpDir, 'aonprd');
      const record = makeRecord({ bucket: 'projection', id: 'p001' });

      await qw.write(record);

      const expectedPath = join(tmpDir, 'aonprd', 'quarantine', 'projection', 'p001.json');
      const raw = await readFile(expectedPath, 'utf8');
      const parsed = JSON.parse(raw) as QuarantineRecordInterface;

      assert.equal(parsed.bucket, 'projection');
      assert.equal(qw.summary().projection, 1);
    });
  });

  // -------------------------------------------------------------------------
  // write() — bucket: output (special filename)
  // -------------------------------------------------------------------------

  describe('write() — output bucket', () => {
    it('writes validation.report.json regardless of record id', async () => {
      const qw = QuarantineWriter.forRun(tmpDir, 'aonprd');
      const record = makeRecord({ bucket: 'output', id: 'some-sha-that-is-ignored' });

      await qw.write(record);

      const expectedPath = join(tmpDir, 'aonprd', 'quarantine', 'output', 'validation.report.json');
      const raw = await readFile(expectedPath, 'utf8');
      const parsed = JSON.parse(raw) as QuarantineRecordInterface;

      assert.equal(parsed.bucket, 'output');
      assert.equal(qw.summary().output, 1);
    });

    it('overwrites validation.report.json on a second write', async () => {
      const qw = QuarantineWriter.forRun(tmpDir, 'aonprd');
      const first  = makeRecord({ bucket: 'output', id: 'first',  timestamp: '2026-05-03T00:00:00.000Z' });
      const second = makeRecord({ bucket: 'output', id: 'second', timestamp: '2026-05-03T01:00:00.000Z' });

      await qw.write(first);
      await qw.write(second);

      const expectedPath = join(tmpDir, 'aonprd', 'quarantine', 'output', 'validation.report.json');
      const raw = await readFile(expectedPath, 'utf8');
      const parsed = JSON.parse(raw) as QuarantineRecordInterface;

      assert.equal(parsed.timestamp, '2026-05-03T01:00:00.000Z');
      assert.equal(qw.summary().output, 2);
    });
  });

  // -------------------------------------------------------------------------
  // summary() — zero state
  // -------------------------------------------------------------------------

  describe('summary()', () => {
    it('returns all-zero counts for a fresh instance', () => {
      const qw = QuarantineWriter.forRun(tmpDir, 'aonprd');
      const s = qw.summary();
      assert.equal(s.unknown,    0);
      assert.equal(s.conflicts,  0);
      assert.equal(s.projection, 0);
      assert.equal(s.output,     0);
    });

    it('reflects mixed bucket writes', async () => {
      const qw = QuarantineWriter.forRun(tmpDir, 'aonprd');

      await qw.write(makeRecord({ bucket: 'unknown',    id: 'mix-u' }));
      await qw.write(makeRecord({ bucket: 'conflicts',  id: 'mix-c' }));
      await qw.write(makeRecord({ bucket: 'projection', id: 'mix-p' }));

      const s = qw.summary();
      assert.equal(s.unknown,    1);
      assert.equal(s.conflicts,  1);
      assert.equal(s.projection, 1);
      assert.equal(s.output,     0);
    });
  });

  // -------------------------------------------------------------------------
  // hasFailures()
  // -------------------------------------------------------------------------

  describe('hasFailures()', () => {
    it('returns false when only unknown records exist', async () => {
      const qw = QuarantineWriter.forRun(tmpDir, 'aonprd');
      for (let i = 0; i < 5; i++) {
        await qw.write(makeRecord({ bucket: 'unknown', id: `hf-u-${i.toString()}` }));
      }
      assert.equal(qw.hasFailures(), false);
    });

    it('returns false for a completely empty instance', () => {
      const qw = QuarantineWriter.forRun(tmpDir, 'aonprd');
      assert.equal(qw.hasFailures(), false);
    });

    it('returns true when conflicts > 0', async () => {
      const qw = QuarantineWriter.forRun(tmpDir, 'aonprd');
      await qw.write(makeRecord({ bucket: 'conflicts', id: 'hf-c001' }));
      assert.equal(qw.hasFailures(), true);
    });

    it('returns true when projection > 0', async () => {
      const qw = QuarantineWriter.forRun(tmpDir, 'aonprd');
      await qw.write(makeRecord({ bucket: 'projection', id: 'hf-p001' }));
      assert.equal(qw.hasFailures(), true);
    });

    it('returns true when output > 0', async () => {
      const qw = QuarantineWriter.forRun(tmpDir, 'aonprd');
      await qw.write(makeRecord({ bucket: 'output', id: 'hf-o001' }));
      assert.equal(qw.hasFailures(), true);
    });
  });

  // -------------------------------------------------------------------------
  // exitCodeFor()
  // -------------------------------------------------------------------------

  describe('exitCodeFor()', () => {
    const zero: QuarantineSummaryInterface = { unknown: 0, conflicts: 0, projection: 0, output: 0 };

    it('returns 0 for all-zero summary with outputFailed=false', () => {
      assert.equal(QuarantineWriter.exitCodeFor(zero, false), 0);
    });

    it('returns 1 for all-zero summary with outputFailed=true', () => {
      assert.equal(QuarantineWriter.exitCodeFor(zero, true), 1);
    });

    it('returns 0 for unknown-only summary with outputFailed=false', () => {
      const s: QuarantineSummaryInterface = { unknown: 5, conflicts: 0, projection: 0, output: 0 };
      assert.equal(QuarantineWriter.exitCodeFor(s, false), 0);
    });

    it('returns 1 for conflicts > 0', () => {
      const s: QuarantineSummaryInterface = { unknown: 0, conflicts: 1, projection: 0, output: 0 };
      assert.equal(QuarantineWriter.exitCodeFor(s, false), 1);
    });

    it('returns 1 for projection > 0', () => {
      const s: QuarantineSummaryInterface = { unknown: 0, conflicts: 0, projection: 2, output: 0 };
      assert.equal(QuarantineWriter.exitCodeFor(s, false), 1);
    });

    it('returns 1 for output > 0', () => {
      const s: QuarantineSummaryInterface = { unknown: 0, conflicts: 0, projection: 0, output: 1 };
      assert.equal(QuarantineWriter.exitCodeFor(s, false), 1);
    });

    it('returns 1 for mixed failure buckets with outputFailed=false', () => {
      const s: QuarantineSummaryInterface = { unknown: 3, conflicts: 1, projection: 1, output: 0 };
      assert.equal(QuarantineWriter.exitCodeFor(s, false), 1);
    });

    it('returns 1 for unknown-only summary with outputFailed=true', () => {
      const s: QuarantineSummaryInterface = { unknown: 10, conflicts: 0, projection: 0, output: 0 };
      assert.equal(QuarantineWriter.exitCodeFor(s, true), 1);
    });
  });

  // -------------------------------------------------------------------------
  // QuarantineError — thrown on I/O failure
  // -------------------------------------------------------------------------

  describe('write() — I/O failure', () => {
    it('throws QuarantineError when the target path is a file, not a directory', async () => {
      const qw = QuarantineWriter.forRun('/dev/null', 'aonprd');
      const record = makeRecord({ bucket: 'unknown', id: 'io-fail' });

      await assert.rejects(
        () => qw.write(record),
        (err: unknown) => {
          assert.ok(err instanceof QuarantineError, 'Expected QuarantineError');
          assert.equal(err.code, 'QUARANTINE_ERROR');
          return true;
        },
      );
    });
  });
});
