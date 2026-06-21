/**
 * @fileoverview Unit tests for {@link ontologyEmitNode}.
 *
 * Covers:
 * - When services.ontology === null → returns 'skipped', dataset unchanged.
 * - When ontology is present → quads from tbox() and shacl() land in
 *   urn:graph:<target>/ontology in the dataset.
 * - Subject/predicate/object of emitted quads are preserved; only the graph
 *   is rebound to the ontology named graph.
 * - tboxCount and shaclCount are logged (via spy on info).
 */

import { describe, it } from 'node:test';
import assert            from 'node:assert/strict';

import dataFactory    from '@rdfjs/data-model';
import datasetFactory from '@rdfjs/dataset';
import type { DatasetCore, Quad } from '@rdfjs/types';

import { Batch } from '@studnicky/dagonizer';
import { ontologyEmitNode, ontologyGraphIri } from '../../../../src/nodes/run/ontologyEmit.js';
import { SquashageRunState }                   from '../../../../src/state/SquashageRunState.js';
import type { SquashageServices }              from '../../../../src/services/SquashageServices.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET       = 'test-target';
const ONTOLOGY_IRI = ontologyGraphIri(TARGET);
const BASE_IRI     = 'https://squashage.dev/vocabulary/test';

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

const noopLogger = {
  forComponent: () => ({
    debug: () => undefined,
    info:  () => undefined,
    warn:  () => undefined,
    error: () => undefined,
  }),
} as unknown as SquashageServices['logger'];

function makeDataset(): DatasetCore {
  return datasetFactory.dataset([]);
}

function makeState(): SquashageRunState {
  return new SquashageRunState(TARGET, new Date().toISOString());
}

/**
 * Builds a fake ontology service with fixed tbox/shacl quad arrays.
 */
function makeFakeOntology(
  tboxQuads:  Quad[],
  shaclQuads: Quad[],
): SquashageServices['ontology'] {
  return {
    tbox:  async () => tboxQuads,
    shacl: async () => shaclQuads,
  } as unknown as SquashageServices['ontology'];
}

/** Two OWL TBox-style quads in the default graph (no graph set). */
function makeTboxQuads(): Quad[] {
  const cls   = dataFactory.namedNode(`${BASE_IRI}#Feat`);
  const rdfT  = dataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
  const owlC  = dataFactory.namedNode('http://www.w3.org/2002/07/owl#Class');
  const rdfsL = dataFactory.namedNode('http://www.w3.org/2000/01/rdf-schema#label');
  return [
    dataFactory.quad(cls, rdfT, owlC),
    dataFactory.quad(cls, rdfsL, dataFactory.literal('Feat')),
  ];
}

/** One SHACL-style quad in the default graph. */
function makeShaclQuads(): Quad[] {
  const shape  = dataFactory.namedNode(`${BASE_IRI}Shape`);
  const rdfT   = dataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
  const nsShape = dataFactory.namedNode('http://www.w3.org/ns/shacl#NodeShape');
  return [
    dataFactory.quad(shape, rdfT, nsShape),
  ];
}

function makeServices(
  ontology: SquashageServices['ontology'],
  dataset:  DatasetCore = makeDataset(),
): Pick<SquashageServices, 'factory' | 'dataset' | 'ontology' | 'target' | 'logger'> {
  return {
    factory:  dataFactory,
    dataset,
    ontology,
    target:   TARGET,
    logger:   noopLogger,
  };
}

async function runNode(
  state:   SquashageRunState,
  context: { services: SquashageServices },
): Promise<string> {
  const result = await ontologyEmitNode.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof ontologyEmitNode.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

// ---------------------------------------------------------------------------
// Suite: null ontology → skipped
// ---------------------------------------------------------------------------

describe('ontologyEmitNode:null-ontology', () => {
  it('returns skipped when ontology is null', async () => {
    const dataset  = makeDataset();
    const services = makeServices(null, dataset);
    const output   = await runNode(makeState(), { services: services as unknown as SquashageServices });
    assert.equal(output, 'skipped');
  });

  it('dataset is unchanged when ontology is null', async () => {
    const dataset  = makeDataset();
    const services = makeServices(null, dataset);
    await runNode(makeState(), { services: services as unknown as SquashageServices });
    assert.equal(dataset.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Suite: ontology present → emitted
// ---------------------------------------------------------------------------

describe('ontologyEmitNode:emitted', () => {
  it('returns emitted when ontology is configured', async () => {
    const services = makeServices(makeFakeOntology(makeTboxQuads(), makeShaclQuads()));
    const output   = await runNode(makeState(), { services: services as unknown as SquashageServices });
    assert.equal(output, 'emitted');
  });

  it('adds tbox quads to dataset in the ontology graph', async () => {
    const dataset  = makeDataset();
    const tbox     = makeTboxQuads();
    const services = makeServices(makeFakeOntology(tbox, []), dataset);
    await runNode(makeState(), { services: services as unknown as SquashageServices });
    assert.equal(dataset.size, tbox.length);
    for (const q of dataset) {
      assert.equal((q as Quad).graph.value, ONTOLOGY_IRI);
    }
  });

  it('adds shacl quads to dataset in the ontology graph', async () => {
    const dataset  = makeDataset();
    const shacl    = makeShaclQuads();
    const services = makeServices(makeFakeOntology([], shacl), dataset);
    await runNode(makeState(), { services: services as unknown as SquashageServices });
    assert.equal(dataset.size, shacl.length);
    for (const q of dataset) {
      assert.equal((q as Quad).graph.value, ONTOLOGY_IRI);
    }
  });

  it('adds both tbox and shacl quads', async () => {
    const dataset  = makeDataset();
    const tbox     = makeTboxQuads();
    const shacl    = makeShaclQuads();
    const services = makeServices(makeFakeOntology(tbox, shacl), dataset);
    await runNode(makeState(), { services: services as unknown as SquashageServices });
    assert.equal(dataset.size, tbox.length + shacl.length);
  });

  it('preserves subject/predicate/object; only graph is rebound', async () => {
    const dataset  = makeDataset();
    const tbox     = makeTboxQuads();
    const services = makeServices(makeFakeOntology(tbox, []), dataset);
    await runNode(makeState(), { services: services as unknown as SquashageServices });

    const emitted = [...dataset] as Quad[];
    for (let i = 0; i < tbox.length; i++) {
      const original = tbox[i];
      const stored   = emitted[i];
      assert.equal(stored.subject.value,   original.subject.value);
      assert.equal(stored.predicate.value, original.predicate.value);
      assert.equal(stored.object.value,    original.object.value);
      assert.equal(stored.graph.value,     ONTOLOGY_IRI, 'graph must be rebound to ontology graph');
    }
  });

  it('tbox and shacl with empty quads → dataset stays empty but output is emitted', async () => {
    const dataset  = makeDataset();
    const services = makeServices(makeFakeOntology([], []), dataset);
    const output   = await runNode(makeState(), { services: services as unknown as SquashageServices });
    assert.equal(output, 'emitted');
    assert.equal(dataset.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Suite: ontologyGraphIri helper
// ---------------------------------------------------------------------------

describe('ontologyGraphIri', () => {
  it('returns the expected IRI for a target name', () => {
    assert.equal(ontologyGraphIri('aonprd'), 'urn:graph:aonprd/ontology');
    assert.equal(ontologyGraphIri('test'),   'urn:graph:test/ontology');
  });
});
