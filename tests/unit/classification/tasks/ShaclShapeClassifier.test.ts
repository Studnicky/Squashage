/**
 * @fileoverview Unit tests for {@link ShaclShapeClassifier}.
 *
 * @remarks
 * Tests cover:
 * - Record matching one shape produces one proposal with the right className.
 * - Record matching N shapes produces N proposals.
 * - Record matching zero shapes produces no proposals.
 * - `shapesFrom: 'ontology'` with no `state.context.jt` no-ops cleanly.
 * - `shapesFrom: <path>` loads the file, parses Turtle, runs validation.
 *
 * All tests use inline schemas / shapes to avoid filesystem dependencies.
 *
 * @module tests/unit/classification/tasks/ShaclShapeClassifier
 * @category Classification
 * @since 0.5.0
 */

import { describe, it, before, after } from 'node:test';
import assert  from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { JsonTologyOntology } from '../../../../src/ontology/JsonTologyOntology.js';
import { ShaclShapeClassifier } from '../../../../src/classification/tasks/ShaclShapeClassifier.js';
import { OutputConfigError } from '../../../../src/errors/OutputConfigError.js';
import type { PipelineStateInterface, ClassificationProposalInterface } from '../../../../src/types/PipelineState.js';

// ── Inline schemas ─────────────────────────────────────────────────────────────

const WIDGET_SCHEMA = {
  '$id':     'https://squashage.dev/schemas/test/widget',
  title:     'Widget',
  '$schema': 'http://json-schema.org/draft-07/schema#',
  type:      'object',
  properties: {
    name: { type: 'string' },
    sku:  { type: 'string' },
  },
  required: ['name'],
} as const;

const GADGET_SCHEMA = {
  '$id':     'https://squashage.dev/schemas/test/gadget',
  title:     'Gadget',
  '$schema': 'http://json-schema.org/draft-07/schema#',
  type:      'object',
  properties: {
    name:  { type: 'string' },
    power: { type: 'integer' },
  },
  required: ['name'],
} as const;

// ── Turtle shape fixture ───────────────────────────────────────────────────────

const PERSON_SHAPE_TURTLE = `
@prefix sh:  <http://www.w3.org/ns/shacl#> .
@prefix ex:  <https://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [
    sh:path ex:name ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
  ] .
`.trim();

// ── Helper: build minimal PipelineStateInterface ───────────────────────────────

function buildState(
  input: Record<string, unknown>,
  jt?: JsonTologyOntology,
  existingProposals: ReadonlyArray<ClassificationProposalInterface> = [],
): PipelineStateInterface {
  return {
    targetId:        'unit-target',
    source:          { target: 'unit-target', path: 'fixture.json' },
    input,
    classification:  null,
    classifications: existingProposals,
    output:          null,
    context:         jt !== undefined
      ? ({
          jt,
          target:   'unit-target',
          outDir:   '/tmp',
          config:   {},
          factory:  null as never,
          dataset:  null as never,
          builder:  null as never,
          graphs:   {},
          iri:      null as never,
          output:   null as never,
          prefixes: null as never,
        })
      : undefined,
  };
}

// ── Suite: ontology mode — single schema ───────────────────────────────────────

describe('ShaclShapeClassifier — ontology mode, single schema', () => {
  let jt: JsonTologyOntology;

  before(() => {
    jt = JsonTologyOntology.create({
      baseIRI: 'https://squashage.dev/vocabulary/test',
      schemas: [
        { schemaPath: 'widget.schema.json', schema: WIDGET_SCHEMA as unknown as Record<string, unknown> & { readonly '$id': string } },
      ],
    });
  });

  it('record matching one shape produces one proposal with the right className', async () => {
    const classifier = ShaclShapeClassifier.create({ shapesFrom: 'ontology', priority: 45 });
    const state = buildState({ name: 'Sprocket', sku: 'W-001' }, jt);

    let nextCalled = false;
    await classifier.execute(async () => { nextCalled = true; }, state);

    assert.ok(nextCalled, 'next() must be called');
    assert.strictEqual(state.classifications.length, 1);

    const [p] = state.classifications;
    assert.ok(p !== undefined);
    assert.strictEqual(p.source,    'classify:shacl-shape');
    assert.strictEqual(p.className, 'Widget');
    assert.strictEqual(p.priority,  45);
    assert.strictEqual(p.confidence, 1);
    assert.ok(p.reasons.some(r => r.includes('shacl:conforms=true')), 'reasons must include conforms=true');
  });

  it('record missing the required field produces no proposals', async () => {
    const classifier = ShaclShapeClassifier.create({ shapesFrom: 'ontology', priority: 45 });
    const state = buildState({ sku: 'W-002' }, jt);  // missing 'name'

    let nextCalled = false;
    await classifier.execute(async () => { nextCalled = true; }, state);

    assert.ok(nextCalled, 'next() must always be called');
    assert.deepStrictEqual(state.classifications, [], 'no proposals when shape does not conform');
  });

  it('uses configured priority from config', async () => {
    const classifier = ShaclShapeClassifier.create({ shapesFrom: 'ontology', priority: 99 });
    const state = buildState({ name: 'Gadget' }, jt);

    await classifier.execute(async () => {}, state);

    assert.strictEqual(state.classifications.length, 1);
    assert.strictEqual(state.classifications[0]?.priority, 99);
  });
});

// ── Suite: ontology mode — multiple schemas ────────────────────────────────────

