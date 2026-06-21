import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Batch } from '@studnicky/dagonizer';
import { mergeShapeCacheNode } from '../../../../src/nodes/run/mergeShapeCache.js';
import { SquashageInduceRunState } from '../../../../src/state/SquashageInduceRunState.js';
import { ShapeObservationAccumulator } from '../../../../src/induction/ShapeObservation.js';
import type { SquashageServices } from '../../../../src/services/SquashageServices.js';

const noopLogger = {
  forComponent: () => ({
    debug: () => undefined,
    info:  () => undefined,
    warn:  () => undefined,
    error: () => undefined,
  }),
} as unknown as SquashageServices['logger'];

function makeState(): SquashageInduceRunState {
  return new SquashageInduceRunState('test', new Date().toISOString());
}

function makeServices(shapeCache: Map<string, ReturnType<typeof ShapeObservationAccumulator.createEmpty>>): Pick<SquashageServices, 'logger' | 'shapeCache'> {
  return {
    logger:     noopLogger,
    shapeCache: shapeCache as SquashageServices['shapeCache'],
  };
}

async function runNode(
  state:   SquashageInduceRunState,
  context: { services: SquashageServices },
): Promise<string> {
  const result = await mergeShapeCacheNode.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof mergeShapeCacheNode.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

describe('mergeShapeCacheNode — empty cache', () => {
  it('returns merged; state.observedRecords is 0', async () => {
    const state    = makeState();
    const services = makeServices(new Map());
    const output   = await runNode(state, { services: services as unknown as SquashageServices });
    assert.equal(output,                 'merged');
    assert.equal(state.observedRecords,  0);
    assert.deepEqual(state.discoveredClasses, []);
  });
});

describe('mergeShapeCacheNode — populated cache', () => {
  it('sums recordCount across all observations', async () => {
    const shapeCache = new Map<string, ReturnType<typeof ShapeObservationAccumulator.createEmpty>>();

    const featObs = ShapeObservationAccumulator.createEmpty('Feat');
    ShapeObservationAccumulator.fold(featObs, { name: 'A' });
    ShapeObservationAccumulator.fold(featObs, { name: 'B' });
    shapeCache.set('Feat', featObs);

    const spellObs = ShapeObservationAccumulator.createEmpty('Spell');
    ShapeObservationAccumulator.fold(spellObs, { name: 'Fireball' });
    shapeCache.set('Spell', spellObs);

    const state    = makeState();
    const services = makeServices(shapeCache);
    const output   = await runNode(state, { services: services as unknown as SquashageServices });

    assert.equal(output,                'merged');
    assert.equal(state.observedRecords, 3);   // 2 Feat + 1 Spell
  });

  it('discoveredClasses is sorted', async () => {
    const shapeCache = new Map<string, ReturnType<typeof ShapeObservationAccumulator.createEmpty>>();
    shapeCache.set('Spell', ShapeObservationAccumulator.createEmpty('Spell'));
    shapeCache.set('Feat',  ShapeObservationAccumulator.createEmpty('Feat'));
    shapeCache.set('Item',  ShapeObservationAccumulator.createEmpty('Item'));

    const state    = makeState();
    const services = makeServices(shapeCache);
    await runNode(state, { services: services as unknown as SquashageServices });

    assert.deepEqual(state.discoveredClasses, ['Feat', 'Item', 'Spell']);
  });
});
