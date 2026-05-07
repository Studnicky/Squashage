/**
 * @fileoverview Unit tests for {@link TaxonomicNarrowingClassifier}.
 *
 * @remarks
 * Tests cover:
 * - Transitive closure built correctly from a 3-level chain.
 * - [Weapon, Equipment] with Weapon subClassOf Equipment -> [Weapon] only.
 * - [Sword, Weapon, Equipment] full chain -> [Sword] only.
 * - Unrelated [Spell, Feat] -> unchanged.
 * - Single proposal -> unchanged.
 * - Empty TBox -> no-op (all proposals preserved).
 * - Disabled classifier (enabled:false) -> no-op.
 * - Audit sentinel is emitted when narrowing fires.
 *
 * @module tests/unit/classification/tasks/TaxonomicNarrowingClassifier
 * @category Classification
 * @since 0.5.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TaxonomicNarrowingClassifier } from '../../../../src/classification/tasks/TaxonomicNarrowingClassifier.js';
import type {
  PipelineStateInterface,
  ClassificationProposalInterface,
} from '../../../../src/types/PipelineState.js';
import type { Quad } from '@rdfjs/types';
import DataFactory from '@rdfjs/data-model';

// ── Helpers ────────────────────────────────────────────────────────────────────

const BASE = 'https://example.org/vocabulary#';
const OWL_SUB_CLASS_OF = 'http://www.w3.org/2002/07/owl#subClassOf';

/** Build a single owl:subClassOf quad between two class IRIs. */
function subClassOf(sub: string, sup: string): Quad {
  return DataFactory.quad(
    DataFactory.namedNode(`${BASE}${sub}`),
    DataFactory.namedNode(OWL_SUB_CLASS_OF),
    DataFactory.namedNode(`${BASE}${sup}`),
    DataFactory.defaultGraph(),
  ) as unknown as Quad;
}

