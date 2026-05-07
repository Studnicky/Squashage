/**
 * @fileoverview Unit tests for {@link RdfStar} -- quoted-triple helpers.
 *
 * @remarks
 * Covers: `quoteQuad()` shape, `isSupported()` true/false cases, and a
 * lossless round-trip serialization through the n3 TriG-star writer.
 *
 * @category RDF
 * @since 0.5.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RdfStar }     from '../../../src/rdf/RdfStar.js';
import { dataFactory } from '../../../src/rdf/DataFactory.js';
import { Serializer }  from '../../../src/rdf/Serializer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const subject   = dataFactory.namedNode('http://example.org/record/1');
const rdfType   = dataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
const classNode = dataFactory.namedNode('http://example.org/vocab#Feat');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RdfStar.quoteQuad', () => {
  it('returns a Quad-shaped term (termType === "Quad")', () => {
    const quoted = RdfStar.quoteQuad(subject, rdfType, classNode);

    assert.equal(quoted.termType, 'Quad',
      `Expected termType 'Quad'; got '${quoted.termType}'`);
  });

  it('quoted triple components match the supplied subject, predicate, and object', () => {
    const quoted = RdfStar.quoteQuad(subject, rdfType, classNode);

    assert.equal(quoted.subject.value,   subject.value,   'subject IRI must match');
    assert.equal(quoted.predicate.value, rdfType.value,   'predicate IRI must match');
    assert.equal(quoted.object.value,    classNode.value,  'object IRI must match');
  });

  it('can be used as the subject of an outer quad (RDF-star embedding)', () => {
    const assertedBy = dataFactory.namedNode('http://www.w3.org/ns/prov#wasGeneratedBy');
    const classifier = dataFactory.namedNode('http://example.org/classifier/Schema');

    const quoted = RdfStar.quoteQuad(subject, rdfType, classNode);
    // Must not throw when used as the subject of an outer quad.
    const outer = dataFactory.quad(quoted, assertedBy, classifier);

    assert.equal(outer.subject.termType, 'Quad',
      'The outer quad subject must be the quoted Quad term');
    assert.equal(outer.predicate.value, assertedBy.value);
    assert.equal(outer.object.value,    classifier.value);
  });
});

describe('RdfStar.isSupported', () => {
  it('returns true for application/trig-star', () => {
    assert.equal(RdfStar.isSupported('application/trig-star'), true);
  });

  it('returns true for text/turtle-star', () => {
    assert.equal(RdfStar.isSupported('text/turtle-star'), true);
  });

  it('returns true for application/n-quads-star', () => {
    assert.equal(RdfStar.isSupported('application/n-quads-star'), true);
  });

  it('returns false for plain application/n-triples (no quoted triples)', () => {
    assert.equal(RdfStar.isSupported('application/n-triples'), false,
      'Plain N-Triples does not support RDF-star');
  });

  it('returns false for application/trig (standard TriG, no star)', () => {
    assert.equal(RdfStar.isSupported('application/trig'), false,
      'Standard TriG does not support RDF-star');
  });

  it('returns false for Turtle (standard Turtle, no star)', () => {
    assert.equal(RdfStar.isSupported('Turtle'), false);
  });

  it('returns false for N-Quads (standard, no star)', () => {
    assert.equal(RdfStar.isSupported('N-Quads'), false);
  });
});

describe('RdfStar serialization round-trip via TriG-star', () => {
  it('serialising a dataset with a quoted-triple-subject quad to TriG-star produces << >> syntax', async () => {
    const assertedBy = dataFactory.namedNode('http://www.w3.org/ns/prov#wasGeneratedBy');
    const classifier = dataFactory.namedNode('http://example.org/classifier/Schema');

    const quoted = RdfStar.quoteQuad(subject, rdfType, classNode);
    const outer  = dataFactory.quad(quoted, assertedBy, classifier);

    const { data } = await Serializer.serialize([outer], {
      format:           'trig',
      n3FormatOverride: 'application/trig-star',
    });

    // TriG-star serializes quoted triples as << ... >>
    assert.ok(data.includes('<<'), `Expected '<< >>' in output; got:\n${data}`);
    assert.ok(data.length > 0, 'Output must be non-empty');
    // The subject IRI must appear inside the quoted triple markers
    assert.ok(data.includes(subject.value),   'Subject IRI must appear in output');
    assert.ok(data.includes(classNode.value),  'Class IRI must appear in output');
    assert.ok(data.includes(classifier.value), 'Classifier IRI must appear in output');
  });
});
