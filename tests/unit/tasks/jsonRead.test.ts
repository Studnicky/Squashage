import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskRegistry } from '../../../src/registry/TaskRegistry.js';
import type { PipelineStateInterface, PipelineContextInterface } from '../../../src/types/PipelineState.js';
import { TASK_NAME } from '../../../src/tasks/jsonRead.js';

// Side-effect import that registers `json:read`.
import '../../../src/tasks/jsonRead.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal PipelineContextInterface for tests (sans RDF fields). */
type TestContext = Pick<PipelineContextInterface, 'target' | 'outDir' | 'config'>;

/** Builds a minimal PipelineStateInterface for `json:read` tests. */
const buildState = (
  outDir:  string,
  config:  Record<string, unknown> = {},
  partial: Partial<Pick<PipelineStateInterface, 'source' | 'input'>> = {},
): PipelineStateInterface => {
  const source  = partial.source ?? { target: 'unit-target', path: 'fixture.json' };
  const input   = partial.input  ?? {};
  const context: TestContext = { target: 'unit-target', outDir, config };
  return {
    targetId:        'unit-target',
    source,
    input,
    classification:  null,
    classifications: [],
    output:          null,
    context:         context as unknown as PipelineContextInterface,
  };
};

/** Returns a sorted list of filenames inside a directory, or [] if absent. */
const listDir = async (dirPath: string): Promise<string[]> => {
  try {
    return (await readdir(dirPath)).sort();
  } catch {
    return [];
  }
};

/** Terminal next — never called in success assertions. */
const noopNext = async (): Promise<void> => { /* no-op */ };

// ---------------------------------------------------------------------------
// Suite-level tmp directory (each test gets its own subdir)
// ---------------------------------------------------------------------------

let suiteDir = '';

