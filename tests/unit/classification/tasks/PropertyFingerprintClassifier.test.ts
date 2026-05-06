/**
 * @fileoverview Unit tests for {@link PropertyFingerprintClassifier}.
 *
 * @remarks
 * Tests cover:
 * - Jaccard similarity calculation correct on known test sets.
 * - Threshold 0.85: record matching at 0.86 (above) produces a proposal.
 * - Threshold 0.85: record matching at 0.84 (below) produces no proposal.
 * - Multiple fingerprints above threshold produce multiple proposals.
 * - Fingerprint file with empty keys array throws at construction.
 * - Construction with missing file throws OutputConfigError with the path.
 *
 * @module tests/unit/classification/tasks/PropertyFingerprintClassifier
 * @category Classification
 * @since 0.5.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join }   from 'node:path';

import { PropertyFingerprintClassifier } from '../../../../src/classification/tasks/PropertyFingerprintClassifier.js';
import { OutputConfigError }             from '../../../../src/errors/OutputConfigError.js';
import type {
  PipelineStateInterface,
  ClassificationProposalInterface,
} from '../../../../src/types/PipelineState.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildState(
  input: Record<string, unknown>,
  existingProposals: ReadonlyArray<ClassificationProposalInterface> = [],
): PipelineStateInterface {
  return {
    targetId:        'unit-target',
    source:          { target: 'unit-target', path: 'fixture.json' },
    input,
    classification:  null,
    classifications: existingProposals,
    output:          null,
  };
}

// ── Suite-level temp directory ─────────────────────────────────────────────────

let rootDir = '';

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'sq-unit-pfc-'));
});

after(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('PropertyFingerprintClassifier -- Jaccard similarity calculation', () => {
  it('computes correct Jaccard for {a,b,c} vs {a,b,c,d} = 0.75', async () => {
    const fpDir  = join(rootDir, 'jaccard-test');
    await mkdir(fpDir, { recursive: true });
    const fpFile = join(fpDir, 'fingerprints.json');

    // Fingerprint has keys a, b, c, d (4 keys).
    // Record has a, b, c (3 keys). Intersection = 3, union = 4. Jaccard = 0.75.
    // Use a threshold below 0.75 to confirm the proposal IS emitted.
    await writeFile(fpFile, JSON.stringify({
      'testClass': { keys: ['a', 'b', 'c', 'd'], weight: 1 },
    }), 'utf-8');

    const classifier = PropertyFingerprintClassifier.create(
      { fingerprintsFrom: fpFile, minMatchScore: 0.70, priority: 32 },
      fpDir,
    );

    const state = buildState({ a: 1, b: 2, c: 3 });
    await classifier.execute(async () => { /* next */ }, state);

    assert.strictEqual(state.classifications.length, 1);
    const proposal = state.classifications[0]!;
    assert.strictEqual(proposal.className, 'testClass');
    // confidence should equal the Jaccard score = 0.75
    assert.ok(
      Math.abs(proposal.confidence - 0.75) < 0.01,
      `Expected confidence ~0.75; got ${proposal.confidence}`,
    );
    assert.ok(
      proposal.reasons.some(r => r.startsWith('fingerprint.score=')),
      `Expected fingerprint.score reason; got: ${proposal.reasons.join(', ')}`,
    );
    assert.ok(
      proposal.reasons.some(r => r.startsWith('fingerprint.shared=')),
      `Expected fingerprint.shared reason; got: ${proposal.reasons.join(', ')}`,
    );
  });
});

describe('PropertyFingerprintClassifier -- threshold match above 0.85', () => {
  it('record matching at 0.86 (6/7) produces a proposal', async () => {
    const fpDir  = join(rootDir, 'above-threshold');
    await mkdir(fpDir, { recursive: true });
    const fpFile = join(fpDir, 'fingerprints.json');

    // Fingerprint: 6 keys: a, b, c, d, e, f
    // Record: 7 keys: a, b, c, d, e, f, g
    // Intersection = 6, union = 7, Jaccard = 6/7 ≈ 0.857 > 0.85
    await writeFile(fpFile, JSON.stringify({
      'myClass': { keys: ['a', 'b', 'c', 'd', 'e', 'f'], weight: 1 },
    }), 'utf-8');

    const classifier = PropertyFingerprintClassifier.create(
      { fingerprintsFrom: fpFile, minMatchScore: 0.85, priority: 32 },
      fpDir,
    );

    const state = buildState({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 });
    await classifier.execute(async () => { /* next */ }, state);

    assert.strictEqual(state.classifications.length, 1);
    const proposal = state.classifications[0]!;
    assert.strictEqual(proposal.className, 'myClass');
    assert.ok(
      proposal.confidence >= 0.85,
      `Expected confidence >= 0.85; got ${proposal.confidence}`,
    );
  });
});

