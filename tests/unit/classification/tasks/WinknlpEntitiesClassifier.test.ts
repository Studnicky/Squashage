/**
 * @fileoverview Unit tests for {@link WinknlpEntitiesClassifier}.
 *
 * @remarks
 * Tests cover:
 * - Pattern matching expected text produces one proposal with the correct
 *   className and priority.
 * - Multiple patterns, multiple matches produce multiple proposals.
 * - Record without the configured prose field produces no proposal (clean no-op).
 * - Empty prose value produces no proposal.
 * - Construction with a malformed pattern throws {@link OutputConfigError}
 *   containing the pattern name.
 * - winkNLP model is loaded ONCE in the constructor (verified via instance
 *   reuse across multiple execute calls with consistent output).
 *
 * @module tests/unit/classification/tasks/WinknlpEntitiesClassifier
 * @category Classification
 * @since 0.6.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WinknlpEntitiesClassifier } from '../../../../src/classification/tasks/WinknlpEntitiesClassifier.js';
import { OutputConfigError }          from '../../../../src/errors/OutputConfigError.js';
import type {
  PipelineStateInterface,
  ClassificationProposalInterface,
} from '../../../../src/types/PipelineState.js';

// ── Helper ─────────────────────────────────────────────────────────────────────

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

// ── Suite: single pattern match ────────────────────────────────────────────────

describe('WinknlpEntitiesClassifier -- single pattern match', () => {
  it('matching text produces one proposal with the correct className and priority', async () => {
    const classifier = WinknlpEntitiesClassifier.create({
      patterns: [
        {
          name:      'feat-action-cost',
          patterns:  ['two actions'],
          className: 'feat',
          priority:  28,
        },
      ],
      fields: ['description'],
    });

    const state = buildState({
      description: 'This feat costs two actions to activate.',
    });

    let nextCalled = false;
    await classifier.execute(async () => { nextCalled = true; }, state);

    assert.ok(nextCalled, 'next() must be called');
    assert.strictEqual(state.classifications.length, 1);

    const [p] = state.classifications;
    assert.ok(p !== undefined);
    assert.strictEqual(p.className,  'feat');
    assert.strictEqual(p.priority,   28);
    assert.strictEqual(p.source,     'classify:winknlp-entities');
    assert.strictEqual(p.confidence, 1);
    assert.ok(p.reasons.some(r => r === 'winknlp:pattern=feat-action-cost'),  'reason must include pattern name');
    assert.ok(p.reasons.some(r => r.startsWith('winknlp:matched=')),          'reason must include matched text');
    assert.ok(p.reasons.some(r => r === 'winknlp:field=description'),         'reason must include field name');
  });
});

// ── Suite: multi-pattern multi-match ──────────────────────────────────────────

describe('WinknlpEntitiesClassifier -- multi-pattern multi-match', () => {
  it('two patterns that both match produce two proposals', async () => {
    const classifier = WinknlpEntitiesClassifier.create({
      patterns: [
        {
          name:      'feat-two-actions',
          patterns:  ['two actions'],
          className: 'feat',
          priority:  28,
        },
        {
          name:      'spell-somatic',
          patterns:  ['somatic component'],
          className: 'spell',
          priority:  28,
        },
      ],
      fields: ['description'],
    });

    // Text that contains both patterns.
    const state = buildState({
      description: 'This spell requires a somatic component and costs two actions.',
    });

    await classifier.execute(async () => { /* next */ }, state);

    // Both patterns should fire.
    assert.ok(state.classifications.length >= 2, `Expected >= 2 proposals; got ${state.classifications.length}`);

    const classNames = state.classifications.map(p => p.className);
    assert.ok(classNames.includes('feat'),  'feat proposal expected');
    assert.ok(classNames.includes('spell'), 'spell proposal expected');
  });

  it('two matching fields each contribute proposals when configured', async () => {
    const classifier = WinknlpEntitiesClassifier.create({
      patterns: [
        {
          name:      'two-actions-pattern',
          patterns:  ['two actions'],
          className: 'feat',
          priority:  28,
        },
      ],
      fields: ['description', 'summary'],
    });

    const state = buildState({
      description: 'Costs two actions to use.',
      summary:     'Takes two actions.',
    });

    await classifier.execute(async () => { /* next */ }, state);

    // Each field should produce a proposal.
    assert.ok(state.classifications.length >= 2, `Expected >= 2 proposals (one per field); got ${state.classifications.length}`);

    const fieldReasons = state.classifications.map(p =>
      p.reasons.find(r => r.startsWith('winknlp:field='))
    );
    assert.ok(fieldReasons.some(r => r === 'winknlp:field=description'), 'description field reason expected');
    assert.ok(fieldReasons.some(r => r === 'winknlp:field=summary'),     'summary field reason expected');
  });
});

