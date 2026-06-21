import test from 'node:test';
import assert from 'node:assert/strict';

import { Batch } from '@studnicky/dagonizer';
import { DiscriminatorClassifierNode } from '../../../../../src/nodes/record/classifiers/DiscriminatorClassifierNode.js';
import { SquashageRecordState } from '../../../../../src/state/SquashageRecordState.js';
import type { SquashageServices } from '../../../../../src/services/SquashageServices.js';

const source = { target: 'test', path: '/r/a.json' } as const;
const ctx    = { services: {} as SquashageServices };

async function runNode(
  node: DiscriminatorClassifierNode,
  state: SquashageRecordState,
  context: { services: SquashageServices },
): Promise<string> {
  const result = await node.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof node.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

function makeState(input: Record<string, unknown>): SquashageRecordState {
  const s = new SquashageRecordState(source, '/r/a.json', 0);
  s.input  = input;
  return s;
}

// ─── Happy path ───────────────────────────────────────────────────────────────

test('happy path — verbatim (default)', async (t) => {
  await t.test('resolves _type and proposes verbatim className', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/_type' });
    const state = makeState({ _type: 'feat' });
    const out   = await runNode(node, state, ctx);

    assert.equal(out, 'proposed');
    assert.ok(state.proposals['classify:discriminator'] !== undefined);
    assert.equal(state.proposals['classify:discriminator']?.className, 'feat');
  });

  await t.test('proposal includes correct source and reasons', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/_type' });
    const state = makeState({ _type: 'spell' });
    await runNode(node, state, ctx);

    const proposal = state.proposals['classify:discriminator'];
    assert.equal(proposal?.source, 'classify:discriminator');
    assert.ok(proposal?.reasons[0]?.includes('/_type'));
    assert.ok(proposal?.reasons[0]?.includes('spell'));
  });

  await t.test('confidence is always 1.0', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/_type' });
    const state = makeState({ _type: 'monster' });
    await runNode(node, state, ctx);

    assert.equal(state.proposals['classify:discriminator']?.confidence, 1.0);
  });
});

// ─── Missing / non-string values ─────────────────────────────────────────────

test('no-match cases', async (t) => {
  await t.test('key absent → no-match', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/_type' });
    const state = makeState({});
    const out   = await runNode(node, state, ctx);

    assert.equal(out, 'no-match');
    assert.equal(state.proposals['classify:discriminator'], undefined);
  });

  await t.test('non-string value at path (number) → no-match', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/level' });
    const state = makeState({ level: 3 });
    const out   = await runNode(node, state, ctx);

    assert.equal(out, 'no-match');
  });

  await t.test('empty string at path → no-match', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/_type' });
    const state = makeState({ _type: '' });
    const out   = await runNode(node, state, ctx);

    assert.equal(out, 'no-match');
  });
});

// ─── Fallback ─────────────────────────────────────────────────────────────────

test('fallback', async (t) => {
  await t.test('from missing but fallback present → proposes fallback value', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/_type', fallback: '/category' });
    const state = makeState({ category: 'spell' });
    const out   = await runNode(node, state, ctx);

    assert.equal(out, 'proposed');
    assert.equal(state.proposals['classify:discriminator']?.className, 'spell');
  });

  await t.test('both from and fallback missing → no-match', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/_type', fallback: '/category' });
    const state = makeState({});
    const out   = await runNode(node, state, ctx);

    assert.equal(out, 'no-match');
  });

  await t.test('from resolves before fallback is tried', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/_type', fallback: '/category' });
    const state = makeState({ _type: 'feat', category: 'spell' });
    const out   = await runNode(node, state, ctx);

    assert.equal(out, 'proposed');
    assert.equal(state.proposals['classify:discriminator']?.className, 'feat');
  });
});

// ─── JSON Pointer escape ──────────────────────────────────────────────────────

test('JSON Pointer escape — ~1 decodes to /', async () => {
  // The literal key in the record is "_source/url" (forward slash in the key name).
  // The RFC 6901 pointer to address it is "/_source~1url".
  const node  = new DiscriminatorClassifierNode({ from: '/_source~1url' });
  const state = makeState({ '_source/url': 'feat' });
  const out   = await runNode(node, state, ctx);

  assert.equal(out, 'proposed');
  assert.equal(state.proposals['classify:discriminator']?.className, 'feat');
});

// ─── Sanitize ─────────────────────────────────────────────────────────────────

test('sanitize', async (t) => {
  await t.test('verbatim (default) preserves the raw value', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/_type' });
    const state = makeState({ _type: 'monster-family' });
    await runNode(node, state, ctx);

    assert.equal(state.proposals['classify:discriminator']?.className, 'monster-family');
  });

  await t.test('pascalCase converts monster-family to MonsterFamily', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/_type', sanitize: 'pascalCase' });
    const state = makeState({ _type: 'monster-family' });
    await runNode(node, state, ctx);

    assert.equal(state.proposals['classify:discriminator']?.className, 'MonsterFamily');
  });

  await t.test('kebabToPascal converts monster-family to MonsterFamily', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/_type', sanitize: 'kebabToPascal' });
    const state = makeState({ _type: 'monster-family' });
    await runNode(node, state, ctx);

    assert.equal(state.proposals['classify:discriminator']?.className, 'MonsterFamily');
  });

  await t.test('pascalCase handles underscore separators', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/_type', sanitize: 'pascalCase' });
    const state = makeState({ _type: 'spell_list' });
    await runNode(node, state, ctx);

    assert.equal(state.proposals['classify:discriminator']?.className, 'SpellList');
  });

  await t.test('pascalCase preserves single-word input capitalization', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/_type', sanitize: 'pascalCase' });
    const state = makeState({ _type: 'rule' });
    await runNode(node, state, ctx);

    assert.equal(state.proposals['classify:discriminator']?.className, 'Rule');
  });
});

// ─── Priority ─────────────────────────────────────────────────────────────────

test('priority', async (t) => {
  await t.test('explicit priority is written to proposal', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/_type', priority: 80 });
    const state = makeState({ _type: 'feat' });
    await runNode(node, state, ctx);

    assert.equal(state.proposals['classify:discriminator']?.priority, 80);
  });

  await t.test('default priority is 50 when not configured', async () => {
    const node  = new DiscriminatorClassifierNode({ from: '/_type' });
    const state = makeState({ _type: 'feat' });
    await runNode(node, state, ctx);

    assert.equal(state.proposals['classify:discriminator']?.priority, 50);
  });
});

// ─── Node metadata ────────────────────────────────────────────────────────────

test('node metadata', () => {
  const node = new DiscriminatorClassifierNode({ from: '/_type' });
  assert.equal(node.name, 'classify:discriminator');
  assert.deepEqual(node.outputs, ['proposed', 'no-match']);
});
