/**
 * Unit tests for VocabEnricher — covers all 5 DSL ops:
 *   1. arrayEnumIri
 *   2. skolemSubject
 *   3. provenanceIri
 *   4. predicateOverride
 *   5. inverseOf
 *
 * Plus curie expansion, orphan-key tolerance, and pure-function determinism.
 */

import { describe, it } from 'node:test';
import assert            from 'node:assert/strict';

import dataFactory from '@rdfjs/data-model';
import type { DefaultGraph, NamedNode, Quad } from '@rdfjs/types';

import { VocabEnricher } from '../../../src/induction/VocabEnricher.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_IRI    = 'https://example.dev/vocabulary/test';
const VOCAB       = `${BASE_IRI}#`;
const SUBJECT_IRI = 'https://example.dev/instances/test/feat-power-attack';
const RDF_TYPE    = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DCT_SOURCE  = 'http://purl.org/dc/terms/source';
const SKOS_BROADER = 'http://www.w3.org/2004/02/skos/core#broader';
const XSD_STRING  = 'http://www.w3.org/2001/XMLSchema#string';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

const targetGraph: NamedNode = dataFactory.namedNode('https://example.dev/graph/test');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function enrich(
  schema:   Record<string, unknown>,
  instance: Record<string, unknown>,
  base:     Quad[] = [],
): ReadonlyArray<Quad> {
  return VocabEnricher.enrich(
    base,
    schema,
    instance,
    SUBJECT_IRI,
    dataFactory,
    BASE_IRI,
    targetGraph,
  );
}

function quad(s: string, p: string, o: string): Quad {
  return dataFactory.quad(
    dataFactory.namedNode(s),
    dataFactory.namedNode(p),
    dataFactory.namedNode(o),
    targetGraph,
  );
}

function findQuads(quads: ReadonlyArray<Quad>, predicate: string): Quad[] {
  return quads.filter((q) => q.predicate.value === predicate);
}

// ─── arrayEnumIri ─────────────────────────────────────────────────────────────

describe('VocabEnricher — arrayEnumIri', () => {
  it('emits one IRI triple per array element', () => {
    const schema = {
      'x-squashage-array-enum-iri': { traits: 'Trait' },
    };
    const instance = { traits: ['Fire', 'Cold'] };
    const result = enrich(schema, instance);

    const traitQuads = findQuads(result, `${VOCAB}traits`);
    assert.equal(traitQuads.length, 2);

    const objects = traitQuads.map((q) => q.object.value).sort();
    assert.deepEqual(objects, [
      `${VOCAB}Trait-Cold`,
      `${VOCAB}Trait-Fire`,
    ]);
  });

  it('sanitizes non-alphanumeric characters in element values', () => {
    const schema = { 'x-squashage-array-enum-iri': { traits: 'Trait' } };
    const instance = { traits: ['magic missile', 'fire & ice'] };
    const result = enrich(schema, instance);
    const objects = findQuads(result, `${VOCAB}traits`).map((q) => q.object.value).sort();
    // ' & ' is a run of 3 non-alphanumeric chars → collapsed to single '-'
    assert.deepEqual(objects, [
      `${VOCAB}Trait-fire-ice`,
      `${VOCAB}Trait-magic-missile`,
    ]);
  });

  it('handles multiple array properties independently', () => {
    const schema = {
      'x-squashage-array-enum-iri': { traits: 'Trait', traditions: 'Tradition' },
    };
    const instance = { traits: ['Fire'], traditions: ['Arcane', 'Divine'] };
    const result = enrich(schema, instance);

    const traitQuads      = findQuads(result, `${VOCAB}traits`);
    const traditionQuads  = findQuads(result, `${VOCAB}traditions`);
    assert.equal(traitQuads.length, 1);
    assert.equal(traditionQuads.length, 2);
  });

  it('skips non-array and absent properties silently', () => {
    const schema = { 'x-squashage-array-enum-iri': { traits: 'Trait' } };
    const instance = { traits: 'not-an-array' };
    const result = enrich(schema, instance);
    assert.equal(result.length, 0);
  });

  it('skips non-string array elements', () => {
    const schema = { 'x-squashage-array-enum-iri': { traits: 'Trait' } };
    const instance = { traits: ['Fire', null, 42, 'Cold'] };
    const result = enrich(schema, instance);
    assert.equal(result.length, 2);
  });

  it('returns empty array when hint absent', () => {
    const result = enrich({}, { traits: ['Fire'] });
    assert.equal(result.length, 0);
  });

  it('uses base quads when no hints are present', () => {
    const base = [quad(SUBJECT_IRI, `${VOCAB}level`, `${VOCAB}level-1`)];
    const result = enrich({}, {}, base);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.predicate.value, `${VOCAB}level`);
  });
});

