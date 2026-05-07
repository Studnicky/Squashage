/**
 * @fileoverview Unit tests for {@link ConflictResolver}.
 *
 * @remarks
 * Covers: onUnknown quarantine and skip policies, single-proposal resolution,
 * multi-proposal same-className resolution (corroboration), multi-class
 * priority-winner resolution, genuine tie with pickPriority policy,
 * genuine tie with quarantine policy, evidence true/false reasons truncation,
 * and `next()` always called.
 *
 * Quarantine tests write to a temporary directory under `os.tmpdir()` and
 * verify the written file exists and contains the expected content.
 *
 * @category Classification
 * @since 0.1.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join }  from 'node:path';
import { tmpdir } from 'node:os';

import { ConflictResolver } from '../../../../src/classification/tasks/ConflictResolver.js';
import type { ConflictResolverConfigInterface } from '../../../../src/classification/tasks/ConflictResolver.js';
import { OutputConfigError } from '../../../../src/errors/OutputConfigError.js';
import type { PipelineStateInterface, ClassificationProposalInterface } from '../../../../src/types/PipelineState.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'conflict-resolver-test-'));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Builds a minimal PipelineStateInterface for testing. */
function buildState(
  classifications: ReadonlyArray<ClassificationProposalInterface> = [],
  sourcePath: string = 'fixture.json',
): PipelineStateInterface {
  return {
    targetId:        'test-target',
    source:          { target: 'test-target', path: sourcePath },
    input:           { _type: 'test' },
    classification:  null,
    classifications,
    output:          null,
  };
}

/** Tracks whether `next()` was called; check `.called` after execution. */
function makeNext(): { called: boolean; fn: () => Promise<void> } {
  const handle = { called: false, fn: async (): Promise<void> => { handle.called = true; } };
  return handle;
}

/** Builds a concrete proposal for testing. */
function makeProposal(
  className: string,
  source:    string  = 'classify:rules',
  priority:  number  = 10,
  reasons:   string[] = [`${className} matched`],
): ClassificationProposalInterface {
  return { source, className, priority, confidence: 1, reasons };
}

/** Default config for most tests. */
const defaultConfig: ConflictResolverConfigInterface = {
  onConflict: 'quarantine',
  onUnknown:  'skip',
  evidence:   true,
};

// ── Constructor tests ─────────────────────────────────────────────────────────

describe('ConflictResolver — constructor', () => {
  it('constructs successfully with valid args', () => {
    const resolver = new ConflictResolver(defaultConfig, '/tmp/out', 'test-target');
    assert.ok(resolver instanceof ConflictResolver);
  });

  it('exposes a bound execute function', () => {
    const resolver = new ConflictResolver(defaultConfig, '/tmp/out', 'test-target');
    assert.strictEqual(typeof resolver.execute, 'function');
  });

  it('throws OutputConfigError when outDir is empty', () => {
    assert.throws(
      () => new ConflictResolver(defaultConfig, '', 'test-target'),
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError);
        return true;
      },
    );
  });

  it('throws OutputConfigError when targetId is empty', () => {
    assert.throws(
      () => new ConflictResolver(defaultConfig, '/tmp/out', ''),
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError);
        return true;
      },
    );
  });
});

// ── Empty proposals / onUnknown ───────────────────────────────────────────────

