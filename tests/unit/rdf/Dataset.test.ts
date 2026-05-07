import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Dataset } from '../../../src/rdf/Dataset.js';
import { dataFactory } from '../../../src/rdf/DataFactory.js';

const s  = dataFactory.namedNode('http://example.org/s');
const p  = dataFactory.namedNode('http://example.org/p');
const o1 = dataFactory.namedNode('http://example.org/o1');
const o2 = dataFactory.namedNode('http://example.org/o2');
const g  = dataFactory.defaultGraph();

const q1 = dataFactory.quad(s, p, o1, g);
const q2 = dataFactory.quad(s, p, o2, g);

describe('Dataset', () => {
  describe('from(iterable)', () => {
    it('builds a DatasetCore with the correct size from a quad array', () => {
      const ds = Dataset.from([q1, q2]);
      assert.equal(ds.size, 2);
    });

    it('returns a DatasetCore that is iterable over the original quads', () => {
      const ds = Dataset.from([q1, q2]);
      const collected = [...ds];
      assert.equal(collected.length, 2);
    });
  });

  describe('from(DatasetCore)', () => {
    it('round-trips a DatasetCore preserving all quads', () => {
      const original = Dataset.from([q1, q2]);
      const copy = Dataset.from(original);
      assert.equal(copy.size, 2);
    });

    it('round-trip produces a distinct DatasetCore instance', () => {
      const original = Dataset.from([q1, q2]);
      const copy = Dataset.from(original);
      assert.notEqual(copy, original);
    });
  });

  describe('empty()', () => {
    it('returns a DatasetCore with size 0', () => {
      const empty = Dataset.empty();
      assert.equal(empty.size, 0);
    });

    it('returns distinct instances on repeated calls', () => {
      const a = Dataset.empty();
      const b = Dataset.empty();
      assert.notEqual(a, b);
    });
  });
});