describe('ShaclShapeClassifier — ontology mode, multiple schemas', () => {
  let jt: JsonTologyOntology;

  before(() => {
    jt = JsonTologyOntology.create({
      baseIRI: 'https://squashage.dev/vocabulary/test',
      schemas: [
        { schemaPath: 'widget.schema.json', schema: WIDGET_SCHEMA as unknown as Record<string, unknown> & { readonly '$id': string } },
        { schemaPath: 'gadget.schema.json', schema: GADGET_SCHEMA as unknown as Record<string, unknown> & { readonly '$id': string } },
      ],
    });
  });

  it('record matching N shapes produces N proposals (one per conforming shape)', async () => {
    // Both Widget and Gadget only require 'name' — so a record with 'name'
    // matches both.
    const classifier = ShaclShapeClassifier.create({ shapesFrom: 'ontology', priority: 45 });
    const state = buildState({ name: 'Multi-tool' }, jt);

    await classifier.execute(async () => {}, state);

    assert.strictEqual(state.classifications.length, 2, 'expected 2 proposals (Widget + Gadget)');
    const classNames = state.classifications.map(p => p.className).sort();
    assert.deepStrictEqual(classNames, ['Gadget', 'Widget']);
  });

  it('record conforming to zero shapes produces no proposals (classifications unchanged)', async () => {
    // No record properties match either schema's property paths.
    const classifier = ShaclShapeClassifier.create({ shapesFrom: 'ontology', priority: 45 });
    const existingProposal: ClassificationProposalInterface = {
      source: 'classify:structural', className: 'Widget', priority: 10,
      confidence: 1, reasons: ['_type=Widget'],
    };
    const state = buildState({}, jt, [existingProposal]);

    await classifier.execute(async () => {}, state);

    // The shacl classifier adds nothing; original proposal stays.
    assert.strictEqual(state.classifications.length, 1, 'original proposal must be preserved');
    assert.strictEqual(state.classifications[0]?.source, 'classify:structural');
  });

  it('proposals do not overwrite existing classifications (additive)', async () => {
    const classifier = ShaclShapeClassifier.create({ shapesFrom: 'ontology', priority: 45 });
    const prior: ClassificationProposalInterface = {
      source: 'classify:schema', className: 'Widget', priority: 30,
      confidence: 1, reasons: ['schema:Widget'],
    };
    const state = buildState({ name: 'Sprocket' }, jt, [prior]);

    await classifier.execute(async () => {}, state);

    // At least 1 new SHACL proposal + original = 2+
    assert.ok(state.classifications.length >= 2, 'must include original proposal plus new SHACL proposals');
    assert.ok(
      state.classifications.some(p => p.source === 'classify:schema'),
      'original proposal must still be present',
    );
    assert.ok(
      state.classifications.some(p => p.source === 'classify:shacl-shape'),
      'new SHACL proposal must be present',
    );
  });
});

// ── Suite: shapesFrom === 'ontology' with no jt ────────────────────────────────

describe('ShaclShapeClassifier — ontology mode, no jt', () => {
  it('no-ops cleanly when state.context.jt is undefined', async () => {
    const classifier = ShaclShapeClassifier.create({ shapesFrom: 'ontology', priority: 45 });
    const state = buildState({ name: 'test' }, undefined);

    let nextCalled = false;
    await classifier.execute(async () => { nextCalled = true; }, state);

    assert.ok(nextCalled, 'next() must be called even with no jt');
    assert.deepStrictEqual(state.classifications, [], 'no proposals when jt is absent');
  });

  it('no-ops cleanly when state.context is undefined', async () => {
    const classifier = ShaclShapeClassifier.create({ shapesFrom: 'ontology', priority: 45 });

    const state: PipelineStateInterface = {
      targetId:        'unit-target',
      source:          { target: 'unit-target', path: 'fixture.json' },
      input:           { name: 'test' },
      classification:  null,
      classifications: [],
      output:          null,
      // context is absent entirely
    };

    let nextCalled = false;
    await classifier.execute(async () => { nextCalled = true; }, state);

    assert.ok(nextCalled, 'next() must be called');
    assert.deepStrictEqual(state.classifications, []);
  });
});

// ── Suite: shapesFrom = file path ──────────────────────────────────────────────

describe('ShaclShapeClassifier — file-path mode', () => {
  let shapePath = '';

  before(async () => {
    shapePath = join(tmpdir(), `test-shapes-${Date.now()}.ttl`);
    await writeFile(shapePath, PERSON_SHAPE_TURTLE, 'utf-8');
  });

  after(async () => {
    await unlink(shapePath).catch(() => { /* ignore */ });
  });

  it('shapesFrom file path: loads Turtle, parses shapes, validates record', async () => {
    const classifier = ShaclShapeClassifier.create({ shapesFrom: shapePath, priority: 45 });
    const state = buildState({ name: 'Alice' });

    let nextCalled = false;
    await classifier.execute(async () => { nextCalled = true; }, state);

    assert.ok(nextCalled, 'next() must be called');
    assert.strictEqual(state.classifications.length, 1);

    const [p] = state.classifications;
    assert.ok(p !== undefined);
    assert.strictEqual(p.source,    'classify:shacl-shape');
    assert.strictEqual(p.className, 'Person');
    assert.strictEqual(p.priority,  45);
    assert.ok(p.reasons.some(r => r.includes('shacl:conforms=true')));
  });

  it('shapesFrom file path: record missing required field produces no proposals', async () => {
    const classifier = ShaclShapeClassifier.create({ shapesFrom: shapePath, priority: 45 });
    const state = buildState({ age: 30 });  // missing 'name'

    await classifier.execute(async () => {}, state);

    assert.deepStrictEqual(state.classifications, []);
  });

  it('shapesFrom file path: invalid path throws OutputConfigError at create time', () => {
    assert.throws(
      () => ShaclShapeClassifier.create({ shapesFrom: '/nonexistent/shapes.ttl', priority: 45 }),
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError, `Expected OutputConfigError, got ${String(err)}`);
        return true;
      },
    );
  });
});
