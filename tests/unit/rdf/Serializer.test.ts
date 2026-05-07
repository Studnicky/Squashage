import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dataFactory } from '../../../src/rdf/DataFactory.js';
import { Serializer } from '../../../src/rdf/Serializer.js';
import { Parser } from '../../../src/rdf/Parser.js';
import { OutputConfigError } from '../../../src/errors/OutputConfigError.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const s  = dataFactory.namedNode('http://example.org/s');
const p  = dataFactory.namedNode('http://example.org/p');
const o  = dataFactory.literal('hello');
const g1 = dataFactory.namedNode('http://example.org/graph1');
const g2 = dataFactory.namedNode('http://example.org/graph2');
const dg = dataFactory.defaultGraph();

/** One triple in the default graph. */
const oneTriple = [dataFactory.quad(s, p, o, dg)];

/** Two quads in two distinct named graphs. */
const twoNamedGraphQuads = [
  dataFactory.quad(s, p, dataFactory.literal('g1-val'), g1),
  dataFactory.quad(s, p, dataFactory.literal('g2-val'), g2),
];

// ---------------------------------------------------------------------------
// Turtle
// ---------------------------------------------------------------------------

describe('Serializer.serialize — turtle', () => {
  it('returns a non-empty string for a single triple', async () => {
    const { data, format } = await Serializer.serialize(oneTriple, { format: 'turtle' });

    assert.ok(data.length > 0, 'serialized data should be non-empty');
    assert.equal(format, 'turtle');
  });

  it('output contains the subject and predicate IRIs', async () => {
    const { data } = await Serializer.serialize(oneTriple, { format: 'turtle' });

    assert.ok(data.includes('http://example.org/s'), 'subject IRI should appear');
    assert.ok(data.includes('http://example.org/p'), 'predicate IRI should appear');
  });

  it('emits @prefix declarations when prefixes option is supplied', async () => {
    const { data } = await Serializer.serialize(oneTriple, {
      format:   'turtle',
      prefixes: { ex: 'http://example.org/' },
    });

    // n3 v2 emits `@prefix ex: <http://example.org/>.` (no space before dot).
    assert.ok(
      data.includes('@prefix ex: <http://example.org/>'),
      'output should contain the prefix declaration',
    );
  });

  it('triple-only: named-graph quad is wrapped in a graph block by n3 (graph IRI is preserved)', async () => {
    // n3 Writer for Turtle does NOT silently drop named-graph context.
    // It wraps the triple in a `<graphIRI> { ... }` block — the graph IRI appears in output.
    // This is n3's actual behaviour for Turtle format with named-graph quads.
    const quadInNamedGraph = [dataFactory.quad(s, p, o, g1)];
    const { data } = await Serializer.serialize(quadInNamedGraph, { format: 'turtle' });

    // The triple content is written.
    assert.ok(data.includes('http://example.org/p'), 'triple content should appear');
    // n3 preserves the named graph IRI by wrapping the triple in a { } block.
    assert.ok(data.includes('http://example.org/graph1'), 'n3 preserves named graph IRI in Turtle output');
  });
});

// ---------------------------------------------------------------------------
// TriG
// ---------------------------------------------------------------------------

describe('Serializer.serialize — trig', () => {
  it('returns a non-empty string for two named-graph quads', async () => {
    const { data, format } = await Serializer.serialize(twoNamedGraphQuads, { format: 'trig' });

    assert.ok(data.length > 0, 'serialized data should be non-empty');
    assert.equal(format, 'trig');
  });

  it('output contains both named-graph IRIs', async () => {
    const { data } = await Serializer.serialize(twoNamedGraphQuads, { format: 'trig' });

    assert.ok(data.includes('http://example.org/graph1'), 'graph1 IRI should appear');
    assert.ok(data.includes('http://example.org/graph2'), 'graph2 IRI should appear');
  });
});

// ---------------------------------------------------------------------------
// N-Triples
// ---------------------------------------------------------------------------

describe('Serializer.serialize — ntriples', () => {
  it('returns a non-empty string for a single triple', async () => {
    const { data, format } = await Serializer.serialize(oneTriple, { format: 'ntriples' });

    assert.ok(data.length > 0, 'serialized data should be non-empty');
    assert.equal(format, 'ntriples');
  });

  it('output contains fully qualified IRIs (no prefix shorthand)', async () => {
    const { data } = await Serializer.serialize(oneTriple, { format: 'ntriples' });

    assert.ok(data.includes('<http://example.org/s>'), 'full IRI for subject should appear');
    assert.ok(data.includes('<http://example.org/p>'), 'full IRI for predicate should appear');
  });

  it('triple-only: named-graph quad is serialized as a 4-column line by n3 (graph IRI is preserved)', async () => {
    // n3 Writer for N-Triples does NOT strip the named-graph component.
    // It outputs a 4-column N-Quads-style line when a named-graph quad is serialized.
    // This is n3's actual behaviour for N-Triples format with named-graph quads.
    const quadInNamedGraph = [dataFactory.quad(s, p, o, g1)];
    const { data } = await Serializer.serialize(quadInNamedGraph, { format: 'ntriples' });

    assert.ok(data.includes('<http://example.org/p>'), 'triple content should appear');
    // n3 preserves the named graph IRI as a fourth column in the N-Triples output.
    assert.ok(data.includes('http://example.org/graph1'), 'n3 preserves named graph IRI in N-Triples output');
  });
});

// ---------------------------------------------------------------------------
// N-Quads
// ---------------------------------------------------------------------------

