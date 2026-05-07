import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SyntaxValidator } from '../../../src/rdf/SyntaxValidator.js';

// ---------------------------------------------------------------------------
// Turtle
// ---------------------------------------------------------------------------

describe('SyntaxValidator.validate — turtle', () => {
  it('returns ok=true for a well-formed turtle document', async () => {
    const text = '@prefix ex: <http://example.org/> .\nex:s ex:p "hello" .';
    const result = await SyntaxValidator.validate(text, { format: 'turtle' });

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  // n3 considers an empty document a valid Turtle file (zero triples).
  it('returns ok=true for an empty turtle document (empty doc is valid Turtle)', async () => {
    const result = await SyntaxValidator.validate('', { format: 'turtle' });

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it('returns ok=false with a non-empty error message for malformed turtle', async () => {
    // Unterminated string literal — n3 rejects this.
    const text = '@prefix ex: <http://example.org/> .\nex:s ex:p "unterminated .';
    const result = await SyntaxValidator.validate(text, { format: 'turtle' });

    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    const [error] = result.errors;
    assert.ok(error !== undefined);
    assert.ok(error.message.length > 0, 'error message should be non-empty');
  });
});

// ---------------------------------------------------------------------------
// TriG
// ---------------------------------------------------------------------------

describe('SyntaxValidator.validate — trig', () => {
  it('returns ok=true for a well-formed trig document', async () => {
    const text = [
      '@prefix ex: <http://example.org/> .',
      'ex:graph {',
      '  ex:s ex:p "o" .',
      '}',
    ].join('\n');
    const result = await SyntaxValidator.validate(text, { format: 'trig' });

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it('returns ok=false with a non-empty error message for malformed trig', async () => {
    // Unclosed named graph brace.
    const text = '@prefix ex: <http://example.org/> .\nex:graph { ex:s ex:p "o" .';
    const result = await SyntaxValidator.validate(text, { format: 'trig' });

    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    const [error] = result.errors;
    assert.ok(error !== undefined);
    assert.ok(error.message.length > 0, 'error message should be non-empty');
  });
});

// ---------------------------------------------------------------------------
// N-Triples
// ---------------------------------------------------------------------------

describe('SyntaxValidator.validate — ntriples', () => {
  it('returns ok=true for a well-formed N-Triples document', async () => {
    const text = '<http://example.org/s> <http://example.org/p> "o" .\n';
    const result = await SyntaxValidator.validate(text, { format: 'ntriples' });

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it('returns ok=false with a non-empty error message for malformed N-Triples', async () => {
    // N-Triples requires full IRIs in angle brackets — bare names are invalid.
    const text = 'subject predicate object .\n';
    const result = await SyntaxValidator.validate(text, { format: 'ntriples' });

    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    const [error] = result.errors;
    assert.ok(error !== undefined);
    assert.ok(error.message.length > 0, 'error message should be non-empty');
  });
});

// ---------------------------------------------------------------------------
// N-Quads
// ---------------------------------------------------------------------------

describe('SyntaxValidator.validate — nquads', () => {
  it('returns ok=true for a well-formed N-Quads document', async () => {
    const text = '<http://example.org/s> <http://example.org/p> "o" <http://example.org/g> .\n';
    const result = await SyntaxValidator.validate(text, { format: 'nquads' });

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it('returns ok=false with a non-empty error message for malformed N-Quads', async () => {
    // Malformed: subject and predicate are not valid IRIs in angle brackets.
    const text = 'not-an-iri <http://example.org/p> "o" <http://example.org/g> .\n';
    const result = await SyntaxValidator.validate(text, { format: 'nquads' });

    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    const [error] = result.errors;
    assert.ok(error !== undefined);
    assert.ok(error.message.length > 0, 'error message should be non-empty');
  });
});

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

describe('SyntaxValidator.validate — jsonld', () => {
  it('returns ok=true for a well-formed JSON-LD document', async () => {
    const doc = JSON.stringify({
      '@context': { ex: 'http://example.org/' },
      '@id':      'ex:s',
      'ex:p':     'o',
    });
    const result = await SyntaxValidator.validate(doc, { format: 'jsonld' });

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it('returns ok=false with a non-empty error message for invalid JSON', async () => {
    // JSON.parse fails immediately before jsonld.toRDF is reached.
    const result = await SyntaxValidator.validate('{ broken json !!!', { format: 'jsonld' });

    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    const [error] = result.errors;
    assert.ok(error !== undefined);
    assert.ok(error.message.length > 0, 'error message should be non-empty');
  });
});

// ---------------------------------------------------------------------------
// line / column best-effort surface
// ---------------------------------------------------------------------------

describe('SyntaxValidator.validate — line/column properties', () => {
  // n3 v2 stores location in error.context.line rather than error.line, so
  // direct line/column props are undefined on n3-backed format errors.
  // The interface reserves these fields for v1.x and parsers that do set them.
  it('error line and column are undefined for n3-backed format errors (best-effort)', async () => {
    const result = await SyntaxValidator.validate('NOT VALID TURTLE !!!', { format: 'turtle' });

    assert.equal(result.ok, false);
    const [error] = result.errors;
    assert.ok(error !== undefined);
    // n3 puts location in error.context, not as own properties — both undefined.
    assert.equal(error.line,   undefined);
    assert.equal(error.column, undefined);
  });
});