/** Build a minimal PipelineStateInterface with the given proposals. */
function buildState(
  proposals: ReadonlyArray<ClassificationProposalInterface>,
  jtTbox?: ReadonlyArray<Quad>,
): PipelineStateInterface {
  // Fake jt that returns the provided tbox quads.
  const jt = jtTbox !== undefined
    ? {
        tbox: async () => jtTbox,
        shacl: async () => [],
        classMap: () => ({}),
        schemaForClassName: () => undefined,
        baseIRI: () => BASE,
        toQuads: async () => [],
      }
    : undefined;

  return {
    targetId:        'unit-target',
    source:          { target: 'unit-target', path: 'fixture.json' },
    input:           {},
    classification:  null,
    classifications: proposals,
    output:          null,
    context: jt !== undefined
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

/** Build a minimal proposal. */
function proposal(className: string, priority = 30): ClassificationProposalInterface {
  return {
    source:     'classify:rules',
    className,
    priority,
    confidence: 1,
    reasons:    [`test:${className}`],
  };
}

// ── Suite: buildClosure ────────────────────────────────────────────────────────

describe('TaxonomicNarrowingClassifier.buildClosure', () => {
  it('builds transitive closure correctly from a 3-level chain (Sword subClassOf Weapon subClassOf Equipment)', () => {
    const quads: ReadonlyArray<Quad> = [
      subClassOf('Sword',  'Weapon'),
      subClassOf('Weapon', 'Equipment'),
    ];

    const closure = TaxonomicNarrowingClassifier.buildClosure(quads);

    // Sword -> {Weapon, Equipment}
    const swordSupers = closure.get('Sword');
    assert.ok(swordSupers !== undefined, 'Sword must be in closure');
    assert.ok(swordSupers.has('Weapon'),    'Sword closure must include Weapon');
    assert.ok(swordSupers.has('Equipment'), 'Sword closure must include Equipment (transitive)');

    // Weapon -> {Equipment}
    const weaponSupers = closure.get('Weapon');
    assert.ok(weaponSupers !== undefined, 'Weapon must be in closure');
    assert.ok(weaponSupers.has('Equipment'), 'Weapon closure must include Equipment');
    assert.ok(!weaponSupers.has('Sword'),    'Weapon closure must not include Sword');

    // Equipment should not appear as a key (no superclass declared).
    assert.ok(!closure.has('Equipment'), 'Equipment must not appear as a subclass');
  });

  it('returns an empty map for an empty TBox', () => {
    const closure = TaxonomicNarrowingClassifier.buildClosure([]);
    assert.strictEqual(closure.size, 0);
  });

  it('ignores non-subClassOf quads', () => {
    const quads: ReadonlyArray<Quad> = [
      DataFactory.quad(
        DataFactory.namedNode(`${BASE}Weapon`),
        DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        DataFactory.namedNode('http://www.w3.org/2002/07/owl#Class'),
        DataFactory.defaultGraph(),
      ) as unknown as Quad,
    ];

    const closure = TaxonomicNarrowingClassifier.buildClosure(quads);
    assert.strictEqual(closure.size, 0);
  });
});

// ── Suite: execute — narrowing ─────────────────────────────────────────────────

describe('TaxonomicNarrowingClassifier — narrowing', () => {
  it('narrows [Weapon, Equipment] to [Weapon] when Weapon subClassOf Equipment', async () => {
    const tboxQuads: ReadonlyArray<Quad> = [subClassOf('Weapon', 'Equipment')];
    const classifier = TaxonomicNarrowingClassifier.create({ tboxFrom: 'ontology', enabled: true });

    const state = buildState(
      [proposal('Weapon', 30), proposal('Equipment', 30)],
      tboxQuads,
    );

    await classifier.execute(async () => {}, state);

    const realProposals = state.classifications.filter(p => !p.className.startsWith('__'));
    assert.strictEqual(realProposals.length, 1, 'only one proposal should survive');
    assert.strictEqual(realProposals[0]?.className, 'Weapon', 'Weapon (most specific) must survive');

    // Equipment should be dropped.
    assert.ok(
      !realProposals.some(p => p.className === 'Equipment'),
      'Equipment (supertype) must be dropped',
    );
  });

  it('narrows [Sword, Weapon, Equipment] to [Sword] when full chain is declared', async () => {
    const tboxQuads: ReadonlyArray<Quad> = [
      subClassOf('Sword',  'Weapon'),
      subClassOf('Weapon', 'Equipment'),
    ];
    const classifier = TaxonomicNarrowingClassifier.create({ tboxFrom: 'ontology', enabled: true });

    const state = buildState(
      [proposal('Sword', 30), proposal('Weapon', 30), proposal('Equipment', 30)],
      tboxQuads,
    );

    await classifier.execute(async () => {}, state);

    const realProposals = state.classifications.filter(p => !p.className.startsWith('__'));
    assert.strictEqual(realProposals.length, 1, 'only Sword should survive');
    assert.strictEqual(realProposals[0]?.className, 'Sword');
  });

  it('emits a __narrowing_applied__ sentinel when narrowing fires', async () => {
    const tboxQuads: ReadonlyArray<Quad> = [subClassOf('Weapon', 'Equipment')];
    const classifier = TaxonomicNarrowingClassifier.create({ tboxFrom: 'ontology', enabled: true });

    const state = buildState(
      [proposal('Weapon', 30), proposal('Equipment', 30)],
      tboxQuads,
    );

    await classifier.execute(async () => {}, state);

    const sentinel = state.classifications.find(p => p.className === '__narrowing_applied__');
    assert.ok(sentinel !== undefined, '__narrowing_applied__ sentinel must be present');
    assert.strictEqual(sentinel.source, 'classify:taxonomic-narrowing');
    assert.ok(
      sentinel.reasons.some(r => r.includes('narrowed:')),
      'sentinel reasons must include a narrowing description',
    );
  });

  it('passes through unrelated proposals [Spell, Feat] unchanged', async () => {
    const tboxQuads: ReadonlyArray<Quad> = [subClassOf('Weapon', 'Equipment')];
    const classifier = TaxonomicNarrowingClassifier.create({ tboxFrom: 'ontology', enabled: true });

    const state = buildState(
      [proposal('Spell', 30), proposal('Feat', 30)],
      tboxQuads,
    );

    await classifier.execute(async () => {}, state);

    // No sentinel should be added (no narrowing fired).
    const sentinel = state.classifications.find(p => p.className === '__narrowing_applied__');
    assert.ok(sentinel === undefined, 'no sentinel when no narrowing fires');

    // Both proposals must remain.
    const classNames = state.classifications.map(p => p.className).sort();
    assert.deepStrictEqual(classNames, ['Feat', 'Spell']);
  });

  it('passes through a single proposal unchanged', async () => {
    const tboxQuads: ReadonlyArray<Quad> = [subClassOf('Weapon', 'Equipment')];
    const classifier = TaxonomicNarrowingClassifier.create({ tboxFrom: 'ontology', enabled: true });

    const state = buildState([proposal('Weapon', 30)], tboxQuads);

    await classifier.execute(async () => {}, state);

    assert.strictEqual(state.classifications.length, 1);
    assert.strictEqual(state.classifications[0]?.className, 'Weapon');
  });

  it('is a no-op when TBox is empty (all proposals preserved)', async () => {
    const classifier = TaxonomicNarrowingClassifier.create({ tboxFrom: 'ontology', enabled: true });

    const state = buildState(
      [proposal('Weapon', 30), proposal('Equipment', 30)],
      [], // empty TBox
    );

    await classifier.execute(async () => {}, state);

    assert.strictEqual(state.classifications.length, 2);
    const classNames = state.classifications.map(p => p.className).sort();
    assert.deepStrictEqual(classNames, ['Equipment', 'Weapon']);
  });
});

// ── Suite: execute — disabled ──────────────────────────────────────────────────

describe('TaxonomicNarrowingClassifier — disabled', () => {
  it('is a no-op when enabled is false (default)', async () => {
    const tboxQuads: ReadonlyArray<Quad> = [subClassOf('Weapon', 'Equipment')];
    const classifier = TaxonomicNarrowingClassifier.create({ tboxFrom: 'ontology' }); // enabled defaults to false

    const state = buildState(
      [proposal('Weapon', 30), proposal('Equipment', 30)],
      tboxQuads,
    );

    let nextCalled = false;
    await classifier.execute(async () => { nextCalled = true; }, state);

    assert.ok(nextCalled, 'next() must be called');
    // No narrowing applied; both proposals survive.
    assert.strictEqual(state.classifications.length, 2);
  });

  it('is a no-op when tboxFrom=ontology but context.jt is absent', async () => {
    const classifier = TaxonomicNarrowingClassifier.create({ tboxFrom: 'ontology', enabled: true });

    // State with no context.jt.
    const state = buildState([proposal('Weapon', 30), proposal('Equipment', 30)]);

    let nextCalled = false;
    await classifier.execute(async () => { nextCalled = true; }, state);

    assert.ok(nextCalled, 'next() must be called');
    assert.strictEqual(state.classifications.length, 2);
  });
});
