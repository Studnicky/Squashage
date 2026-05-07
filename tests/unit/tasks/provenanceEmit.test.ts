/**
 * @fileoverview Unit tests for the `output:provenance` built-in task.
 *
 * @remarks
 * Covers: disabled config (no-op), enabled (one prov:Activity per record),
 * partial include (only classifier), graph IRI resolution (full vs suffix),
 * timestamp determinism from runStartTime, and two-run frozen-timestamp proof.
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
// Helpers
// ---------------------------------------------------------------------------

const BASE_IRI = 'https://example.org/aonprd/';

const buildPrefixes = () => ({
  instances:  { prefix: 'aonprd',  base: BASE_IRI },
  graphs:     { prefix: 'aonprdg', base: 'https://example.org/graph/aonprd/' },
  vocabulary: { prefix: 'aonprd',  base: 'https://example.org/vocabulary/aonprd#' },
  source: 'fallback' as const,
});

const buildOutput = (provenance?: Record<string, unknown>): OutputConfigInterface => ({
  kind:   'file',
  path:   '/tmp/out.jsonld',
  ...(provenance !== undefined ? { provenance } : {}),
} as unknown as OutputConfigInterface);

const buildCtx = (
  output:  OutputConfigInterface,
  dataset: ReturnType<typeof Dataset.empty>,
  runStartTime?: string,
): PipelineContextInterface => ({
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
});

const buildState = (
  ctx:    PipelineContextInterface,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('output:provenance', () => {
  it('disabled config — no quads emitted', async () => {
    const dataset = Dataset.empty();
    const output  = buildOutput({ enabled: false });
    const ctx     = buildCtx(output, dataset);
    const state   = buildState(ctx, buildClassification());

    await provenanceTask(noopNext, state);

    assert.equal(dataset.size, 0, 'No quads should be emitted when provenance is disabled');
  });

  it('no provenance config key — no quads emitted (default disabled)', async () => {
    const dataset = Dataset.empty();
    const output  = buildOutput(); // no provenance key at all
    const ctx     = buildCtx(output, dataset);
    const state   = buildState(ctx, buildClassification());

    await provenanceTask(noopNext, state);

    assert.equal(dataset.size, 0, 'No quads emitted when provenance config is absent');
  });

  it('enabled — exactly one prov:Activity quad per record', async () => {
    const dataset = Dataset.empty();
    const output  = buildOutput({ enabled: true });
    const ctx     = buildCtx(output, dataset, '2026-05-06T00:00:00.000Z');
    const state   = buildState(ctx, buildClassification());

    await provenanceTask(noopNext, state);

    const PROV_ACTIVITY = 'http://www.w3.org/ns/prov#Activity';
    const RDF_TYPE      = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const activityQuads = [...dataset].filter(
      (q: Quad) => q.predicate.value === RDF_TYPE && q.object.value === PROV_ACTIVITY,
    );
    assert.equal(activityQuads.length, 1,
      `Expected exactly 1 prov:Activity quad; got ${activityQuads.length.toString()}`);
  });

  it('include: ["classifier"] only — only prov:wasGeneratedBy emitted (others suppressed)', async () => {
    const dataset = Dataset.empty();
    const output  = buildOutput({ enabled: true, include: ['classifier'] });
    const ctx     = buildCtx(output, dataset, '2026-05-06T00:00:00.000Z');
    const state   = buildState(ctx, buildClassification());

    await provenanceTask(noopNext, state);

    const quads         = [...dataset] as Quad[];
    const predicates    = new Set(quads.map(q => q.predicate.value));

    // Must have rdf:type (always) and prov:wasGeneratedBy.
    assert.ok(predicates.has('http://www.w3.org/ns/prov#wasGeneratedBy'),
      'Expected prov:wasGeneratedBy to be present');

    // Must NOT have confidence, timestamp, or reason predicates.
    assert.ok(!predicates.has('http://www.w3.org/ns/prov#value'),
      'prov:value must be suppressed when confidence is not in include');
    assert.ok(!predicates.has('http://www.w3.org/ns/prov#atTime'),
      'prov:atTime must be suppressed when timestamp is not in include');
    assert.ok(!predicates.has('http://www.w3.org/ns/prov#reason'),
      'prov:reason must be suppressed when reasons is not in include');
  });

  it('graph IRI resolved from config: full IRI is used as-is', async () => {
    const FULL_IRI = 'https://custom.example.org/myprov';
    const dataset  = Dataset.empty();
    const output   = buildOutput({ enabled: true, graph: FULL_IRI });
    const ctx      = buildCtx(output, dataset, '2026-05-06T00:00:00.000Z');
    const state    = buildState(ctx, buildClassification());

    await provenanceTask(noopNext, state);

    const quads     = [...dataset] as Quad[];
    const graphIris = new Set(quads.map(q => q.graph.value));
    assert.ok(graphIris.has(FULL_IRI),
      `Expected provenance graph IRI to be ${FULL_IRI}; got ${[...graphIris].join(', ')}`);
  });

  it('graph IRI resolved from config: suffix appended to runBase', async () => {
    const dataset = Dataset.empty();
    const output  = buildOutput({ enabled: true, graph: 'provenance/run1' });
    const ctx     = buildCtx(output, dataset, '2026-05-06T00:00:00.000Z');
    const state   = buildState(ctx, buildClassification());

    await provenanceTask(noopNext, state);

    const quads     = [...dataset] as Quad[];
    const graphIris = new Set(quads.map(q => q.graph.value));
    // runBase is BASE_IRI = 'https://example.org/aonprd/'
    const expected = `${BASE_IRI}provenance/run1`;
    assert.ok(graphIris.has(expected),
      `Expected graph IRI ${expected}; got ${[...graphIris].join(', ')}`);
  });

  it('timestamp uses state.context.runStartTime, not new Date()', async () => {
    const FROZEN_TS = '2026-01-01T12:00:00.000Z';
    const dataset   = Dataset.empty();
    const output    = buildOutput({ enabled: true });
    const ctx       = buildCtx(output, dataset, FROZEN_TS);
    const state     = buildState(ctx, buildClassification());

    await provenanceTask(noopNext, state);

    const quads    = [...dataset] as Quad[];
    const timeQuad = quads.find(q => q.predicate.value === 'http://www.w3.org/ns/prov#atTime');
    assert.ok(timeQuad !== undefined, 'prov:atTime quad must be present');
    assert.equal(timeQuad.object.value, FROZEN_TS,
      `Expected timestamp ${FROZEN_TS}; got ${timeQuad.object.value}`);
  });

  it('two consecutive runs over the same input produce identical timestamps (frozen-at-start)', async () => {
    const FROZEN_TS = '2026-03-15T08:30:00.000Z';
    const PROV_AT_TIME = 'http://www.w3.org/ns/prov#atTime';

    const extractTimestamp = async (): Promise<string> => {
      const dataset = Dataset.empty();
      const output  = buildOutput({ enabled: true });
      const ctx     = buildCtx(output, dataset, FROZEN_TS);
      const state   = buildState(ctx, buildClassification());
      await provenanceTask(noopNext, state);
      const quads   = [...dataset] as Quad[];
      const q       = quads.find(q => q.predicate.value === PROV_AT_TIME);
      assert.ok(q !== undefined, 'prov:atTime must be present');
      return q.object.value;
    };

    const [ts1, ts2] = await Promise.all([extractTimestamp(), extractTimestamp()]);
    assert.equal(ts1, ts2,
      `Two runs with the same frozen runStartTime must produce identical timestamps: ${ts1} vs ${ts2}`);
    assert.equal(ts1, FROZEN_TS,
      `Timestamp must equal the frozen start time ${FROZEN_TS}; got ${ts1}`);
  });
});
