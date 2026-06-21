/**
 * @fileoverview Unit tests for {@link ontologyProjectionNode}.
 *
 * @remarks
 * All tests use a minimal stub services object — only the fields the node
 * reads: factory, dataset, ontology, subjectIri, graphs, logger.
 * No full SquashageServices construction; no filesystem access.
 *
 * Covers:
 * - Happy path: quads in dataset + squashedQuads, subject rebinding,
 *   graph rebinding.
 * - No-classification guard → quarantine + SQUASH_NO_CLASSIFICATION.
 * - No-ontology guard → quarantine + SQUASH_NO_ONTOLOGY.
 * - No-schema guard → quarantine + SQUASH_NO_SCHEMA_FOR_CLASS.
 * - Projection failure → quarantine + SQUASH_PROJECTION_FAILED.
 * - Subject rebinding (minted IRI replaced by policy IRI).
 * - Graph rebinding (quads land in the target named graph).
 */

import { describe, it } from 'node:test';
import assert            from 'node:assert/strict';

import dataFactory   from '@rdfjs/data-model';
import datasetFactory from '@rdfjs/dataset';
import type { DatasetCore, NamedNode, Quad } from '@rdfjs/types';

import { Batch } from '@studnicky/dagonizer';
import { ontologyProjectionNode } from '../../../../src/nodes/record/ontologyProjection.js';
import { SquashageRecordState }   from '../../../../src/state/SquashageRecordState.js';
import type { SquashageServices } from '../../../../src/services/SquashageServices.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RDF_TYPE    = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const BASE_IRI    = 'https://squashage.dev/vocabulary/test';
// Path-form class IRI: <baseIRI>/<className> (no '#' in class IRI itself).
// json-tology mints property IRIs as <classIRI>#<prop> — single '#' per RFC 3987.
const CLASS_IRI   = `${BASE_IRI}/Person`;
const MINTED_IRI  = 'https://json-tology.internal/mint/abc123';
const POLICY_IRI  = 'https://squashage.dev/instances/persons/alice';
const GRAPH_IRI   = 'https://squashage.dev/graphs/default';
const SCHEMA_ID   = 'https://squashage.dev/schemas/test/person';

const source = { target: 'test', path: '/fixtures/a.json' } as const;

// ---------------------------------------------------------------------------
// Stub builder
// ---------------------------------------------------------------------------

/** Null-object logger that satisfies ComponentLoggerInterface */
const noopLogger = {
  forComponent: () => ({
    debug: () => undefined,
    info:  () => undefined,
    warn:  () => undefined,
    error: () => undefined,
  }),
} as unknown as SquashageServices['logger'];

/** Build a fresh empty DatasetCore for each test. */
function makeDataset(): DatasetCore {
  return datasetFactory.dataset([]);
}

/** Build a named graph node for the default graph. */
function makeGraph(): NamedNode {
  return dataFactory.namedNode(GRAPH_IRI);
}

/**
 * Build the minimal SquashageServices stub that ontologyProjectionNode reads.
 *
 * @param ontology - The ontology service slot (null or a fake).
 * @param dataset  - The target dataset (shared across calls).
 */
function makeServices(
  ontology: SquashageServices['ontology'],
  dataset: DatasetCore = makeDataset(),
): Pick<SquashageServices, 'factory' | 'dataset' | 'ontology' | 'subjectIri' | 'graphs' | 'logger'> {
  return {
    factory:    dataFactory,
    dataset,
    ontology,
    subjectIri: {
      resolve: (_inst: Record<string, unknown>, _path: string, _line: number, _cls?: string) => POLICY_IRI,
    } as unknown as SquashageServices['subjectIri'],
    graphs: { default: makeGraph() } as unknown as SquashageServices['graphs'],
    logger: noopLogger,
  };
}

/**
 * Build a fake ontology service whose toQuads returns a fixed set of quads.
 *
 * @param quads            - Quads toQuads() will resolve with.
 * @param throws           - When true, toQuads() rejects.
 * @param ancestorIrisMap  - Optional map of className → ancestor IRI list.
 * @param extraClassNames  - Additional classNames schemaForClassName recognises
 *                           (in addition to 'Person').
 */
function makeFakeOntology(
  quads: Quad[] = [],
  throws = false,
  ancestorIrisMap: Readonly<Record<string, string[]>> = {},
  extraClassNames: ReadonlyArray<string> = [],
): SquashageServices['ontology'] {
  const known = new Set(['Person', ...extraClassNames]);
  return {
    baseIRI:            () => BASE_IRI,
    schemaForClassName: (name: string) =>
      (known.has(name) ? { $id: SCHEMA_ID } : undefined) as
        ReturnType<NonNullable<SquashageServices['ontology']>['schemaForClassName']>,
    toQuads: async (_schemaId: string, _instance: unknown) => {
      if (throws) throw new Error('projection error from fake ontology');
      return quads;
    },
    ancestorIris: (name: string): ReadonlyArray<string> => ancestorIrisMap[name] ?? [],
    validate: (_schemaId: string, _instance: unknown) =>
      ({ ok: true, items: [], length: 0 }) as unknown as
        ReturnType<NonNullable<SquashageServices['ontology']>['validate']>,
  } as unknown as SquashageServices['ontology'];
}

