/**
 * Unit tests for TermGuards.
 *
 * Fixtures are hand-rolled (no DataFactory dependency) so these tests are
 * isolated from W2 (DataFactory implementation). Each fixture implements the
 * minimal shape required by the @rdfjs/types Term union.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { NamedNode, Literal, BlankNode, DefaultGraph, Variable, Quad, Term } from '@rdfjs/types';
import { TermGuards } from '../../../src/rdf/TermGuards.js';

// ---------------------------------------------------------------------------
// Manual fixtures — satisfy @rdfjs/types shapes without a live DataFactory.
// ---------------------------------------------------------------------------

const namedNode: NamedNode = {
  termType: 'NamedNode',
  value: 'http://example.org/subject',
  equals: () => false,
};

const literal: Literal = {
  termType: 'Literal',
  value: 'hello',
  language: '',
  datatype: namedNode,
  equals: () => false,
};

const blankNode: BlankNode = {
  termType: 'BlankNode',
  value: 'b0',
  equals: () => false,
};

const defaultGraph: DefaultGraph = {
  termType: 'DefaultGraph',
  value: '',
  equals: () => false,
};

const variable: Variable = {
  termType: 'Variable',
  value: 'x',
  equals: () => false,
};

const quad: Quad = {
  termType: 'Quad',
  value: '',
  subject: namedNode,
  predicate: namedNode,
  object: literal,
  graph: defaultGraph,
  equals: () => false,
};

/** All term fixtures paired with their canonical termType string. */
const ALL_TERMS: Array<[string, Term]> = [
  ['NamedNode', namedNode],
  ['Literal', literal],
  ['BlankNode', blankNode],
  ['DefaultGraph', defaultGraph],
  ['Variable', variable],
  ['Quad', quad],
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TermGuards', () => {
  describe('isNamedNode()', () => {
    it('returns true for a NamedNode', () => {
      assert.equal(TermGuards.isNamedNode(namedNode), true);
    });

    it('returns false for all other term types', () => {
      for (const [type, term] of ALL_TERMS) {
        if (type === 'NamedNode') continue;
        assert.equal(TermGuards.isNamedNode(term), false, `expected false for ${type}`);
      }
    });
  });

  describe('isLiteral()', () => {
    it('returns true for a Literal', () => {
      assert.equal(TermGuards.isLiteral(literal), true);
    });

    it('returns false for all other term types', () => {
      for (const [type, term] of ALL_TERMS) {
        if (type === 'Literal') continue;
        assert.equal(TermGuards.isLiteral(term), false, `expected false for ${type}`);
      }
    });
  });

  describe('isBlankNode()', () => {
    it('returns true for a BlankNode', () => {
      assert.equal(TermGuards.isBlankNode(blankNode), true);
    });

    it('returns false for all other term types', () => {
      for (const [type, term] of ALL_TERMS) {
        if (type === 'BlankNode') continue;
        assert.equal(TermGuards.isBlankNode(term), false, `expected false for ${type}`);
      }
    });
  });

  describe('isDefaultGraph()', () => {
    it('returns true for a DefaultGraph', () => {
      assert.equal(TermGuards.isDefaultGraph(defaultGraph), true);
    });

    it('returns false for all other term types', () => {
      for (const [type, term] of ALL_TERMS) {
        if (type === 'DefaultGraph') continue;
        assert.equal(TermGuards.isDefaultGraph(term), false, `expected false for ${type}`);
      }
    });
  });

  describe('isVariable()', () => {
    it('returns true for a Variable', () => {
      assert.equal(TermGuards.isVariable(variable), true);
    });

    it('returns false for all other term types', () => {
      for (const [type, term] of ALL_TERMS) {
        if (type === 'Variable') continue;
        assert.equal(TermGuards.isVariable(term), false, `expected false for ${type}`);
      }
    });
  });

  describe('isQuad()', () => {
    it('returns true for a Quad', () => {
      assert.equal(TermGuards.isQuad(quad), true);
    });

    it('returns false for all other term types', () => {
      for (const [type, term] of ALL_TERMS) {
        if (type === 'Quad') continue;
        assert.equal(TermGuards.isQuad(term), false, `expected false for ${type}`);
      }
    });
  });
});