// ─── skolemSubject ────────────────────────────────────────────────────────────

describe('VocabEnricher — skolemSubject', () => {
  it('emits rdf:type on the skolem node and link from main subject', () => {
    const schema = {
      'x-squashage-skolem-subject': {
        action_cost: { fragment: 'actionCost', type: 'ActionCost' },
      },
    };
    const instance = { action_cost: 'one-action' };
    const result = enrich(schema, instance);

    const skolemIri = `${SUBJECT_IRI}#actionCost`;
    const typeQuads = result.filter(
      (q) => q.predicate.value === RDF_TYPE && q.subject.value === skolemIri,
    );
    assert.equal(typeQuads.length, 1);
    assert.equal(typeQuads[0]?.object.value, `${VOCAB}ActionCost`);

    const linkQuads = result.filter(
      (q) =>
        q.subject.value   === SUBJECT_IRI &&
        q.predicate.value === `${VOCAB}action_cost` &&
        q.object.value    === skolemIri,
    );
    assert.equal(linkQuads.length, 1);
  });

  it('emits data properties on the skolem node', () => {
    const schema = {
      'x-squashage-skolem-subject': {
        action_cost: {
          fragment: 'actionCost',
          type: 'ActionCost',
          properties: { actionSymbol: 'xsd:string' },
        },
      },
    };
    const instance = { action_cost: 'two-actions' };
    const result = enrich(schema, instance);

    const skolemIri = `${SUBJECT_IRI}#actionCost`;
    // When fieldValue is a primitive, it should be used for the single declared property
    const symbolQuads = result.filter(
      (q) =>
        q.subject.value   === skolemIri &&
        q.predicate.value === `${VOCAB}actionSymbol`,
    );
    assert.equal(symbolQuads.length, 1);
    assert.equal(symbolQuads[0]?.object.value, 'two-actions');
    assert.equal(symbolQuads[0]?.object.termType, 'Literal');
    const lit = symbolQuads[0]?.object as import('@rdfjs/types').Literal;
    assert.equal(lit.datatype.value, XSD_STRING);
  });

  it('reads nested object properties from skolem field value', () => {
    const schema = {
      'x-squashage-skolem-subject': {
        stat_block: {
          fragment: 'statBlock',
          type: 'StatBlock',
          properties: { statValue: 'xsd:integer' },
        },
      },
    };
    const instance = { stat_block: { statValue: 25 } };
    const result = enrich(schema, instance);

    const skolemIri = `${SUBJECT_IRI}#statBlock`;
    const valQuads = result.filter(
      (q) => q.subject.value === skolemIri && q.predicate.value === `${VOCAB}statValue`,
    );
    assert.equal(valQuads.length, 1);
    assert.equal(valQuads[0]?.object.value, '25');
    const lit = valQuads[0]?.object as import('@rdfjs/types').Literal;
    assert.equal(lit.datatype.value, XSD_INTEGER);
  });

  it('skips absent/null field values', () => {
    const schema = {
      'x-squashage-skolem-subject': {
        action_cost: { fragment: 'actionCost', type: 'ActionCost' },
      },
    };
    const result = enrich(schema, { action_cost: null });
    assert.equal(result.length, 0);
  });

  it('returns empty when hint absent', () => {
    const result = enrich({}, { action_cost: 'one-action' });
    assert.equal(result.length, 0);
  });
});

// ─── provenanceIri ────────────────────────────────────────────────────────────