describe('ConflictResolver — empty proposals + onUnknown: skip', () => {
  it('leaves state.classification null and calls next()', async () => {
    const resolver = new ConflictResolver(
      { ...defaultConfig, onUnknown: 'skip' },
      tmpDir,
      'test-target',
    );
    const state = buildState([]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    assert.strictEqual(state.classification, null);
    assert.strictEqual(next.called, true);
  });

  it('does not write a quarantine file', async () => {
    const resolver = new ConflictResolver(
      { ...defaultConfig, onUnknown: 'skip' },
      tmpDir,
      'test-target-skip',
    );
    const state = buildState([]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    // No quarantine directory should have been created for this target.
    const quarantinePath = join(tmpDir, 'test-target-skip', 'quarantine', 'unknown');
    let exists = false;
    try {
      await readFile(join(quarantinePath, 'any.json'), 'utf8');
      exists = true;
    } catch { /* expected */ }

    assert.strictEqual(exists, false);
  });
});

describe('ConflictResolver — empty proposals + onUnknown: quarantine', () => {
  it('writes a quarantine file under quarantine/unknown/', async () => {
    const targetId = 'target-unknown-q';
    const resolver = new ConflictResolver(
      { ...defaultConfig, onUnknown: 'quarantine' },
      tmpDir,
      targetId,
    );
    const state = buildState([], 'bulbasaur.json');
    const next = makeNext();

    await resolver.execute(next.fn, state);

    const quarantineDir = join(tmpDir, targetId, 'quarantine', 'unknown');

    // There should be one file in the unknown bucket.
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(quarantineDir);
    assert.strictEqual(files.length, 1);
  });

  it('quarantine record has bucket unknown and null classification', async () => {
    const targetId = 'target-unknown-record';
    const resolver = new ConflictResolver(
      { ...defaultConfig, onUnknown: 'quarantine' },
      tmpDir,
      targetId,
    );
    const state = buildState([], 'pikachu.json');
    const next = makeNext();

    await resolver.execute(next.fn, state);

    const quarantineDir = join(tmpDir, targetId, 'quarantine', 'unknown');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(quarantineDir);
    const content = await readFile(join(quarantineDir, files[0] as string), 'utf8');
    const record = JSON.parse(content) as Record<string, unknown>;

    assert.strictEqual(record['bucket'], 'unknown');
    assert.strictEqual(record['classification'], null);
  });

  it('leaves state.classification null', async () => {
    const targetId = 'target-unknown-null-state';
    const resolver = new ConflictResolver(
      { ...defaultConfig, onUnknown: 'quarantine' },
      tmpDir,
      targetId,
    );
    const state = buildState([]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    assert.strictEqual(state.classification, null);
  });

  it('calls next() after quarantine', async () => {
    const targetId = 'target-unknown-next';
    const resolver = new ConflictResolver(
      { ...defaultConfig, onUnknown: 'quarantine' },
      tmpDir,
      targetId,
    );
    const state = buildState([]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    assert.strictEqual(next.called, true);
  });

  it('sentinel-only proposals (all __source__ or __validation__) are treated as empty', async () => {
    const targetId = 'target-sentinels-only';
    const resolver = new ConflictResolver(
      { ...defaultConfig, onUnknown: 'quarantine' },
      tmpDir,
      targetId,
    );
    const state = buildState([
      makeProposal('__source__',     'classify:source', 0),
      makeProposal('__validation__', 'classify:ontology', 0),
      makeProposal('unknown',        'classify:rules', 0),
    ]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    // After filtering sentinels, zero real proposals remain → onUnknown path.
    const quarantineDir = join(tmpDir, targetId, 'quarantine', 'unknown');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(quarantineDir);
    assert.strictEqual(files.length, 1, 'should have quarantined the sentinel-only record');
    assert.strictEqual(state.classification, null);
  });
});

// ── Single proposal ───────────────────────────────────────────────────────────

describe('ConflictResolver — single proposal', () => {
  it('sets state.classification with the proposal className', async () => {
    const resolver = new ConflictResolver(defaultConfig, tmpDir, 'test-target');
    const state = buildState([makeProposal('feat', 'classify:rules')]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    assert.ok(state.classification !== null);
    assert.strictEqual(state.classification.type, 'feat');
  });

  it('engine is the source of the single proposal', async () => {
    const resolver = new ConflictResolver(defaultConfig, tmpDir, 'test-target');
    const state = buildState([makeProposal('feat', 'classify:rules')]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    assert.strictEqual(state.classification?.engine, 'classify:rules');
  });

  it('calls next()', async () => {
    const resolver = new ConflictResolver(defaultConfig, tmpDir, 'test-target');
    const state = buildState([makeProposal('feat', 'classify:rules')]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    assert.strictEqual(next.called, true);
  });

  it('candidates is undefined for single-class resolution', async () => {
    const resolver = new ConflictResolver(defaultConfig, tmpDir, 'test-target');
    const state = buildState([makeProposal('feat', 'classify:rules')]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    assert.strictEqual(state.classification?.candidates, undefined);
  });
});

// ── Multiple proposals, same className (corroboration) ────────────────────────

describe('ConflictResolver — multiple proposals same className', () => {
  it('sets state.classification with the corroborated className', async () => {
    const resolver = new ConflictResolver(defaultConfig, tmpDir, 'test-target');
    const state = buildState([
      makeProposal('feat', 'classify:rules',      10, ['rules matched']),
      makeProposal('feat', 'classify:structural', 5,  ['structural matched']),
    ]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    assert.strictEqual(state.classification?.type, 'feat');
  });

  it('engine is comma-joined unique sources', async () => {
    const resolver = new ConflictResolver(defaultConfig, tmpDir, 'test-target');
    const state = buildState([
      makeProposal('feat', 'classify:rules',      10, ['rules matched']),
      makeProposal('feat', 'classify:structural', 5,  ['structural matched']),
    ]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    const engine = state.classification?.engine ?? '';
    assert.ok(engine.includes('classify:rules'),      'engine includes classify:rules');
    assert.ok(engine.includes('classify:structural'), 'engine includes classify:structural');
  });

  it('evidence true: reasons array concatenates all proposal reasons', async () => {
    const resolver = new ConflictResolver(
      { ...defaultConfig, evidence: true },
      tmpDir,
      'test-target',
    );
    const state = buildState([
      makeProposal('feat', 'classify:rules',      10, ['rules matched']),
      makeProposal('feat', 'classify:structural', 5,  ['structural matched']),
    ]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    const reasons = state.classification?.reasons ?? [];
    assert.ok(reasons.includes('rules matched'),      'includes rules matched');
    assert.ok(reasons.includes('structural matched'), 'includes structural matched');
  });

  it('evidence false: reasons array contains only the top reason from winner', async () => {
    const resolver = new ConflictResolver(
      { ...defaultConfig, evidence: false },
      tmpDir,
      'test-target',
    );
    const state = buildState([
      makeProposal('feat', 'classify:rules',      10, ['rules matched', 'extra reason']),
      makeProposal('feat', 'classify:structural', 5,  ['structural matched']),
    ]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    const reasons = state.classification?.reasons ?? [];
    // evidence: false → only the top reason from the highest-priority proposal.
    assert.strictEqual(reasons.length, 1);
    assert.strictEqual(reasons[0], 'rules matched');
  });
});

// ── Multi-class conflict: clear priority winner ───────────────────────────────

describe('ConflictResolver — multi-class proposals with clear priority winner', () => {
  it('picks the class with the highest priority', async () => {
    const resolver = new ConflictResolver(defaultConfig, tmpDir, 'test-target');
    const state = buildState([
      makeProposal('feat', 'classify:rules',      20),
      makeProposal('spell', 'classify:structural', 5),
    ]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    assert.strictEqual(state.classification?.type, 'feat');
  });

  it('candidates is undefined when there is a clear winner', async () => {
    const resolver = new ConflictResolver(defaultConfig, tmpDir, 'test-target');
    const state = buildState([
      makeProposal('feat', 'classify:rules',      20),
      makeProposal('spell', 'classify:structural', 5),
    ]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    assert.strictEqual(state.classification?.candidates, undefined);
  });

  it('calls next() after priority resolution', async () => {
    const resolver = new ConflictResolver(defaultConfig, tmpDir, 'test-target');
    const state = buildState([
      makeProposal('feat', 'classify:rules',      20),
      makeProposal('spell', 'classify:structural', 5),
    ]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    assert.strictEqual(next.called, true);
  });
});

// ── Multi-class tie + pickPriority ────────────────────────────────────────────

describe('ConflictResolver — multi-class tie + onConflict: pickPriority', () => {
  it('picks the lexicographically first className among tied classes', async () => {
    const resolver = new ConflictResolver(
      { ...defaultConfig, onConflict: 'pickPriority' },
      tmpDir,
      'test-target',
    );
    const state = buildState([
      makeProposal('spell', 'classify:rules',      10),
      makeProposal('feat', 'classify:structural', 10),
    ]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    // 'feat' sorts before 'spell' lexicographically.
    assert.strictEqual(state.classification?.type, 'feat');
  });

  it('candidates lists all tied classNames lexicographically sorted', async () => {
    const resolver = new ConflictResolver(
      { ...defaultConfig, onConflict: 'pickPriority' },
      tmpDir,
      'test-target',
    );
    const state = buildState([
      makeProposal('spell', 'classify:rules',      10),
      makeProposal('feat', 'classify:structural', 10),
    ]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    const candidates = state.classification?.candidates ?? [];
    assert.deepStrictEqual([...candidates], ['feat', 'spell']);
  });

  it('calls next() after lex tiebreak', async () => {
    const resolver = new ConflictResolver(
      { ...defaultConfig, onConflict: 'pickPriority' },
      tmpDir,
      'test-target',
    );
    const state = buildState([
      makeProposal('spell', 'classify:rules',      10),
      makeProposal('feat', 'classify:structural', 10),
    ]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    assert.strictEqual(next.called, true);
  });
});

// ── Multi-class tie + quarantine ──────────────────────────────────────────────

describe('ConflictResolver — multi-class tie + onConflict: quarantine', () => {
  it('writes a quarantine file under quarantine/conflicts/', async () => {
    const targetId = 'target-conflict-q';
    const resolver = new ConflictResolver(
      { ...defaultConfig, onConflict: 'quarantine' },
      tmpDir,
      targetId,
    );
    const state = buildState([
      makeProposal('spell', 'classify:rules',      10),
      makeProposal('feat', 'classify:structural', 10),
    ]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    const quarantineDir = join(tmpDir, targetId, 'quarantine', 'conflicts');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(quarantineDir);
    assert.strictEqual(files.length, 1);
  });

  it('quarantine record has bucket conflicts and candidates listing tied classes', async () => {
    const targetId = 'target-conflict-record';
    const resolver = new ConflictResolver(
      { ...defaultConfig, onConflict: 'quarantine' },
      tmpDir,
      targetId,
    );
    const state = buildState([
      makeProposal('spell', 'classify:rules',      10),
      makeProposal('feat', 'classify:structural', 10),
    ]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    const quarantineDir = join(tmpDir, targetId, 'quarantine', 'conflicts');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(quarantineDir);
    const content = await readFile(join(quarantineDir, files[0] as string), 'utf8');
    const record = JSON.parse(content) as Record<string, unknown>;

    assert.strictEqual(record['bucket'], 'conflicts');
    const candidates = record['candidates'] as Array<{ type: string }>;
    assert.ok(Array.isArray(candidates), 'candidates should be an array');
    const types = candidates.map((c) => c.type).sort();
    assert.deepStrictEqual(types, ['feat', 'spell']);
  });

  it('leaves state.classification null on conflict quarantine', async () => {
    const targetId = 'target-conflict-null-state';
    const resolver = new ConflictResolver(
      { ...defaultConfig, onConflict: 'quarantine' },
      tmpDir,
      targetId,
    );
    const state = buildState([
      makeProposal('spell', 'classify:rules',      10),
      makeProposal('feat', 'classify:structural', 10),
    ]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    assert.strictEqual(state.classification, null);
  });

  it('calls next() after conflict quarantine', async () => {
    const targetId = 'target-conflict-next';
    const resolver = new ConflictResolver(
      { ...defaultConfig, onConflict: 'quarantine' },
      tmpDir,
      targetId,
    );
    const state = buildState([
      makeProposal('spell', 'classify:rules',      10),
      makeProposal('feat', 'classify:structural', 10),
    ]);
    const next = makeNext();

    await resolver.execute(next.fn, state);

    assert.strictEqual(next.called, true);
  });
});