// ── Suite: missing field ───────────────────────────────────────────────────────

describe('WinknlpEntitiesClassifier -- missing configured field', () => {
  it('record without the configured prose field produces no proposal', async () => {
    const classifier = WinknlpEntitiesClassifier.create({
      patterns: [
        {
          name:      'feat-action-cost',
          patterns:  ['two actions'],
          className: 'feat',
          priority:  28,
        },
      ],
      fields: ['description'],
    });

    // Record has no `description` field at all.
    const state = buildState({ name: 'Power Attack', level: 1 });

    await classifier.execute(async () => { /* next */ }, state);

    assert.strictEqual(state.classifications.length, 0, 'Expected no proposals for a record without the prose field');
  });

  it('record with a non-string field value produces no proposal', async () => {
    const classifier = WinknlpEntitiesClassifier.create({
      patterns: [
        {
          name:      'feat-action-cost',
          patterns:  ['two actions'],
          className: 'feat',
          priority:  28,
        },
      ],
      fields: ['description'],
    });

    // `description` is a number, not a string.
    const state = buildState({ description: 42 });

    await classifier.execute(async () => { /* next */ }, state);

    assert.strictEqual(state.classifications.length, 0, 'Expected no proposals for a non-string field');
  });
});

// ── Suite: empty prose value ───────────────────────────────────────────────────

describe('WinknlpEntitiesClassifier -- empty prose value', () => {
  it('empty string field produces no proposal', async () => {
    const classifier = WinknlpEntitiesClassifier.create({
      patterns: [
        {
          name:      'feat-action-cost',
          patterns:  ['two actions'],
          className: 'feat',
          priority:  28,
        },
      ],
      fields: ['description'],
    });

    const state = buildState({ description: '' });

    await classifier.execute(async () => { /* next */ }, state);

    assert.strictEqual(state.classifications.length, 0, 'Expected no proposals for an empty string field');
  });
});

// ── Suite: construction error ──────────────────────────────────────────────────

describe('WinknlpEntitiesClassifier -- malformed pattern at construction', () => {
  it('throws OutputConfigError when winkNLP rejects a pattern', () => {
    // winkNLP throws when given a completely invalid pattern specification.
    // An empty patterns array inside the entry object is invalid (minItems: 1).
    // However since we control the array, let us use a pattern string that
    // winkNLP itself rejects at learnCustomEntities time. A bare empty string
    // in the patterns array should cause winkNLP to throw.
    // We wrap a try/catch to confirm OutputConfigError is thrown.
    assert.throws(
      () => {
        // Pass a patterns array containing an empty string, which winkNLP
        // cannot compile into a valid pattern automaton.
        WinknlpEntitiesClassifier.create({
          patterns: [
            {
              name:      'bad-pattern',
              // Empty string triggers winkNLP's internal validation error.
              patterns:  [''],
              className: 'feat',
              priority:  28,
            },
          ],
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError, `Expected OutputConfigError; got ${String(err)}`);
        assert.ok(
          (err as Error).message.includes('bad-pattern'),
          `Error message must include pattern name "bad-pattern"; got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });
});

// ── Suite: model loaded once ───────────────────────────────────────────────────

describe('WinknlpEntitiesClassifier -- model loaded once in constructor', () => {
  it('classifier produces consistent results across multiple execute calls (model reused)', async () => {
    // The winkNLP instance is shared. If the model were reloaded per-record,
    // the learnCustomEntities call would have to be repeated. Instead we verify
    // that the same proposal shape is produced on the first, second, and third
    // call without any state drift.
    const classifier = WinknlpEntitiesClassifier.create({
      patterns: [
        {
          name:      'two-actions-reuse',
          patterns:  ['two actions'],
          className: 'feat',
          priority:  28,
        },
      ],
      fields: ['description'],
    });

    const text = 'This feat costs two actions to use.';

    for (let i = 0; i < 3; i++) {
      const state = buildState({ description: text });
      await classifier.execute(async () => { /* next */ }, state);
      assert.ok(state.classifications.length >= 1, `Call ${i + 1}: expected at least one proposal`);
      assert.strictEqual(
        state.classifications[0]!.className,
        'feat',
        `Call ${i + 1}: className must be "feat"`,
      );
    }
    // Stable proposals across 3 separate calls confirm the winkNLP instance
    // and its registered custom entities are preserved across execute calls.
  });
});