describe('Serializer.serialize — nquads', () => {
  it('returns a non-empty string for two named-graph quads', async () => {
    const { data, format } = await Serializer.serialize(twoNamedGraphQuads, { format: 'nquads' });

    assert.ok(data.length > 0, 'serialized data should be non-empty');
    assert.equal(format, 'nquads');
  });

  it('output contains both named-graph IRIs', async () => {
    const { data } = await Serializer.serialize(twoNamedGraphQuads, { format: 'nquads' });

    assert.ok(data.includes('<http://example.org/graph1>'), 'graph1 should be in output');
    assert.ok(data.includes('<http://example.org/graph2>'), 'graph2 should be in output');
  });
});

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

describe('Serializer.serialize — jsonld', () => {
  it('returns a non-empty string for two named-graph quads', async () => {
    const { data, format } = await Serializer.serialize(twoNamedGraphQuads, { format: 'jsonld' });

    assert.ok(data.length > 0, 'serialized data should be non-empty');
    assert.equal(format, 'jsonld');
  });

  it('output is valid JSON', async () => {
    const { data } = await Serializer.serialize(twoNamedGraphQuads, { format: 'jsonld' });

    assert.doesNotThrow(() => JSON.parse(data), 'output must be valid JSON');
  });

  it('output contains the subject IRI', async () => {
    const { data } = await Serializer.serialize(oneTriple, { format: 'jsonld' });

    assert.ok(data.includes('http://example.org/s'), 'subject IRI should appear in JSON-LD output');
  });
});

// ---------------------------------------------------------------------------
// Round-trip: serialize → parse → compare
// ---------------------------------------------------------------------------

describe('Serializer round-trip', () => {
  it('turtle: serialize then parse recovers the original quads', async () => {
    const { data } = await Serializer.serialize(oneTriple, {
      format:   'turtle',
      prefixes: { ex: 'http://example.org/' },
    });
    const { quads } = await Parser.parse(data, { format: 'turtle' });

    assert.equal(quads.length, 1);
    const [q] = quads;
    assert.ok(q !== undefined, 'quad should exist');
    assert.equal(q.subject.value,   s.value);
    assert.equal(q.predicate.value, p.value);
    assert.equal(q.object.value,    o.value);
  });

  it('trig: serialize then parse recovers named-graph quads', async () => {
    const { data } = await Serializer.serialize(twoNamedGraphQuads, { format: 'trig' });
    const { quads } = await Parser.parse(data, { format: 'trig' });

    assert.equal(quads.length, 2);

    const graphValues = quads.map(q => q.graph.value).sort();
    assert.deepEqual(graphValues, [g1.value, g2.value].sort());
  });

  it('ntriples: serialize then parse recovers the original triple', async () => {
    const { data } = await Serializer.serialize(oneTriple, { format: 'ntriples' });
    const { quads } = await Parser.parse(data, { format: 'ntriples' });

    assert.equal(quads.length, 1);
    const [q] = quads;
    assert.ok(q !== undefined, 'quad should exist');
    assert.equal(q.subject.value,   s.value);
    assert.equal(q.predicate.value, p.value);
    assert.equal(q.object.value,    o.value);
  });

  it('nquads: serialize then parse recovers named-graph quads', async () => {
    const { data } = await Serializer.serialize(twoNamedGraphQuads, { format: 'nquads' });
    const { quads } = await Parser.parse(data, { format: 'nquads' });

    assert.equal(quads.length, 2);

    const subjectValues = quads.map(q => q.subject.value);
    assert.ok(subjectValues.every(v => v === s.value), 'all subjects should match');
  });

  it('jsonld: serialize then parse recovers the quads (via nquads bridge)', async () => {
    const { data } = await Serializer.serialize(twoNamedGraphQuads, { format: 'jsonld' });
    const { quads } = await Parser.parse(data, { format: 'jsonld' });

    // JSON-LD expands to quads — verify both object literals survived.
    const objectValues = quads.map(q => q.object.value).sort();
    assert.ok(objectValues.includes('g1-val'), 'g1-val literal should survive round-trip');
    assert.ok(objectValues.includes('g2-val'), 'g2-val literal should survive round-trip');
  });
});

// ---------------------------------------------------------------------------
// Prefix emission
// ---------------------------------------------------------------------------

describe('Serializer prefix emission', () => {
  it('turtle: output contains declared @prefix line', async () => {
    const { data } = await Serializer.serialize(oneTriple, {
      format:   'turtle',
      prefixes: { ex: 'http://example.org/' },
    });

    // n3 v2 emits `@prefix ex: <http://example.org/>.` (no space before the dot).
    assert.ok(
      data.includes('@prefix ex: <http://example.org/>'),
      `Expected "@prefix ex: <http://example.org/>." in output.\n\nActual:\n${data}`,
    );
  });

  it('turtle: output uses compact notation for terms when prefix covers the IRI', async () => {
    const { data } = await Serializer.serialize(oneTriple, {
      format:   'turtle',
      prefixes: { ex: 'http://example.org/' },
    });

    assert.ok(
      data.includes('ex:s') || data.includes('ex:p'),
      'compact prefix notation should appear in serialized Turtle',
    );
  });
});

// ---------------------------------------------------------------------------
// Unknown format
// ---------------------------------------------------------------------------

describe('Serializer error handling', () => {
  it('throws OutputConfigError for an unknown format string', async () => {
    await assert.rejects(
      // Force an unsupported format past TypeScript with a cast.
      Serializer.serialize(oneTriple, { format: 'rdfxml' as 'turtle' }),
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError, 'should throw OutputConfigError');
        return true;
      },
    );
  });
});
