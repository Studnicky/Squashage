/**
 * @fileoverview Unit tests for `output:provenance` task -- RDF-star encoding (Phase 7).
 *
 * @remarks
 * Covers: `encoding: "rdf-star"` produces quoted-triple subjects, default
 * encoding (omitted) still produces named-graph PROV-O, include filtering,
 * and quoted-triple component fidelity.
 *
 * @category Tasks
 * @since 0.5.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import '../../../src/tasks/provenanceEmit.js'; // side-effect register
import { TaskRegistry }    from '../../../src/registry/TaskRegistry.js';
import { dataFactory }     from '../../../src/rdf/DataFactory.js';
import { Dataset }         from '../../../src/rdf/Dataset.js';
import { GraphBuilder }    from '../../../src/rdf/GraphBuilder.js';
import { Namespaces }      from '../../../src/rdf/Namespaces.js';
import type { PipelineStateInterface, PipelineContextInterface } from '../../../src/types/PipelineState.js';
import type { OutputConfigInterface }  from '../../../src/config/OutputConfig.js';
import type { Quad }                   from '@rdfjs/types';

const provenanceTask = TaskRegistry.get('output:provenance');
const noopNext = async (): Promise<void> => {};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RDF_TYPE_IRI   = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PROV_BY_IRI    = 'http://www.w3.org/ns/prov#wasGeneratedBy';
const PROV_VALUE_IRI = 'http://www.w3.org/ns/prov#value';
const PROV_TIME_IRI  = 'http://www.w3.org/ns/prov#atTime';
const PROV_ACT_IRI   = 'http://www.w3.org/ns/prov#Activity';

const BASE_IRI       = 'https://example.org/aonprd/';
// Derived via SHA-1('/tmp/feat-power-attack.json:0').slice(0, 8) -- matches deriveRecordIri().
const RECORD_IRI     = 'https://example.org/aonprd/run/d8f772a1';
const CLASS_IRI      = 'https://example.org/vocab#Feat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const buildPrefixes = () => ({
  instances:  { prefix: 'aonprd',  base: BASE_IRI },
  graphs:     { prefix: 'aonprdg', base: 'https://example.org/graph/aonprd/' },
  vocabulary: { prefix: 'aonprd',  base: 'https://example.org/vocabulary/aonprd#' },
  source: 'fallback' as const,
});

const buildOutput = (provenance?: Record<string, unknown>): OutputConfigInterface => ({
  kind:   'file',
  path:   '/tmp/out.trig',
  ...(provenance !== undefined ? { provenance } : {}),
} as unknown as OutputConfigInterface);

/**
 * Builds a context with a pre-seeded rdf:type quad for the record subject.
 * The RDF-star helper scans the dataset for rdf:type quads to find the one
 * to quote.
 */
const buildCtxWithTypeQuad = (
  output:       OutputConfigInterface,
  dataset:      ReturnType<typeof Dataset.empty>,
  runStartTime?: string,
): PipelineContextInterface => {
  // Pre-seed an rdf:type quad that the provenance task will quote.
  const recordNode = dataFactory.namedNode(RECORD_IRI);
  const classNode  = dataFactory.namedNode(CLASS_IRI);
  const rdfType    = dataFactory.namedNode(RDF_TYPE_IRI);
  dataset.add(dataFactory.quad(recordNode, rdfType, classNode));

  return {
    target:  'aonprd',
    outDir:  '/tmp',
    config:  { recordPath: '/tmp/feat-power-attack.json', recordLine: 0 },
    factory: dataFactory,
    dataset,
    builder: new GraphBuilder(BASE_IRI),
    graphs:  {},
    iri:     Namespaces.for(BASE_IRI),
    output,
    prefixes: buildPrefixes(),
    ...(runStartTime !== undefined ? { runStartTime } : {}),
  };
};

const buildState = (
  ctx:            PipelineContextInterface,
  classification?: PipelineStateInterface['classification'],
): PipelineStateInterface => ({
  targetId:        'aonprd',
  source:          { target: 'aonprd', path: '/tmp/feat-power-attack.json' },
  input:           { name: 'Power Attack' },
  classification:  classification ?? null,
  classifications: [],
  output:          null,
  context:         ctx,
});

const buildClassification = (): NonNullable<PipelineStateInterface['classification']> => ({
  type:       'feat',
  confidence: 0.95,
  engine:     'SchemaClassifier',
  reasons:    ['schema=feat', 'priority=40'],
});