describe('json:read', () => {
  before(async () => {
    suiteDir = await mkdtemp(join(tmpdir(), 'json-read-test-'));
  });

  after(async () => {
    await rm(suiteDir, { recursive: true, force: true });
  });

  // Each test uses its own isolated directory to avoid file collisions.
  let testDir = '';
  beforeEach(async () => {
    testDir = await mkdtemp(join(suiteDir, 'case-'));
  });

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  describe('registration', () => {
    it('registers json:read at module load', () => {
      assert.equal(TaskRegistry.has(TASK_NAME), true);
    });

    it('TASK_NAME constant equals "json:read"', () => {
      assert.equal(TASK_NAME, 'json:read');
    });
  });

  // -------------------------------------------------------------------------
  // Successful single-file JSON read
  // -------------------------------------------------------------------------

  describe('single-file JSON', () => {
    it('populates state.input from a plain JSON file and calls next()', async () => {
      const recordPath = join(testDir, 'power-attack.json');
      const record     = { _type: 'feat', name: 'Power Attack', level: 1 };
      await writeFile(recordPath, JSON.stringify(record), 'utf8');

      let nextCalled = false;
      const trackNext = async (): Promise<void> => { nextCalled = true; };

      const state = buildState(testDir, { recordPath });
      const task  = TaskRegistry.get(TASK_NAME);
      await task(trackNext, state);

      assert.ok(nextCalled,              'next() should have been called');
      assert.equal(state.input['name'],  'Power Attack');
      assert.equal(state.input['level'], 1);
      assert.equal(state.input['_type'], 'feat');
    });

    it('does not write any quarantine file on a valid object record', async () => {
      const recordPath = join(testDir, 'valid.json');
      await writeFile(recordPath, JSON.stringify({ hello: 'world' }), 'utf8');

      const state = buildState(testDir, { recordPath });
      const task  = TaskRegistry.get(TASK_NAME);
      await task(noopNext, state);

      const projectionDir = join(testDir, 'unit-target', 'quarantine', 'projection');
      const files = await listDir(projectionDir);
      assert.equal(files.length, 0, 'no quarantine files should be written on success');
    });
  });

  // -------------------------------------------------------------------------
  // JSONL record selection
  // -------------------------------------------------------------------------

  describe('JSONL line selection', () => {
    it('reads the record at recordLine:1 from a JSONL file', async () => {
      const recordPath = join(testDir, 'records.jsonl');
      const lines = [
        JSON.stringify({ level: 1, name: 'Power Attack' }),
        JSON.stringify({ level: 2, name: 'Quick Draw'  }),
        JSON.stringify({ level: 3, name: 'Toughness'   }),
      ].join('\n');
      await writeFile(recordPath, lines, 'utf8');

      let nextCalled = false;
      const trackNext = async (): Promise<void> => { nextCalled = true; };

      const state = buildState(testDir, { recordPath, recordLine: 1 });
      const task  = TaskRegistry.get(TASK_NAME);
      await task(trackNext, state);

      assert.ok(nextCalled,            'next() should have been called for valid JSONL record');
      assert.equal(state.input['level'], 2);
      assert.equal(state.input['name'], 'Quick Draw');
    });

    it('defaults to line 0 when recordLine is not specified', async () => {
      const recordPath = join(testDir, 'records-default.jsonl');
      const lines = [
        JSON.stringify({ level: 1, name: 'Power Attack' }),
        JSON.stringify({ level: 2, name: 'Quick Draw'   }),
      ].join('\n');
      await writeFile(recordPath, lines, 'utf8');

      let nextCalled = false;
      const trackNext = async (): Promise<void> => { nextCalled = true; };

      const state = buildState(testDir, { recordPath });
      const task  = TaskRegistry.get(TASK_NAME);
      await task(trackNext, state);

      assert.ok(nextCalled,            'next() should have been called');
      assert.equal(state.input['level'], 1);
      assert.equal(state.input['name'], 'Power Attack');
    });
  });

  // -------------------------------------------------------------------------
  // Malformed JSON — quarantine + no next()
  // -------------------------------------------------------------------------

  describe('malformed JSON', () => {
    it('quarantines the record and does NOT call next() when JSON is invalid', async () => {
      const recordPath = join(testDir, 'bad.json');
      await writeFile(recordPath, '{ not valid json <<<', 'utf8');

      let nextCalled = false;
      const trackNext = async (): Promise<void> => { nextCalled = true; };

      const state = buildState(testDir, { recordPath });
      const task  = TaskRegistry.get(TASK_NAME);
      await task(trackNext, state);

      assert.ok(!nextCalled, 'next() must NOT be called for malformed JSON');

      const projectionDir = join(testDir, 'unit-target', 'quarantine', 'projection');
      const files = await listDir(projectionDir);
      assert.equal(files.length, 1, 'exactly one quarantine file should be written');
      assert.ok(files[0]?.endsWith('.json'), 'quarantine file should have .json extension');
    });
  });

  // -------------------------------------------------------------------------
  // Missing file — quarantine + no next()
  // -------------------------------------------------------------------------

  describe('missing file', () => {
    it('quarantines the record and does NOT call next() when the file does not exist', async () => {
      const recordPath = join(testDir, 'does-not-exist-at-all.json');

      let nextCalled = false;
      const trackNext = async (): Promise<void> => { nextCalled = true; };

      const state = buildState(testDir, { recordPath });
      const task  = TaskRegistry.get(TASK_NAME);
      await task(trackNext, state);

      assert.ok(!nextCalled, 'next() must NOT be called for a missing file');

      const projectionDir = join(testDir, 'unit-target', 'quarantine', 'projection');
      const files = await listDir(projectionDir);
      assert.ok(files.length >= 1, 'at least one quarantine file should be written for missing file');
    });
  });

  // -------------------------------------------------------------------------
  // Non-object record (e.g. array) — quarantine + no next()
  // -------------------------------------------------------------------------

  describe('non-object record', () => {
    it('quarantines an array record and does NOT call next()', async () => {
      const recordPath = join(testDir, 'array.json');
      await writeFile(recordPath, JSON.stringify([1, 2, 3]), 'utf8');

      let nextCalled = false;
      const trackNext = async (): Promise<void> => { nextCalled = true; };

      const state = buildState(testDir, { recordPath });
      const task  = TaskRegistry.get(TASK_NAME);
      await task(trackNext, state);

      assert.ok(!nextCalled, 'next() must NOT be called for array record');

      const projectionDir = join(testDir, 'unit-target', 'quarantine', 'projection');
      const files = await listDir(projectionDir);
      assert.ok(files.length >= 1, 'quarantine file should be written for non-object record');
    });

    it('quarantine record contains reason "json:read: record is not an object"', async () => {
      const recordPath = join(testDir, 'array-msg.json');
      await writeFile(recordPath, JSON.stringify([1, 2, 3]), 'utf8');

      const state = buildState(testDir, { recordPath });
      const task  = TaskRegistry.get(TASK_NAME);
      await task(noopNext, state);

      const projectionDir = join(testDir, 'unit-target', 'quarantine', 'projection');
      const files = await listDir(projectionDir);
      assert.ok(files.length >= 1, 'quarantine file expected');

      const content = await readFile(join(projectionDir, files[0]!), 'utf8');
      const qr = JSON.parse(content) as { error?: { message?: string } };
      assert.ok(
        qr.error?.message?.includes('json:read: record is not an object'),
        `quarantine message should reference "json:read: record is not an object"; got: ${qr.error?.message ?? ''}`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Pass-through when state.input is already populated
  // -------------------------------------------------------------------------

  describe('pass-through', () => {
    it('calls next() immediately when input is pre-populated and recordPath is absent', async () => {
      let nextCalled = false;
      const trackNext = async (): Promise<void> => { nextCalled = true; };

      const state = buildState(testDir, {}, { input: { _type: 'feat', name: 'Power Attack' } });
      const task  = TaskRegistry.get(TASK_NAME);
      await task(trackNext, state);

      assert.ok(nextCalled,                    'next() should be called in pass-through mode');
      assert.equal(state.input['name'], 'Power Attack');
    });
  });

  // -------------------------------------------------------------------------
  // _source merging
  // -------------------------------------------------------------------------

  describe('_source merging', () => {
    it('merges plugin and schemaId from _source into state.source', async () => {
      const recordPath = join(testDir, 'with-source.json');
      const record = {
        _type:   'feat',
        name:    'Power Attack',
        _source: { target: 'unit-target', plugin: 'aonprd:parse', schemaId: 'feat-v1' },
      };
      await writeFile(recordPath, JSON.stringify(record), 'utf8');

      let nextCalled = false;
      const trackNext = async (): Promise<void> => { nextCalled = true; };

      const state = buildState(testDir, { recordPath });
      const task  = TaskRegistry.get(TASK_NAME);
      await task(trackNext, state);

      assert.ok(nextCalled,                        'next() should be called');
      assert.equal(state.source.plugin,   'aonprd:parse');
      assert.equal(state.source.schemaId, 'feat-v1');
    });

    it('quarantines when _source.target mismatches state.source.target', async () => {
      const recordPath = join(testDir, 'bad-target.json');
      const record = {
        name:    'Mew',
        _source: { target: 'wrong-target', plugin: 'some:plugin' },
      };
      await writeFile(recordPath, JSON.stringify(record), 'utf8');

      let nextCalled = false;
      const trackNext = async (): Promise<void> => { nextCalled = true; };

      const state = buildState(testDir, { recordPath });
      const task  = TaskRegistry.get(TASK_NAME);
      await task(trackNext, state);

      assert.ok(!nextCalled, 'next() must NOT be called when _source.target mismatches');

      const projectionDir = join(testDir, 'unit-target', 'quarantine', 'projection');
      const files = await listDir(projectionDir);
      assert.ok(files.length >= 1, 'quarantine file expected for target mismatch');
    });
  });
});
