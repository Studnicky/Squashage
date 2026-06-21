import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Batch } from '@studnicky/dagonizer';
import { induceSchemasNode } from '../../../../src/nodes/run/induceSchemas.js';
import { SquashageInduceRunState } from '../../../../src/state/SquashageInduceRunState.js';
import { ShapeObservationAccumulator } from '../../../../src/induction/ShapeObservation.js';
import type { SquashageServices } from '../../../../src/services/SquashageServices.js';
import type { TargetConfigInterface } from '../../../../src/config/SquashageConfig.js';

const noopLogger = {
  forComponent: () => ({
    debug: () => undefined,
    info:  () => undefined,
    warn:  () => undefined,
    error: () => undefined,
  }),
} as unknown as SquashageServices['logger'];

const BASE_IRI      = 'https://example.org/vocab/';
const targetConfig  = {
  input:  '/tmp',
  output: { kind: 'file', path: '/tmp/out.trig', format: 'trig' },
  ontology: { engine: 'json-tology', baseIRI: BASE_IRI },
} as unknown as TargetConfigInterface;

function makeState(): SquashageInduceRunState {
  return new SquashageInduceRunState('test', new Date().toISOString());
}

function makeServices(shapeCache: SquashageServices['shapeCache']): Partial<SquashageServices> {
  return {
    logger:       noopLogger,
    shapeCache,
    targetConfig,
  };
}

async function runNode(
  state:   SquashageInduceRunState,
  context: { services: SquashageServices },
): Promise<string> {
  const result = await induceSchemasNode.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof induceSchemasNode.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

describe('induceSchemasNode — empty cache', () => {
  it('returns empty output; state.inducedSchemas stays null', async () => {
    const state    = makeState();
    const services = makeServices(new Map());
    const output   = await runNode(state, { services: services as SquashageServices });
    assert.equal(output,                 'empty');
    assert.equal(state.inducedSchemas,   null);
  });
});

describe('induceSchemasNode — populated cache', () => {
  it('calls inducer and stores InducedSchemaSetInterface in state.inducedSchemas', async () => {
    const shapeCache = new Map<string, ReturnType<typeof ShapeObservationAccumulator.createEmpty>>();
    const obs = ShapeObservationAccumulator.createEmpty('Feat');
    ShapeObservationAccumulator.fold(obs, { name: 'Power Attack', _type: 'feat' });
    shapeCache.set('Feat', obs);

    const state    = makeState();
    const services = makeServices(shapeCache as SquashageServices['shapeCache']);
    const output   = await runNode(state, { services: services as SquashageServices });

    assert.equal(output, 'induced');
    assert.ok(state.inducedSchemas !== null, 'inducedSchemas should be set');
    assert.equal(state.inducedSchemas.classes.length, 1);
    assert.equal(state.inducedSchemas.classes[0]?.className, 'Feat');
    assert.ok(typeof state.inducedSchemas.classes[0]?.schema === 'object');
    assert.ok(Array.isArray(state.inducedSchemas.primitives));
    assert.ok(Array.isArray(state.inducedSchemas.objects));
  });

  it('base IRI falls back to https://example.org/ when ontology block absent', async () => {
    const shapeCache = new Map<string, ReturnType<typeof ShapeObservationAccumulator.createEmpty>>();
    const obs = ShapeObservationAccumulator.createEmpty('Item');
    ShapeObservationAccumulator.fold(obs, { name: 'Sword' });
    shapeCache.set('Item', obs);

    const state    = makeState();
    const noOntology = {
      logger:       noopLogger,
      shapeCache:   shapeCache as SquashageServices['shapeCache'],
      targetConfig: { input: '/tmp', output: {} } as unknown as TargetConfigInterface,
    };
    const output   = await runNode(state, { services: noOntology as unknown as SquashageServices });
    assert.equal(output,  'induced');
    assert.ok(state.inducedSchemas !== null, 'inducedSchemas should be set');
    assert.equal(state.inducedSchemas.classes.length, 1);
    // $id should use the fallback base
    const schemaId = state.inducedSchemas.classes[0]?.schemaId ?? '';
    assert.ok(schemaId.startsWith('https://example.org/'), `expected fallback base IRI in $id, got: ${schemaId}`);
  });
});
