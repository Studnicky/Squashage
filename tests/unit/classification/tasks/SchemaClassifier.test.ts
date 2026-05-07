/**
 * @fileoverview Unit tests for the {@link SchemaClassifier} pipeline task wrapper.
 *
 * @remarks
 * Exercises the task wrapper in isolation using a tiny inline AJV schema.
 * Verifies that `state.classifications` receives the correct proposal after a
 * match, that `next()` is always called, and that mismatches leave
 * `state.classifications` unchanged.
 *
 * @category Classification
 * @since 2.2.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';

import type { AjvCtorType, AddFormatsFnInterface } from '../../../../src/types/AjvInterop.js';
import { SchemaClassifier } from '../../../../src/classification/tasks/SchemaClassifier.js';
import type { AjvClassEntryInterface } from '../../../../src/classification/AjvClassifier.js';
import type { PipelineStateInterface, ClassificationProposalInterface } from '../../../../src/types/PipelineState.js';
import { OutputConfigError } from '../../../../src/errors/OutputConfigError.js';

// ── AJV setup ─────────────────────────────────────────────────────────────────

const Ajv        = (AjvModule        as unknown as { default?: AjvCtorType }).default        ?? (AjvModule        as unknown as AjvCtorType);
const addFormats = (addFormatsModule as unknown as { default?: AddFormatsFnInterface }).default ?? (addFormatsModule as unknown as AddFormatsFnInterface);

const ajv = new Ajv({ strict: true, allErrors: false });
addFormats(ajv);

// ── Schema ────────────────────────────────────────────────────────────────────

const thingEntry: AjvClassEntryInterface = {
  className: 'thing',
  priority:  10,
  validate:  ajv.compile({
    type:       'object',
    required:   ['_type'],
    properties: { _type: { const: 'thing' } },
    additionalProperties: true,
  }),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Builds a minimal PipelineStateInterface for SchemaClassifier tests. */
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

// ── constructor ───────────────────────────────────────────────────────────────

describe('SchemaClassifier — constructor', () => {
  it('throws OutputConfigError when entries is empty', () => {
    assert.throws(
      () => new SchemaClassifier([]),
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError);
        return true;
      },
    );
  });
});

// ── execute — matching record ─────────────────────────────────────────────────

describe('SchemaClassifier — execute (match)', () => {
  it('appends one proposal to state.classifications when schema matches', async () => {
    const classifier = new SchemaClassifier([thingEntry]);
    const state      = buildState({ _type: 'thing', name: 'Gadget' });

    let nextCalled = false;
    const next = async (): Promise<void> => { nextCalled = true; };

    await classifier.execute(next, state);

    assert.ok(nextCalled, 'next() must be called');
    assert.strictEqual(state.classifications.length, 1);

    const [p] = state.classifications;
    assert.ok(p !== undefined);
    assert.strictEqual(p.source,     'classify:schema');
    assert.strictEqual(p.className,  'thing');
    assert.strictEqual(p.priority,   10);
    assert.strictEqual(p.confidence, 1);
    assert.deepStrictEqual(p.reasons, ['schema:thing matched']);
  });

  it('appends to an existing classifications array (does not overwrite)', async () => {
    const existingProposal: ClassificationProposalInterface = {
      source:     'classify:predicate',
      className:  'thing',
      priority:   5,
      confidence: 0.8,
      reasons:    ['predicate: _type equals thing'],
    };

    const classifier = new SchemaClassifier([thingEntry]);
    const state      = buildState({ _type: 'thing' }, [existingProposal]);

    await classifier.execute(async () => {}, state);

    assert.strictEqual(state.classifications.length, 2);
    assert.strictEqual(state.classifications[0]?.source, 'classify:predicate');
    assert.strictEqual(state.classifications[1]?.source, 'classify:schema');
  });
});

// ── execute — non-matching record ─────────────────────────────────────────────

describe('SchemaClassifier — execute (no match)', () => {
  it('leaves classifications unchanged when schema does not match', async () => {
    const classifier = new SchemaClassifier([thingEntry]);
    const state      = buildState({ _type: 'other', name: 'Unknown' });

    let nextCalled = false;
    const next = async (): Promise<void> => { nextCalled = true; };

    await classifier.execute(next, state);

    assert.ok(nextCalled, 'next() must still be called on no-match');
    assert.deepStrictEqual(state.classifications, []);
  });
});