describe('VocabEnricher — provenanceIri', () => {
  it('emits dct:source triple for top-level url field', () => {
    const schema = {
      'x-squashage-provenance': { predicate: 'dct:source', from: '/url' },
    };
    const instance = { url: 'https://example.dev/feats/power-attack' };
    const result = enrich(schema, instance);

    const sourceQuads = findQuads(result, DCT_SOURCE);
    assert.equal(sourceQuads.length, 1);
    assert.equal(sourceQuads[0]?.subject.value, SUBJECT_IRI);
    assert.equal(sourceQuads[0]?.object.value, 'https://example.dev/feats/power-attack');
    assert.equal(sourceQuads[0]?.object.termType, 'NamedNode');
  });

  it('resolves nested JSON Pointer paths', () => {
    const schema = {
      'x-squashage-provenance': { predicate: 'dct:source', from: '/_source/url' },
    };
    const instance = { _source: { url: 'https://example.dev/source/page' } };
    const result = enrich(schema, instance);

    const sourceQuads = findQuads(result, DCT_SOURCE);
    assert.equal(sourceQuads.length, 1);
    assert.equal(sourceQuads[0]?.object.value, 'https://example.dev/source/page');
  });

  it('skips when resolved value is absent', () => {
    const schema = {
      'x-squashage-provenance': { predicate: 'dct:source', from: '/url' },
    };
    const result = enrich(schema, { name: 'Power Attack' });
    assert.equal(result.length, 0);
  });

  it('skips when resolved value is not a string', () => {
    const schema = {
      'x-squashage-provenance': { predicate: 'dct:source', from: '/url' },
    };
    const result = enrich(schema, { url: 42 });
    assert.equal(result.length, 0);
  });

  it('returns empty when hint absent', () => {
    const result = enrich({}, { url: 'https://example.dev' });
    assert.equal(result.length, 0);
  });
});

// ─── predicateOverride ────────────────────────────────────────────────────────

describe('VocabEnricher — predicateOverride', () => {
  it('replaces vocab predicate with override in base quads', () => {
    const schema = {
      'x-squashage-predicate-override': { category: 'skos:broader' },
    };
    const baseQuads = [
      quad(SUBJECT_IRI, `${VOCAB}category`, `${VOCAB}TraitCategory-spell`),
    ];
    const result = enrich(schema, {}, baseQuads);

    assert.equal(result.length, 1);
    assert.equal(result[0]?.predicate.value, SKOS_BROADER);
    assert.equal(result[0]?.object.value, `${VOCAB}TraitCategory-spell`);
  });

  it('preserves unaffected quads', () => {
    const schema = {
      'x-squashage-predicate-override': { category: 'skos:broader' },
    };
    const baseQuads = [
      quad(SUBJECT_IRI, `${VOCAB}rarity`, `${VOCAB}Rarity-common`),
      quad(SUBJECT_IRI, `${VOCAB}category`, `${VOCAB}TraitCategory-weapon`),
    ];
    const result = enrich(schema, {}, baseQuads);

    assert.equal(result.length, 2);
    const rarityQuad = result.find((q) => q.predicate.value === `${VOCAB}rarity`);
    assert.ok(rarityQuad, 'rarity quad preserved');
    const categoryQuad = result.find((q) => q.predicate.value === SKOS_BROADER);
    assert.ok(categoryQuad, 'category quad rewritten');
  });

  it('expands curie predicates correctly', () => {
    const schema = {
      'x-squashage-predicate-override': { category: 'skos:broader' },
    };
    const base = [quad(SUBJECT_IRI, `${VOCAB}category`, `${VOCAB}TraitCategory-spell`)];
    const result = enrich(schema, {}, base);
    assert.equal(result[0]?.predicate.value, 'http://www.w3.org/2004/02/skos/core#broader');
  });

  it('returns base quads unchanged when hint absent', () => {
    const base = [quad(SUBJECT_IRI, `${VOCAB}name`, `${VOCAB}SomeNode`)];
    const result = enrich({}, {}, base);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.predicate.value, `${VOCAB}name`);
  });
});

// ─── inverseOf ────────────────────────────────────────────────────────────────

