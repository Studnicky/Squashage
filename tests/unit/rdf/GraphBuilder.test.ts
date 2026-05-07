import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DatasetCore, DefaultGraph, NamedNode } from '@rdfjs/types';

import { dataFactory } from '../../../src/rdf/DataFactory.js';
import { Dataset }      from '../../../src/rdf/Dataset.js';
import { GraphBuilder } from '../../../src/rdf/GraphBuilder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all quads from a DatasetCore into an array for assertions. */
function quadsFrom(ds: DatasetCore): NamedNode[] {
  return [...ds].map(q => q.subject as NamedNode);
}

// ---------------------------------------------------------------------------
// GraphBuilder
// ---------------------------------------------------------------------------

describe('GraphBuilder', () => {

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('accepts a baseIRI ending with "/"', () => {
      assert.doesNotThrow(() => new GraphBuilder('https://example.org/'));
    });

    it('accepts a baseIRI ending with "#"', () => {
      assert.doesNotThrow(() => new GraphBuilder('https://example.org/ontology#'));
    });

    it('throws when baseIRI has no trailing "/" or "#"', () => {
      assert.throws(
        () => new GraphBuilder('https://example.org'),
        /must end with/,
      );
    });

    it('throws when baseIRI ends with a path segment without delimiter', () => {
      assert.throws(
        () => new GraphBuilder('https://example.org/path'),
        /must end with/,
      );
    });

    it('throws when baseIRI is an empty string', () => {
      assert.throws(
        () => new GraphBuilder(''),
        /must end with/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // subject()
  // -------------------------------------------------------------------------

  describe('subject()', () => {
    it('resolves a local name relative to baseIRI', () => {
      const ds = Dataset.empty();
      new GraphBuilder('https://example.org/')
        .addTo(ds)
        .subject('foo')
        .add('http://example.org/p', 'bar')
        .build();

      const [quad] = [...ds];
      assert.ok(quad, 'quad should exist');
      assert.equal(quad.subject.value, 'https://example.org/foo');
    });

    it('uses an absolute IRI string verbatim', () => {
      const ds = Dataset.empty();
      new GraphBuilder('https://example.org/')
        .addTo(ds)
        .subject('https://other.org/resource')
        .add('http://example.org/p', 'bar')
        .build();

      const [quad] = [...ds];
      assert.ok(quad, 'quad should exist');
      assert.equal(quad.subject.value, 'https://other.org/resource');
    });

    it('accepts a NamedNode directly', () => {
      const ds = Dataset.empty();
      const node = dataFactory.namedNode('https://example.org/baz');
      new GraphBuilder('https://example.org/')
        .addTo(ds)
        .subject(node)
        .add('http://example.org/p', 'bar')
        .build();

      const [quad] = [...ds];
      assert.ok(quad, 'quad should exist');
      assert.equal(quad.subject.value, 'https://example.org/baz');
    });
  });

  // -------------------------------------------------------------------------
  // add()
  // -------------------------------------------------------------------------

  describe('add()', () => {
    it('emits 1 quad with the correct subject, predicate, and literal object', () => {
      const ds = Dataset.empty();
      new GraphBuilder('https://example.org/')
        .addTo(ds)
        .subject('foo')
        .add('http://example.org/p', 'bar')
        .build();

      assert.equal(ds.size, 1);
      const [quad] = [...ds];
      assert.ok(quad, 'quad should exist');
      assert.equal(quad.subject.value,   'https://example.org/foo');
      assert.equal(quad.predicate.value, 'http://example.org/p');
      assert.equal(quad.object.value,    'bar');
      assert.equal(quad.object.termType, 'Literal');
    });

    it('accepts a NamedNode as object', () => {
      const ds = Dataset.empty();
      const obj = dataFactory.namedNode('https://example.org/obj');
      new GraphBuilder('https://example.org/')
        .addTo(ds)
        .subject('foo')
        .add('http://example.org/p', obj)
        .build();

      const [quad] = [...ds];
      assert.ok(quad, 'quad should exist');
      assert.equal(quad.object.termType, 'NamedNode');
      assert.equal(quad.object.value,    'https://example.org/obj');
    });

    it('accepts a Literal as object', () => {
      const ds = Dataset.empty();
      const lit = dataFactory.literal('hello', 'en');
      new GraphBuilder('https://example.org/')
        .addTo(ds)
        .subject('foo')
        .add('http://example.org/p', lit)
        .build();

      const [quad] = [...ds];
      assert.ok(quad, 'quad should exist');
      assert.equal(quad.object.termType, 'Literal');
      assert.equal(quad.object.value,    'hello');
    });

    it('accepts a BlankNode as object', () => {
      const ds = Dataset.empty();
      const bn = dataFactory.blankNode('b0');
      new GraphBuilder('https://example.org/')
        .addTo(ds)
        .subject('foo')
        .add('http://example.org/p', bn)
        .build();

      const [quad] = [...ds];
      assert.ok(quad, 'quad should exist');
      assert.equal(quad.object.termType, 'BlankNode');
    });

    it('resolves a relative predicate string against baseIRI', () => {
      const ds = Dataset.empty();
      new GraphBuilder('https://example.org/')
        .addTo(ds)
        .subject('foo')
        .add('name', 'Foo')
        .build();

      const [quad] = [...ds];
      assert.ok(quad, 'quad should exist');
      assert.equal(quad.predicate.value, 'https://example.org/name');
    });

    it('throws when subject() has not been called', () => {
      const b = new GraphBuilder('https://example.org/');
      assert.throws(
        () => b.add('http://example.org/p', 'bar'),
        /no current subject/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // build()
  // -------------------------------------------------------------------------

  describe('build()', () => {
    it('returns the count of quads emitted', () => {
      const ds = Dataset.empty();
      const count = new GraphBuilder('https://example.org/')
        .addTo(ds)
        .subject('foo')
        .add('http://example.org/p', 'one')
        .add('http://example.org/q', 'two')
        .build();

      assert.equal(count, 2);
    });

    it('clears the internal buffer after flush so a second build() returns 0', () => {
      const ds = Dataset.empty();
      const b = new GraphBuilder('https://example.org/').addTo(ds);
      b.subject('foo').add('http://example.org/p', 'bar');
      b.build();
      const second = b.build();
      assert.equal(second, 0);
    });

    it('returns 0 when no quads have been added', () => {
      const ds = Dataset.empty();
      const count = new GraphBuilder('https://example.org/')
        .addTo(ds)
        .build();
      assert.equal(count, 0);
    });

    it('returns count even when no dataset is configured (quads are discarded)', () => {
      const count = new GraphBuilder('https://example.org/')
        .subject('foo')
        .add('http://example.org/p', 'bar')
        .build();
      assert.equal(count, 1);
    });
  });

  // -------------------------------------------------------------------------
  // addTo()
  // -------------------------------------------------------------------------

  describe('addTo()', () => {
    it('quads land in the passed dataset after build()', () => {
      const ds = Dataset.empty();
      new GraphBuilder('https://example.org/')
        .subject('foo')
        .add('http://example.org/p', 'bar')
        .addTo(ds)
        .build();

      assert.equal(ds.size, 1);
    });

    it('can be called mid-chain before subject()', () => {
      const ds = Dataset.empty();
      new GraphBuilder('https://example.org/')
        .addTo(ds)
        .subject('foo')
        .add('http://example.org/p', 'bar')
        .build();

      assert.equal(ds.size, 1);
    });

    it('returns the same GraphBuilder instance for chaining', () => {
      const ds = Dataset.empty();
      const b  = new GraphBuilder('https://example.org/');
      const returned = b.addTo(ds);
      assert.equal(returned, b);
    });
  });

  // -------------------------------------------------------------------------
  // graph()
  // -------------------------------------------------------------------------

  describe('graph()', () => {
    it('switches the named graph for subsequent quads', () => {
      const ds = Dataset.empty();
      const g1 = dataFactory.namedNode('https://example.org/graph/one');
      const g2 = dataFactory.namedNode('https://example.org/graph/two');

      new GraphBuilder('https://example.org/')
        .addTo(ds)
        .graph(g1)
        .subject('foo')
        .add('http://example.org/p', 'in-g1')
        .graph(g2)
        .subject('bar')
        .add('http://example.org/p', 'in-g2')
        .build();

      assert.equal(ds.size, 2);

      const g1quads = [...ds.match(null, null, null, g1)];
      const g2quads = [...ds.match(null, null, null, g2)];
      assert.equal(g1quads.length, 1);
      assert.equal(g2quads.length, 1);
      assert.equal(g1quads[0]?.object.value, 'in-g1');
      assert.equal(g2quads[0]?.object.value, 'in-g2');
    });

    it('switching to DefaultGraph reverts to the default graph', () => {
      const ds = Dataset.empty();
      const g1: NamedNode = dataFactory.namedNode('https://example.org/graph/one');
      const dg: DefaultGraph = dataFactory.defaultGraph();

      new GraphBuilder('https://example.org/')
        .addTo(ds)
        .graph(g1)
        .subject('foo')
        .add('http://example.org/p', 'named')
        .graph(dg)
        .subject('bar')
        .add('http://example.org/p', 'default')
        .build();

      assert.equal(ds.size, 2);

      const namedQuads   = [...ds.match(null, null, null, g1)];
      const defaultQuads = [...ds.match(null, null, null, dg)];
      assert.equal(namedQuads.length,   1);
      assert.equal(defaultQuads.length, 1);
    });

    it('quads before graph() call are not affected by the switch', () => {
      const ds = Dataset.empty();
      const g  = dataFactory.namedNode('https://example.org/graph/one');

      const b = new GraphBuilder('https://example.org/').addTo(ds);
      b.subject('foo').add('http://example.org/p', 'before-switch');
      b.graph(g);
      b.subject('bar').add('http://example.org/p', 'after-switch');
      b.build();

      const defaultQuads = [...ds.match(null, null, null, dataFactory.defaultGraph())];
      const namedQuads   = [...ds.match(null, null, null, g)];
      assert.equal(defaultQuads.length, 1);
      assert.equal(namedQuads.length,   1);
      assert.equal(defaultQuads[0]?.object.value, 'before-switch');
      assert.equal(namedQuads[0]?.object.value,   'after-switch');
    });
  });

  // -------------------------------------------------------------------------
  // Full integration: subject + add + addTo + build
  // -------------------------------------------------------------------------

  describe('integration', () => {
    it('subject().add().addTo(dataset).build() — quad lands in the passed dataset', () => {
      const ds = Dataset.empty();

      const count = new GraphBuilder('https://squashage.dev/instance/aonprd/')
        .subject('power-attack')
        .add('http://example.org/p', 'bar')
        .addTo(ds)
        .build();

      assert.equal(count, 1);
      assert.equal(ds.size, 1);

      const [quad] = [...ds];
      assert.ok(quad, 'quad should exist');
      assert.equal(quad.subject.value, 'https://squashage.dev/instance/aonprd/power-attack');
    });

    it('multiple subjects and predicates produce the correct quad set', () => {
      const ds = Dataset.empty();

      new GraphBuilder('https://example.org/')
        .addTo(ds)
        .subject('alice')
        .add('http://schema.org/name', 'Alice')
        .add('http://schema.org/age',  dataFactory.literal('30'))
        .subject('bob')
        .add('http://schema.org/name', 'Bob')
        .build();

      assert.equal(ds.size, 3);

      const aliceQuads = [...ds.match(
        dataFactory.namedNode('https://example.org/alice'),
      )];
      assert.equal(aliceQuads.length, 2);
    });

    void quadsFrom; // suppress unused import warning
  });
});