describe('PropertyFingerprintClassifier -- threshold miss below 0.85', () => {
  it('record matching at 0.84 (5/6) produces no proposal', async () => {
    const fpDir  = join(rootDir, 'below-threshold');
    await mkdir(fpDir, { recursive: true });
    const fpFile = join(fpDir, 'fingerprints.json');

    // Fingerprint: 5 keys: a, b, c, d, e
    // Record: 6 keys: a, b, c, d, e, f (BUT fingerprint excludes f)
    // Wait -- 5 keys in fingerprint, 6 in record.
    // Intersection = 5, union = 6, Jaccard = 5/6 ≈ 0.833 < 0.85
    await writeFile(fpFile, JSON.stringify({
      'myClass': { keys: ['a', 'b', 'c', 'd', 'e'], weight: 1 },
    }), 'utf-8');

    const classifier = PropertyFingerprintClassifier.create(
      { fingerprintsFrom: fpFile, minMatchScore: 0.85, priority: 32 },
      fpDir,
    );

    const state = buildState({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
    await classifier.execute(async () => { /* next */ }, state);

    assert.strictEqual(
      state.classifications.length,
      0,
      `Expected no proposals for Jaccard 5/6 < 0.85; got ${state.classifications.length}`,
    );
  });
});

describe('PropertyFingerprintClassifier -- multiple matching fingerprints', () => {
  it('two fingerprints both above threshold produce two proposals', async () => {
    const fpDir  = join(rootDir, 'multi-match');
    await mkdir(fpDir, { recursive: true });
    const fpFile = join(fpDir, 'fingerprints.json');

    // Both fingerprints have identical keys so Jaccard with record = 1.0.
    await writeFile(fpFile, JSON.stringify({
      'classA': { keys: ['name', 'level', 'rarity'], weight: 1 },
      'classB': { keys: ['name', 'level', 'rarity'], weight: 1 },
    }), 'utf-8');

    const classifier = PropertyFingerprintClassifier.create(
      { fingerprintsFrom: fpFile, minMatchScore: 0.85, priority: 32 },
      fpDir,
    );

    const state = buildState({ name: 'Power Attack', level: 1, rarity: 'common' });
    await classifier.execute(async () => { /* next */ }, state);

    assert.strictEqual(state.classifications.length, 2);
    const classNames = state.classifications.map(p => p.className);
    assert.ok(classNames.includes('classA'), 'classA proposal expected');
    assert.ok(classNames.includes('classB'), 'classB proposal expected');
  });
});

describe('PropertyFingerprintClassifier -- empty keys array at construction', () => {
  it('fingerprint entry with empty keys array throws OutputConfigError', async () => {
    const fpDir  = join(rootDir, 'empty-keys');
    await mkdir(fpDir, { recursive: true });
    const fpFile = join(fpDir, 'fingerprints.json');

    await writeFile(fpFile, JSON.stringify({
      'emptyClass': { keys: [], weight: 1 },
    }), 'utf-8');

    assert.throws(
      () => {
        PropertyFingerprintClassifier.create(
          { fingerprintsFrom: fpFile, minMatchScore: 0.85 },
          fpDir,
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError, 'error must be OutputConfigError');
        assert.ok(
          (err as Error).message.includes('empty'),
          `error message should mention "empty"; got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });
});

describe('PropertyFingerprintClassifier -- missing fingerprints file', () => {
  it('construction with a missing file throws OutputConfigError with the path', async () => {
    const fpDir  = join(rootDir, 'missing-file');
    await mkdir(fpDir, { recursive: true });
    const missingPath = join(fpDir, 'does-not-exist.json');

    assert.throws(
      () => {
        PropertyFingerprintClassifier.create(
          { fingerprintsFrom: missingPath, minMatchScore: 0.85 },
          fpDir,
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError, 'error must be OutputConfigError');
        assert.ok(
          (err as Error).message.includes('does-not-exist.json') ||
          (err as Error).message.includes(missingPath),
          `error message should contain the file path; got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });
});

describe('PropertyFingerprintClassifier -- source label and next() call', () => {
  it('proposal source is "classify:property-fingerprint" and next() is called', async () => {
    const fpDir  = join(rootDir, 'source-label');
    await mkdir(fpDir, { recursive: true });
    const fpFile = join(fpDir, 'fingerprints.json');

    await writeFile(fpFile, JSON.stringify({
      'feat': { keys: ['name', 'level', 'rarity', 'traits', 'action_cost'], weight: 0.95 },
    }), 'utf-8');

    const classifier = PropertyFingerprintClassifier.create(
      { fingerprintsFrom: fpFile, minMatchScore: 0.80, priority: 32 },
      fpDir,
    );

    const state = buildState({ name: 'Power Attack', level: 1, rarity: 'common', traits: [], action_cost: 'two-actions' });

    let nextCalled = false;
    await classifier.execute(async () => { nextCalled = true; }, state);

    assert.ok(nextCalled, 'next() must be called');
    assert.strictEqual(state.classifications.length, 1);
    assert.strictEqual(state.classifications[0]!.source, 'classify:property-fingerprint');
  });
});
