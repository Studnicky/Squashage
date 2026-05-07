/**
 * @fileoverview Unit tests for {@link SourceClassifier}.
 *
 * @remarks
 * Covers: constructor (no-arg), absent `_source` block, present `_source` with
 * all fields, partial fields, proposal immutability, `next()` propagation, and
 * additive accumulation when `state.classifications` is pre-populated.
 *
 * @category Classification
 * @since 0.1.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SourceClassifier } from '../../../../src/classification/tasks/SourceClassifier.js';
import type { PipelineStateInterface } from '../../../../src/types/PipelineState.js';
import type { ClassificationProposalInterface } from '../../../../src/types/PipelineState.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Builds a minimal PipelineStateInterface for testing. */
function buildState(
  input:           Readonly<Record<string, unknown>> = {},
  classifications: ReadonlyArray<ClassificationProposalInterface> = [],
): PipelineStateInterface {
  return {
    targetId:        'test-target',
    source:          { target: 'test-target', path: 'fixture.json' },
    input,
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SourceClassifier — constructor', () => {
  it('constructs with no arguments', () => {
    const classifier = new SourceClassifier();
    assert.ok(classifier instanceof SourceClassifier);
  });

  it('exposes a bound execute function', () => {
    const classifier = new SourceClassifier();
    assert.strictEqual(typeof classifier.execute, 'function');
  });
});

describe('SourceClassifier — absent _source block', () => {
  it('emits no proposal when _source is absent', async () => {
    const classifier = new SourceClassifier();
    const state = buildState({ name: 'Bulbasaur' });
    const next = makeNext();

    await classifier.execute(next.fn, state);

    assert.strictEqual(state.classifications.length, 0);
  });

  it('calls next() when _source is absent', async () => {
    const classifier = new SourceClassifier();
    const state = buildState({ name: 'Bulbasaur' });
    const next = makeNext();

    await classifier.execute(next.fn, state);

    assert.strictEqual(next.called, true);
  });

  it('emits no proposal when _source is null', async () => {
    const classifier = new SourceClassifier();
    const state = buildState({ _source: null });
    const next = makeNext();

    await classifier.execute(next.fn, state);

    assert.strictEqual(state.classifications.length, 0);
  });

  it('emits no proposal when _source is a non-object (string)', async () => {
    const classifier = new SourceClassifier();
    const state = buildState({ _source: 'unexpected' });
    const next = makeNext();

    await classifier.execute(next.fn, state);

    assert.strictEqual(state.classifications.length, 0);
  });
});

describe('SourceClassifier — present _source block', () => {
  it('emits one proposal with className __source__ when _source is present', async () => {
    const classifier = new SourceClassifier();
    const state = buildState({
      _source: { target: 'aonprd', plugin: 'aonprd:parse', schemaId: 'feat-v1' },
    });
    const next = makeNext();

    await classifier.execute(next.fn, state);

    assert.strictEqual(state.classifications.length, 1);
    assert.strictEqual(state.classifications[0]?.className, '__source__');
  });

  it('emits proposal with source classify:source', async () => {
    const classifier = new SourceClassifier();
    const state = buildState({
      _source: { target: 'aonprd' },
    });
    const next = makeNext();

    await classifier.execute(next.fn, state);

    assert.strictEqual(state.classifications[0]?.source, 'classify:source');
  });

  it('emits proposal with priority 0 and confidence 1', async () => {
    const classifier = new SourceClassifier();
    const state = buildState({
      _source: { target: 'aonprd', plugin: 'aonprd:parse' },
    });
    const next = makeNext();

    await classifier.execute(next.fn, state);

    const proposal = state.classifications[0];
    assert.ok(proposal !== undefined);
    assert.strictEqual(proposal.priority, 0);
    assert.strictEqual(proposal.confidence, 1);
  });

  it('includes all three source fields in reasons when all are present', async () => {
    const classifier = new SourceClassifier();
    const state = buildState({
      _source: { target: 'aonprd', plugin: 'aonprd:parse', schemaId: 'feat-v1' },
    });
    const next = makeNext();

    await classifier.execute(next.fn, state);

    const reasons = state.classifications[0]?.reasons ?? [];
    assert.ok(reasons.includes('source.target=aonprd'), 'should include target');
    assert.ok(reasons.includes('source.plugin=aonprd:parse'), 'should include plugin');
    assert.ok(reasons.includes('source.schemaId=feat-v1'), 'should include schemaId');
  });

  it('omits plugin and schemaId from reasons when absent', async () => {
    const classifier = new SourceClassifier();
    const state = buildState({
      _source: { target: 'aonprd' },
    });
    const next = makeNext();

    await classifier.execute(next.fn, state);

    const reasons = state.classifications[0]?.reasons ?? [];
    assert.ok(reasons.includes('source.target=aonprd'), 'should include target');
    assert.strictEqual(reasons.filter((r) => r.startsWith('source.plugin=')).length, 0);
    assert.strictEqual(reasons.filter((r) => r.startsWith('source.schemaId=')).length, 0);
  });

  it('calls next() after emitting a proposal', async () => {
    const classifier = new SourceClassifier();
    const state = buildState({
      _source: { target: 'aonprd', plugin: 'aonprd:parse' },
    });
    const next = makeNext();

    await classifier.execute(next.fn, state);

    assert.strictEqual(next.called, true);
  });
});

describe('SourceClassifier — additive accumulation', () => {
  it('appends to existing classifications rather than replacing them', async () => {
    const classifier = new SourceClassifier();

    const existingProposal: ClassificationProposalInterface = {
      source:     'classify:structural',
      className:  'feat',
      priority:   10,
      confidence: 1,
      reasons:    ['_type=feat'],
    };

    const state = buildState(
      { _source: { target: 'aonprd' } },
      [existingProposal],
    );
    const next = makeNext();

    await classifier.execute(next.fn, state);

    assert.strictEqual(state.classifications.length, 2);
    assert.strictEqual(state.classifications[0], existingProposal);
    assert.strictEqual(state.classifications[1]?.className, '__source__');
  });
});
