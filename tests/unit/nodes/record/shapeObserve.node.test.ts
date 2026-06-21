import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Batch } from '@studnicky/dagonizer';
import { shapeObserveNode } from '../../../../src/nodes/record/shapeObserve.js';
import { ShapeObservationAccumulator } from '../../../../src/induction/ShapeObservation.js';
import { SquashageRecordState } from '../../../../src/state/SquashageRecordState.js';
import type { ShapeObservation } from '../../../../src/induction/ShapeObservation.js';
import type { SquashageServices } from '../../../../src/services/SquashageServices.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const SOURCE = { target: 'test', path: '/r/a.json' } as const;

function makeState(classification: { type: string } | null = null): SquashageRecordState {
  const s = new SquashageRecordState(SOURCE, '/r/a.json', 0);
  s.input = { name: 'Fireball', level: 3 };
  s.classification = classification as SquashageRecordState['classification'];
  return s;
}

function makeServices(
  shapeCache: Map<string, ShapeObservation> = new Map(),
): { readonly services: SquashageServices } {
  return {
    services: { shapeCache } as unknown as SquashageServices,
  };
}

async function runNode(
  state: SquashageRecordState,
  context: { readonly services: SquashageServices },
): Promise<string> {
  const result = await shapeObserveNode.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof shapeObserveNode.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

// ─── skipped output ────────────────────────────────────────────────────────────

describe('shapeObserveNode — skipped when classification is null', () => {
  it('returns skipped when state.classification is null', async () => {
    const state = makeState(null);
    const ctx   = makeServices();
    const result = await runNode(state, ctx);
    assert.equal(result, 'skipped');
  });

  it('does not modify shapeCache when skipped', async () => {
    const state      = makeState(null);
    const shapeCache = new Map<string, ShapeObservation>();
    const ctx        = makeServices(shapeCache);
    await runNode(state, ctx);
    assert.equal(shapeCache.size, 0);
  });
});

// ─── observed output ──────────────────────────────────────────────────────────

describe('shapeObserveNode — observed output', () => {
  it('returns observed when classification is set', async () => {
    const state  = makeState({ type: 'Spell' });
    const ctx    = makeServices();
    const result = await runNode(state, ctx);
    assert.equal(result, 'observed');
  });

  it('creates a shapeCache entry on first contact for a className', async () => {
    const state      = makeState({ type: 'Feat' });
    const shapeCache = new Map<string, ShapeObservation>();
    const ctx        = makeServices(shapeCache);
    await runNode(state, ctx);
    assert.ok(shapeCache.has('Feat'), 'shapeCache should have an entry for Feat');
  });

  it('increments recordCount after fold', async () => {
    const state      = makeState({ type: 'Feat' });
    const shapeCache = new Map<string, ShapeObservation>();
    const ctx        = makeServices(shapeCache);
    await runNode(state, ctx);
    const obs = shapeCache.get('Feat');
    assert.ok(obs !== undefined);
    assert.equal(obs.recordCount, 1);
  });

  it('accumulates recordCount across multiple invocations', async () => {
    const shapeCache = new Map<string, ShapeObservation>();
    const ctx        = makeServices(shapeCache);

    const s1 = makeState({ type: 'Feat' });
    s1.input = { name: 'Power Attack' };
    await runNode(s1, ctx);

    const s2 = makeState({ type: 'Feat' });
    s2.input = { name: 'Cleave' };
    await runNode(s2, ctx);

    const obs = shapeCache.get('Feat');
    assert.ok(obs !== undefined);
    assert.equal(obs.recordCount, 2);
  });

  it('multiple records with the same className fold into the same entry', async () => {
    const shapeCache = new Map<string, ShapeObservation>();
    const ctx        = makeServices(shapeCache);

    for (const name of ['A', 'B', 'C']) {
      const s = makeState({ type: 'Spell' });
      s.input = { name };
      await runNode(s, ctx);
    }

    assert.equal(shapeCache.size, 1, 'only one entry per className');
    const obs = shapeCache.get('Spell');
    assert.ok(obs !== undefined);
    assert.equal(obs.recordCount, 3);
  });

  it('different classNames create separate entries in shapeCache', async () => {
    const shapeCache = new Map<string, ShapeObservation>();
    const ctx        = makeServices(shapeCache);

    const s1 = makeState({ type: 'Feat' });
    s1.input = { name: 'Power Attack' };
    await runNode(s1, ctx);

    const s2 = makeState({ type: 'Spell' });
    s2.input = { name: 'Fireball' };
    await runNode(s2, ctx);

    assert.equal(shapeCache.size, 2);
    assert.ok(shapeCache.has('Feat'));
    assert.ok(shapeCache.has('Spell'));
  });

  it('folds state.input properties into the observation', async () => {
    const shapeCache = new Map<string, ShapeObservation>();
    const ctx        = makeServices(shapeCache);

    const s = makeState({ type: 'Item' });
    s.input = { name: 'Sword', level: 5, active: true };
    await runNode(s, ctx);

    const obs = shapeCache.get('Item');
    assert.ok(obs !== undefined);
    assert.ok(obs.properties.has('name'), 'name property should be tracked');
    assert.ok(obs.properties.has('level'), 'level property should be tracked');
    assert.ok(obs.properties.has('active'), 'active property should be tracked');
  });

  it('check-and-set: pre-existing entry is reused (no reset)', async () => {
    const shapeCache = new Map<string, ShapeObservation>();
    const ctx        = makeServices(shapeCache);

    // Pre-populate with an existing observation
    const existing = ShapeObservationAccumulator.createEmpty('Feat');
    ShapeObservationAccumulator.fold(existing, { name: 'Pre-existing' });
    shapeCache.set('Feat', existing);

    const s = makeState({ type: 'Feat' });
    s.input = { name: 'New Record' };
    await runNode(s, ctx);

    const obs = shapeCache.get('Feat');
    assert.ok(obs !== undefined);
    // Should be recordCount 2 (1 pre-existing + 1 from execute)
    assert.equal(obs.recordCount, 2);
    // The same object reference should be reused
    assert.equal(obs, existing);
  });
});

// ─── node metadata ────────────────────────────────────────────────────────────

describe('shapeObserveNode — node metadata', () => {
  it('has name "shape-observe"', () => {
    assert.equal(shapeObserveNode.name, 'shape-observe');
  });

  it('has outputs ["observed", "skipped"]', () => {
    assert.deepEqual([...shapeObserveNode.outputs].sort(), ['observed', 'skipped']);
  });
});