/** Returns true when a quad has a Quad-typed subject (RDF-star). */
const isQuotedTripleSubject = (q: Quad): boolean => q.subject.termType === 'Quad';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('output:provenance — encoding: "rdf-star"', () => {
  it('encoding: "rdf-star" produces quoted-triple-subject quads in the dataset', async () => {
    const dataset = Dataset.empty();
    const output  = buildOutput({ enabled: true, encoding: 'rdf-star' });
    const ctx     = buildCtxWithTypeQuad(output, dataset, '2026-05-06T00:00:00.000Z');
    const state   = buildState(ctx, buildClassification());

    await provenanceTask(noopNext, state);

    const quads         = [...dataset] as Quad[];
    const quotedSubjQuads = quads.filter(isQuotedTripleSubject);

    assert.ok(quotedSubjQuads.length > 0,
      `Expected at least one quoted-triple-subject quad; got ${quotedSubjQuads.length.toString()}`);
  });

  it('default encoding (omitted) still produces named-graph PROV-O, not quoted triples', async () => {
    const dataset = Dataset.empty();
    // No encoding field -- defaults to "named-graph".
    const output  = buildOutput({ enabled: true });
    const ctx     = buildCtxWithTypeQuad(output, dataset, '2026-05-06T00:00:00.000Z');
    const state   = buildState(ctx, buildClassification());

    await provenanceTask(noopNext, state);

    const quads           = [...dataset] as Quad[];
    const quotedSubjQuads = quads.filter(isQuotedTripleSubject);
    const activityQuads   = quads.filter(
      q => q.predicate.value === RDF_TYPE_IRI && q.object.value === PROV_ACT_IRI,
    );

    assert.equal(quotedSubjQuads.length, 0,
      'Named-graph mode must not produce quoted-triple subjects');
    assert.ok(activityQuads.length > 0,
      'Named-graph mode must produce a prov:Activity quad');
  });

  it('encoding: "named-graph" explicit produces named-graph PROV-O, not quoted triples', async () => {
    const dataset = Dataset.empty();
    const output  = buildOutput({ enabled: true, encoding: 'named-graph' });
    const ctx     = buildCtxWithTypeQuad(output, dataset, '2026-05-06T00:00:00.000Z');
    const state   = buildState(ctx, buildClassification());

    await provenanceTask(noopNext, state);

    const quads           = [...dataset] as Quad[];
    const quotedSubjQuads = quads.filter(isQuotedTripleSubject);

    assert.equal(quotedSubjQuads.length, 0,
      'Explicit named-graph mode must not produce quoted-triple subjects');
  });

  it('each rdf:type quad has exactly one prov:wasGeneratedBy quoted-triple-subject quad', async () => {
    const dataset = Dataset.empty();
    const output  = buildOutput({
      enabled:  true,
      encoding: 'rdf-star',
      include:  ['classifier'],
    });
    const ctx   = buildCtxWithTypeQuad(output, dataset, '2026-05-06T00:00:00.000Z');
    const state = buildState(ctx, buildClassification());

    await provenanceTask(noopNext, state);

    const quads = [...dataset] as Quad[];
    const byPredicateQuads = quads.filter(
      q => isQuotedTripleSubject(q) && q.predicate.value === PROV_BY_IRI,
    );

    assert.equal(byPredicateQuads.length, 1,
      `Expected exactly 1 prov:wasGeneratedBy quoted-triple quad; got ${byPredicateQuads.length.toString()}`);
  });

  it('include: ["classifier"] only -- only prov:wasGeneratedBy emitted as quoted-triple subject', async () => {
    const dataset = Dataset.empty();
    const output  = buildOutput({
      enabled:  true,
      encoding: 'rdf-star',
      include:  ['classifier'],
    });
    const ctx   = buildCtxWithTypeQuad(output, dataset, '2026-05-06T00:00:00.000Z');
    const state = buildState(ctx, buildClassification());

    await provenanceTask(noopNext, state);

    const quads              = [...dataset] as Quad[];
    const quotedSubjQuads    = quads.filter(isQuotedTripleSubject);
    const predicates         = new Set(quotedSubjQuads.map(q => q.predicate.value));

    assert.ok(predicates.has(PROV_BY_IRI),
      'prov:wasGeneratedBy must be present');
    assert.ok(!predicates.has(PROV_VALUE_IRI),
      'prov:value must be suppressed when confidence not in include');
    assert.ok(!predicates.has(PROV_TIME_IRI),
      'prov:atTime must be suppressed when timestamp not in include');
  });

  it('quoted triple components match the underlying rdf:type quad exactly', async () => {
    const dataset = Dataset.empty();
    const output  = buildOutput({
      enabled:  true,
      encoding: 'rdf-star',
      include:  ['classifier'],
    });
    const ctx   = buildCtxWithTypeQuad(output, dataset, '2026-05-06T00:00:00.000Z');
    const state = buildState(ctx, buildClassification());

    await provenanceTask(noopNext, state);

    const quads = [...dataset] as Quad[];
    // Find the prov:wasGeneratedBy quad whose subject is a quoted triple.
    const byQuad = quads.find(
      q => isQuotedTripleSubject(q) && q.predicate.value === PROV_BY_IRI,
    );

    assert.ok(byQuad !== undefined, 'prov:wasGeneratedBy quoted-triple quad must exist');

    // The subject of `byQuad` is the quoted triple.
    const quotedTriple = byQuad.subject as Quad;
    assert.equal(quotedTriple.termType,        'Quad',      'Subject must be a Quad term');
    assert.equal(quotedTriple.subject.value,   RECORD_IRI,  'Quoted subject must be the record IRI');
    assert.equal(quotedTriple.predicate.value, RDF_TYPE_IRI, 'Quoted predicate must be rdf:type');
    assert.equal(quotedTriple.object.value,    CLASS_IRI,   'Quoted object must be the class IRI');
  });
});
