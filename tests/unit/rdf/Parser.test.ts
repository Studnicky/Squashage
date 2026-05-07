import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Parser } from '../../../src/rdf/Parser.js';

// ---------------------------------------------------------------------------
// Turtle
// ---------------------------------------------------------------------------

describe('Parser.parse — turtle', () => {
  it('parses a simple turtle document and returns 1 quad', async () => {
    const text = '@prefix ex: <http://example.org/> .\nex:s ex:p "o" .';
    const { quads, prefixes } = await Parser.parse(text, { format: 'turtle' });

    assert.equal(quads.length, 1);
    assert.equal(prefixes['ex'], 'http://example.org/');
  });

  it('quad subject value is the expanded IRI', async () => {
    const text = '@prefix ex: <http://example.org/> .\nex:s ex:p "o" .';
    const { quads } = await Parser.parse(text, { format: 'turtle' });
    const [quad] = quads;

    assert.ok(quad !== undefined, 'quad should exist');
    assert.equal(quad.subject.value, 'http://example.org/s');
    assert.equal(quad.predicate.value, 'http://example.org/p');
    assert.equal(quad.object.value, 'o');
  });

  it('graph term is the default graph for triple-only turtle', async () => {
    const text = '@prefix ex: <http://example.org/> .\nex:s ex:p "o" .';
    const { quads } = await Parser.parse(text, { format: 'turtle' });
    const [quad] = quads;

    assert.ok(quad !== undefined, 'quad should exist');
    assert.equal(quad.graph.termType, 'DefaultGraph');
  });

  it('returns multiple prefixes when several are declared', async () => {
    const text = [
      '@prefix ex:  <http://example.org/> .',
      '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
      'ex:s ex:p "o" .',
    ].join('\n');
    const { prefixes } = await Parser.parse(text, { format: 'turtle' });

    assert.equal(prefixes['ex'],  'http://example.org/');
    assert.equal(prefixes['owl'], 'http://www.w3.org/2002/07/owl#');
  });

  it('rejects on a syntax error', async () => {
    await assert.rejects(
      Parser.parse('THIS IS NOT VALID TURTLE !!!', { format: 'turtle' }),
    );
  });
});

// ---------------------------------------------------------------------------
// TriG
// ---------------------------------------------------------------------------

describe('Parser.parse — trig', () => {
  it('parses a trig document with a named graph', async () => {
    const text = [
      '@prefix ex: <http://example.org/> .',
      'ex:graph {',
      '  ex:s ex:p "o" .',
      '}',
    ].join('\n');
    const { quads } = await Parser.parse(text, { format: 'trig' });

    assert.equal(quads.length, 1);
    const [quad] = quads;
    assert.ok(quad !== undefined, 'quad should exist');
    assert.equal(quad.graph.termType, 'NamedNode');
    assert.equal(quad.graph.value, 'http://example.org/graph');
  });

  it('carries the prefix map from trig', async () => {
    const text = [
      '@prefix ex: <http://example.org/> .',
      'ex:graph { ex:s ex:p "o" . }',
    ].join('\n');
    const { prefixes } = await Parser.parse(text, { format: 'trig' });

    assert.equal(prefixes['ex'], 'http://example.org/');
  });

  it('handles triples in the default graph alongside named graphs', async () => {
    const text = [
      '@prefix ex: <http://example.org/> .',
      'ex:s ex:p "default" .',
      'ex:graph { ex:s ex:p "named" . }',
    ].join('\n');
    const { quads } = await Parser.parse(text, { format: 'trig' });

    assert.equal(quads.length, 2);
  });
});

// ---------------------------------------------------------------------------
// N-Triples
// ---------------------------------------------------------------------------

describe('Parser.parse — ntriples', () => {
  it('parses an N-Triples document and returns 1 quad', async () => {
    const text = '<http://example.org/s> <http://example.org/p> "o" .\n';
    const { quads, prefixes } = await Parser.parse(text, { format: 'ntriples' });

    assert.equal(quads.length, 1);
    assert.deepEqual(prefixes, {}, 'N-Triples carries no prefixes');
  });

  it('quad from N-Triples has correct term values', async () => {
    const text = '<http://example.org/s> <http://example.org/p> "o" .\n';
    const { quads } = await Parser.parse(text, { format: 'ntriples' });
    const [quad] = quads;

    assert.ok(quad !== undefined, 'quad should exist');
    assert.equal(quad.subject.value,   'http://example.org/s');
    assert.equal(quad.predicate.value, 'http://example.org/p');
    assert.equal(quad.object.value,    'o');
  });

  it('handles multiple triples', async () => {
    const text = [
      '<http://example.org/s> <http://example.org/p> "a" .',
      '<http://example.org/s> <http://example.org/q> "b" .',
    ].join('\n') + '\n';
    const { quads } = await Parser.parse(text, { format: 'ntriples' });

    assert.equal(quads.length, 2);
  });
});

// ---------------------------------------------------------------------------
// N-Quads
// ---------------------------------------------------------------------------

describe('Parser.parse — nquads', () => {
  it('parses an N-Quads document and returns 1 quad', async () => {
    const text = '<http://example.org/s> <http://example.org/p> "o" <http://example.org/g> .\n';
    const { quads, prefixes } = await Parser.parse(text, { format: 'nquads' });

    assert.equal(quads.length, 1);
    assert.deepEqual(prefixes, {}, 'N-Quads carries no prefixes');
  });

  it('quad from N-Quads has the named graph IRI', async () => {
    const text = '<http://example.org/s> <http://example.org/p> "o" <http://example.org/g> .\n';
    const { quads } = await Parser.parse(text, { format: 'nquads' });
    const [quad] = quads;

    assert.ok(quad !== undefined, 'quad should exist');
    assert.equal(quad.graph.termType, 'NamedNode');
    assert.equal(quad.graph.value,    'http://example.org/g');
  });
});

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

describe('Parser.parse — jsonld', () => {
  it('parses a minimal JSON-LD document and returns 1 quad', async () => {
    const doc = JSON.stringify({
      '@context': { 'ex': 'http://example.org/' },
      '@id':      'ex:s',
      'ex:p':     'o',
    });
    const { quads } = await Parser.parse(doc, { format: 'jsonld' });

    assert.equal(quads.length, 1);
  });

  it('quad from JSON-LD has the correct subject IRI', async () => {
    const doc = JSON.stringify({
      '@context': { 'ex': 'http://example.org/' },
      '@id':      'ex:s',
      'ex:p':     'o',
    });
    const { quads } = await Parser.parse(doc, { format: 'jsonld' });
    const [quad] = quads;

    assert.ok(quad !== undefined, 'quad should exist');
    assert.equal(quad.subject.value, 'http://example.org/s');
  });

  it('returns empty prefixes for JSON-LD (no Turtle-style bindings)', async () => {
    const doc = JSON.stringify({
      '@id':  'http://example.org/s',
      'http://example.org/p': 'o',
    });
    const { prefixes } = await Parser.parse(doc, { format: 'jsonld' });

    assert.deepEqual(prefixes, {});
  });

  it('rejects on invalid JSON', async () => {
    await assert.rejects(
      Parser.parse('NOT VALID JSON', { format: 'jsonld' }),
    );
  });
});