/**
 * Build a minimal set of quads that json-tology would typically return:
 *   <minted> rdf:type <classIri>
 *   <minted> <someProp> "value"
 */
function makeFakeABoxQuads(): Quad[] {
  const subject  = dataFactory.namedNode(MINTED_IRI);
  const type     = dataFactory.namedNode(RDF_TYPE);
  const classIri = dataFactory.namedNode(CLASS_IRI);
  const nameProp = dataFactory.namedNode(`${BASE_IRI}#name`);
  const nameLit  = dataFactory.literal('Alice');
  return [
    dataFactory.quad(subject, type, classIri),
    dataFactory.quad(subject, nameProp, nameLit),
  ];
}

/** Convenience: build a record state with classification set. */
function stateWithClassification(className: string): SquashageRecordState {
  const s = new SquashageRecordState(source, '/fixtures/a.json', 1);
  s.input = { name: 'Alice', email: 'alice@example.com' };
  s.classification = {
    type: className, confidence: 1, engine: 'test:rules', reasons: [],
  };
  return s;
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runNode(
  state: SquashageRecordState,
  services: Pick<SquashageServices, 'factory' | 'dataset' | 'ontology' | 'subjectIri' | 'graphs' | 'logger'>,
): Promise<string> {
  const ctx = { services: services as unknown as SquashageServices };
  const result = await ontologyProjectionNode.execute(
    Batch.of(state),
    ctx as unknown as Parameters<typeof ontologyProjectionNode.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('ontologyProjectionNode:happy-path', () => {
  it('returns squashed and writes quads to dataset', async () => {
    const fakeQuads = makeFakeABoxQuads();
    const dataset   = makeDataset();
    const services  = makeServices(makeFakeOntology(fakeQuads), dataset);
    const state     = stateWithClassification('Person');

    const result = await runNode(state, services);

    assert.equal(result, 'squashed');
    assert.ok(dataset.size > 0, 'dataset must contain quads after projection');
  });

  it('populates state.squashedQuads with the rebound quads', async () => {
    const fakeQuads = makeFakeABoxQuads();
    const services  = makeServices(makeFakeOntology(fakeQuads));
    const state     = stateWithClassification('Person');

    await runNode(state, services);

    const squashed = state.squashedQuads as Quad[];
    assert.equal(squashed.length, fakeQuads.length);
  });
});

// ---------------------------------------------------------------------------
// Guard: no classification
// ---------------------------------------------------------------------------

describe('ontologyProjectionNode:no-classification', () => {
  it('quarantines when classification is null', async () => {
    const services = makeServices(makeFakeOntology([]));
    const state    = new SquashageRecordState(source, '/fixtures/a.json', 1);
    // classification is null by default

    const result = await runNode(state, services);

    assert.equal(result, 'quarantined');
    assert.equal(state.quarantineBucket, 'projection');
    assert.ok(
      state.errors.some(e => e.code === 'SQUASH_NO_CLASSIFICATION'),
      'must collect SQUASH_NO_CLASSIFICATION error',
    );
  });
});

// ---------------------------------------------------------------------------
// Guard: no ontology
// ---------------------------------------------------------------------------

describe('ontologyProjectionNode:no-ontology', () => {
  it('quarantines when services.ontology is null', async () => {
    const services = makeServices(null);
    const state    = stateWithClassification('Person');

    const result = await runNode(state, services);

    assert.equal(result, 'quarantined');
    assert.equal(state.quarantineBucket, 'projection');
    assert.ok(
      state.errors.some(e => e.code === 'SQUASH_NO_ONTOLOGY'),
      'must collect SQUASH_NO_ONTOLOGY error',
    );
  });
});

// ---------------------------------------------------------------------------
// Guard: no schema for class
// ---------------------------------------------------------------------------

describe('ontologyProjectionNode:no-schema', () => {
  it('quarantines when schemaForClassName returns undefined', async () => {
    const services = makeServices(makeFakeOntology([]));
    const state    = stateWithClassification('UnknownClass');

    const result = await runNode(state, services);

    assert.equal(result, 'quarantined');
    assert.equal(state.quarantineBucket, 'projection');
    assert.ok(
      state.errors.some(e => e.code === 'SQUASH_NO_SCHEMA_FOR_CLASS'),
      'must collect SQUASH_NO_SCHEMA_FOR_CLASS error',
    );
  });

  it('includes className in the error context', async () => {
    const services = makeServices(makeFakeOntology([]));
    const state    = stateWithClassification('UnknownClass');

    await runNode(state, services);

    const err = state.errors.find(e => e.code === 'SQUASH_NO_SCHEMA_FOR_CLASS');
    assert.ok(err !== undefined);
    assert.equal(err.context?.['className'], 'UnknownClass');
  });
});

// ---------------------------------------------------------------------------
// Generic fallback
// ---------------------------------------------------------------------------

describe('ontologyProjectionNode:generic-fallback', () => {
  it('projects using Generic schema when className has no registered schema', async () => {
    const fakeQuads = makeFakeABoxQuads();
    // Recognise 'Generic' in the fake ontology so schemaForClassName('Generic') returns a schema.
    const services = makeServices(
      makeFakeOntology(fakeQuads, false, {}, ['Generic']),
    );
    const state = stateWithClassification('Unregistered');

    const result = await runNode(state, services);

    assert.equal(result, 'squashed');
    assert.ok(
      state.errors.length === 0,
      'must not collect errors when Generic fallback succeeds',
    );
  });

  it('emits PROJECTION_GENERIC_FALLBACK warning when Generic fallback is used', async () => {
    const fakeQuads = makeFakeABoxQuads();
    const services  = makeServices(
      makeFakeOntology(fakeQuads, false, {}, ['Generic']),
    );
    const state = stateWithClassification('Unregistered');

    await runNode(state, services);

    assert.ok(
      state.warnings.some(w => w.code === 'PROJECTION_GENERIC_FALLBACK'),
      'must emit PROJECTION_GENERIC_FALLBACK warning',
    );
  });

  it('includes className in the Generic fallback warning message', async () => {
    const fakeQuads = makeFakeABoxQuads();
    const services  = makeServices(
      makeFakeOntology(fakeQuads, false, {}, ['Generic']),
    );
    const state = stateWithClassification('Unregistered');

    await runNode(state, services);

    const warning = state.warnings.find(w => w.code === 'PROJECTION_GENERIC_FALLBACK');
    assert.ok(warning !== undefined);
    assert.ok(
      warning.message.includes('Unregistered'),
      `warning message must include the unregistered className; got: "${warning.message}"`,
    );
  });

  it('quarantines with SQUASH_NO_SCHEMA_FOR_CLASS when neither className nor Generic is registered', async () => {
    const services = makeServices(makeFakeOntology([]));
    const state    = stateWithClassification('Unregistered');

    const result = await runNode(state, services);

    assert.equal(result, 'quarantined');
    assert.equal(state.quarantineBucket, 'projection');
    assert.ok(
      state.errors.some(e => e.code === 'SQUASH_NO_SCHEMA_FOR_CLASS'),
      'must collect SQUASH_NO_SCHEMA_FOR_CLASS when no Generic schema is registered',
    );
  });
});

// ---------------------------------------------------------------------------
// Guard: projection failure
// ---------------------------------------------------------------------------

describe('ontologyProjectionNode:projection-failure', () => {
  it('quarantines when toQuads() throws', async () => {
    const services = makeServices(makeFakeOntology([], /* throws */ true));
    const state    = stateWithClassification('Person');

    const result = await runNode(state, services);

    assert.equal(result, 'quarantined');
    assert.equal(state.quarantineBucket, 'projection');
    assert.ok(
      state.errors.some(e => e.code === 'SQUASH_PROJECTION_FAILED'),
      'must collect SQUASH_PROJECTION_FAILED error',
    );
  });

  it('includes the thrown error message in context', async () => {
    const services = makeServices(makeFakeOntology([], /* throws */ true));
    const state    = stateWithClassification('Person');

    await runNode(state, services);

    const err = state.errors.find(e => e.code === 'SQUASH_PROJECTION_FAILED');
    assert.ok(err !== undefined);
    assert.ok(
      typeof err.context?.['errorMessage'] === 'string' &&
      (err.context['errorMessage'] as string).length > 0,
      'errorMessage must be a non-empty string',
    );
  });
});

// ---------------------------------------------------------------------------
// Taxonomic inheritance enrichment
// ---------------------------------------------------------------------------

describe('ontologyProjectionNode:taxonomic-inheritance', () => {
  it('emits ancestor rdf:type triples when ancestorIris returns non-empty array', async () => {
    const ANCESTOR_IRI = `${BASE_IRI}#ContentEntry`;
    const fakeQuads = makeFakeABoxQuads();
    const dataset   = makeDataset();
    const services  = makeServices(
      makeFakeOntology(fakeQuads, false, { Person: [ANCESTOR_IRI] }),
      dataset,
    );
    const state = stateWithClassification('Person');

    await runNode(state, services);

    const all = [...dataset] as Quad[];
    const ancestorTypeQuads = all.filter(
      q =>
        q.predicate.value === RDF_TYPE &&
        q.subject.value   === POLICY_IRI &&
        q.object.value    === ANCESTOR_IRI,
    );
    assert.equal(
      ancestorTypeQuads.length,
      1,
      `expected one rdf:type <${ANCESTOR_IRI}> triple; got ${ancestorTypeQuads.length.toString()}`,
    );
  });

  it('total quad count increases by ancestor count when ancestors are configured', async () => {
    const ANCESTOR_IRI_1 = `${BASE_IRI}#ContentEntry`;
    const ANCESTOR_IRI_2 = `${BASE_IRI}#Thing`;
    const fakeQuads = makeFakeABoxQuads();
    const baseCount = fakeQuads.length;

    const services = makeServices(
      makeFakeOntology(fakeQuads, false, { Person: [ANCESTOR_IRI_1, ANCESTOR_IRI_2] }),
    );
    const state = stateWithClassification('Person');

    await runNode(state, services);

    const squashed = state.squashedQuads as Quad[];
    assert.equal(
      squashed.length,
      baseCount + 2,
      `expected ${(baseCount + 2).toString()} quads (base + 2 ancestors); got ${squashed.length.toString()}`,
    );
  });

  it('no ancestor quads emitted when ancestorIris returns empty array', async () => {
    const fakeQuads = makeFakeABoxQuads();
    const baseCount = fakeQuads.length;

    const services = makeServices(makeFakeOntology(fakeQuads, false, {}));
    const state    = stateWithClassification('Person');

    await runNode(state, services);

    const squashed = state.squashedQuads as Quad[];
    assert.equal(
      squashed.length,
      baseCount,
      `expected ${baseCount.toString()} quads with no ancestors; got ${squashed.length.toString()}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Subject rebinding
// ---------------------------------------------------------------------------

describe('ontologyProjectionNode:subject-rebinding', () => {
  it('replaces the json-tology-minted subject with the policy IRI', async () => {
    const fakeQuads = makeFakeABoxQuads();  // subject = MINTED_IRI
    const dataset   = makeDataset();
    const services  = makeServices(makeFakeOntology(fakeQuads), dataset);
    const state     = stateWithClassification('Person');

    await runNode(state, services);

    const quads = [...dataset] as Quad[];
    const mintedFound = quads.some(q =>
      q.subject.termType === 'NamedNode' && q.subject.value === MINTED_IRI,
    );
    const policyFound = quads.some(q =>
      q.subject.termType === 'NamedNode' && q.subject.value === POLICY_IRI,
    );
    assert.equal(mintedFound, false, 'minted IRI must not appear in dataset');
    assert.equal(policyFound, true,  'policy IRI must appear in dataset');
  });

  it('all rebound quads use the policy subject', async () => {
    const fakeQuads = makeFakeABoxQuads();
    const services  = makeServices(makeFakeOntology(fakeQuads));
    const state     = stateWithClassification('Person');

    await runNode(state, services);

    const squashed = state.squashedQuads as Quad[];
    for (const quad of squashed) {
      assert.equal(
        quad.subject.value,
        POLICY_IRI,
        `quad subject must be the policy IRI; got "${quad.subject.value}"`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Graph rebinding
// ---------------------------------------------------------------------------

describe('ontologyProjectionNode:graph-rebinding', () => {
  it('all quads land in the target default graph', async () => {
    const fakeQuads = makeFakeABoxQuads();
    const dataset   = makeDataset();
    const services  = makeServices(makeFakeOntology(fakeQuads), dataset);
    const state     = stateWithClassification('Person');

    await runNode(state, services);

    const quads = [...dataset] as Quad[];
    for (const quad of quads) {
      assert.equal(
        quad.graph.value,
        GRAPH_IRI,
        `quad graph must be ${GRAPH_IRI}; got "${quad.graph.value}"`,
      );
    }
  });

  it('quads from toQuads with no graph are rebound to the default named graph', async () => {
    // Make quads with the default graph (no named graph) to simulate
    // json-tology output in the default graph.
    const subject  = dataFactory.namedNode(MINTED_IRI);
    const rdfType  = dataFactory.namedNode(RDF_TYPE);
    const classIri = dataFactory.namedNode(CLASS_IRI);
    const quadsInDefaultGraph: Quad[] = [
      dataFactory.quad(subject, rdfType, classIri, dataFactory.defaultGraph()),
    ];

    const dataset  = makeDataset();
    const services = makeServices(makeFakeOntology(quadsInDefaultGraph), dataset);
    const state    = stateWithClassification('Person');

    await runNode(state, services);

    const written = [...dataset] as Quad[];
    assert.equal(written.length, 1);
    assert.equal(written[0]!.graph.value, GRAPH_IRI);
  });
});