describe('VocabEnricher — inverseOf', () => {
  it('appends inverse triple for forward triple', () => {
    const PREREQ_IRI = 'https://example.dev/instances/test/feat-shield-block';
    const schema = {
      'x-squashage-inverse-of': { hasPrerequisite: 'isPrerequisiteFor' },
    };
    const baseQuads = [
      quad(SUBJECT_IRI, `${VOCAB}hasPrerequisite`, PREREQ_IRI),
    ];
    const result = enrich(schema, {}, baseQuads);

    assert.equal(result.length, 2);
    const inverse = result.find((q) => q.predicate.value === `${VOCAB}isPrerequisiteFor`);
    assert.ok(inverse, 'inverse triple emitted');
    assert.equal(inverse?.subject.value, PREREQ_IRI);
    assert.equal(inverse?.object.value, SUBJECT_IRI);
  });

  it('does not emit inverse when object is a Literal', () => {
    const schema = {
      'x-squashage-inverse-of': { hasPrerequisite: 'isPrerequisiteFor' },
    };
    const literalQuad = dataFactory.quad(
      dataFactory.namedNode(SUBJECT_IRI),
      dataFactory.namedNode(`${VOCAB}hasPrerequisite`),
      dataFactory.literal('Shield Block'),
      targetGraph,
    );
    const result = enrich(schema, {}, [literalQuad]);
    assert.equal(result.length, 1, 'no inverse for literal object');
  });

  it('preserves base quads alongside inverse', () => {
    const PREREQ_IRI = 'https://example.dev/instances/test/feat-a';
    const schema = {
      'x-squashage-inverse-of': { hasPrerequisite: 'isPrerequisiteFor' },
    };
    const baseQuads = [
      quad(SUBJECT_IRI, `${VOCAB}rarity`,         `${VOCAB}Rarity-common`),
      quad(SUBJECT_IRI, `${VOCAB}hasPrerequisite`, PREREQ_IRI),
    ];
    const result = enrich(schema, {}, baseQuads);
    assert.equal(result.length, 3);
  });

  it('returns base quads unchanged when hint absent', () => {
    const base = [quad(SUBJECT_IRI, `${VOCAB}hasPrerequisite`, 'https://x.org/a')];
    const result = enrich({}, {}, base);
    assert.equal(result.length, 1);
  });
});

// ─── Curie expansion ─────────────────────────────────────────────────────────

describe('VocabEnricher — curie expansion', () => {
  it('expands dct: prefix', () => {
    const schema = {
      'x-squashage-provenance': { predicate: 'dct:source', from: '/url' },
    };
    const result = enrich(schema, { url: 'https://x.org/' });
    assert.equal(findQuads(result, DCT_SOURCE).length, 1);
  });

  it('expands skos: prefix', () => {
    const schema = {
      'x-squashage-predicate-override': { category: 'skos:broader' },
    };
    const base = [quad(SUBJECT_IRI, `${VOCAB}category`, `${VOCAB}Cat-a`)];
    const result = enrich(schema, {}, base);
    assert.equal(result[0]?.predicate.value, SKOS_BROADER);
  });

  it('passes through full IRIs unchanged', () => {
    const schema = {
      'x-squashage-provenance': {
        predicate: 'http://purl.org/dc/terms/source',
        from: '/url',
      },
    };
    const result = enrich(schema, { url: 'https://x.org/' });
    assert.equal(findQuads(result, DCT_SOURCE).length, 1);
  });
});

// ─── Determinism ──────────────────────────────────────────────────────────────

describe('VocabEnricher — determinism', () => {
  it('same inputs → byte-identical quad arrays (IRI order)', () => {
    const schema = {
      'x-squashage-array-enum-iri': { traits: 'Trait' },
      'x-squashage-provenance': { predicate: 'dct:source', from: '/url' },
    };
    const instance = { traits: ['Fire', 'Cold', 'Arcane'], url: 'https://x.org/feat/1' };

    const run1 = enrich(schema, instance);
    const run2 = enrich(schema, instance);

    assert.deepEqual(
      run1.map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`),
      run2.map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`),
    );
  });
});

// ─── All ops combined ────────────────────────────────────────────────────────

describe('VocabEnricher — combined ops', () => {
  it('all hints active — produces correct total quad count', () => {
    const PREREQ_IRI = 'https://example.dev/instances/test/feat-b';
    const schema = {
      'x-squashage-array-enum-iri':       { traits: 'Trait' },
      'x-squashage-provenance':           { predicate: 'dct:source', from: '/url' },
      'x-squashage-predicate-override':   { category: 'skos:broader' },
      'x-squashage-inverse-of':           { hasPrerequisite: 'isPrerequisiteFor' },
      'x-squashage-skolem-subject': {
        action_cost: {
          fragment:   'actionCost',
          type:       'ActionCost',
          properties: { actionSymbol: 'xsd:string' },
        },
      },
    };
    const instance = {
      traits:      ['Fire', 'Cold'],
      url:         'https://example.dev/feats/power-attack',
      action_cost: 'two-actions',
    };
    const baseQuads = [
      quad(SUBJECT_IRI, `${VOCAB}category`,        `${VOCAB}TraitCategory-spell`),
      quad(SUBJECT_IRI, `${VOCAB}hasPrerequisite`,  PREREQ_IRI),
    ];

    const result = enrich(schema, instance, baseQuads);

    // base(2 rewritten) + inverse(1) + arrayEnum(2) + skolem rdf:type(1) + skolem link(1) + skolem prop(1) + provenance(1) = 9
    assert.equal(result.length, 9);
  });
});
