import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dataFactory } from '../../../src/rdf/DataFactory.js';
import { Canonicalize } from '../../../src/rdf/Canonicalize.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a ReadonlyArray<Quad> to a sorted N-Quads string for byte-level
 * comparison.  Each quad is rendered as `<s> <p> <o> [<g>] .` and the lines
 * are sorted lexicographically, mirroring what RDFC-1.0 produces.
 *
 * This helper is intentionally minimal — it covers the term types the tests
 * exercise (NamedNode subject/predicate, Literal object, DefaultGraph / NamedNode
 * graph, BlankNode subject/object).  It is NOT a general-purpose serializer.
 */
function serializeTerm(term: { termType: string; value: string; language?: string; datatype?: { value: string } }): string {
  switch (term.termType) {
    case 'NamedNode':
      return `<${term.value}>`;
    case 'BlankNode':
      return `_:${term.value}`;
    case 'DefaultGraph':
      return '';
    case 'Literal': {
      const escaped = term.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
      if (term.language !== undefined && term.language !== '') {
        return `"${escaped}"@${term.language}`;
      }
      // xsd:string datatype is implicit in N-Quads; omit it for cleaner output
      const dt = term.datatype?.value ?? 'http://www.w3.org/2001/XMLSchema#string';
      if (dt === 'http://www.w3.org/2001/XMLSchema#string') {
        return `"${escaped}"`;
      }
      return `"${escaped}"^^<${dt}>`;
    }
    default:
      throw new Error(`Unknown termType: ${term.termType}`);
  }
}

function quadsToNQuads(quads: ReadonlyArray<{ subject: { termType: string; value: string }; predicate: { termType: string; value: string }; object: { termType: string; value: string; language?: string; datatype?: { value: string } }; graph: { termType: string; value: string } }>): string {
  const lines = quads.map(q => {
    const g = q.graph.termType === 'DefaultGraph' ? '' : ` ${serializeTerm(q.graph)}`;
    return `${serializeTerm(q.subject)} ${serializeTerm(q.predicate)} ${serializeTerm(q.object)}${g} .`;
  });
  lines.sort();
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EX = (local: string) => dataFactory.namedNode(`http://example.org/${local}`);
const dg = () => dataFactory.defaultGraph();

// A simple dataset with no blank nodes — three quads describing a person.
const SIMPLE_QUADS = [
  dataFactory.quad(EX('alice'), EX('name'),  dataFactory.literal('Alice'), dg()),
  dataFactory.quad(EX('alice'), EX('knows'), EX('bob'),                    dg()),
  dataFactory.quad(EX('bob'),   EX('name'),  dataFactory.literal('Bob'),   dg()),
];

// A dataset with blank nodes that RDFC-1.0 must stabilize.
// Non-symmetric: one blank node is the subject, the other is the object.
// The algorithm produces stable c14n0 / c14n1 identifiers regardless of
// which name ('a', 'b') was assigned at creation time.
const BLANK_QUADS = [
  dataFactory.quad(dataFactory.blankNode('a'), EX('name'), dataFactory.literal('Alice'), dg()),
  dataFactory.quad(dataFactory.blankNode('a'), EX('knows'), dataFactory.blankNode('b'), dg()),
  dataFactory.quad(dataFactory.blankNode('b'), EX('name'), dataFactory.literal('Bob'), dg()),
];

// Same logical dataset with different blank-node names and different quad
// order — the canonical output must be byte-identical to BLANK_QUADS output.
const BLANK_QUADS_REVERSED = [
  dataFactory.quad(dataFactory.blankNode('z'), EX('name'), dataFactory.literal('Bob'), dg()),
  dataFactory.quad(dataFactory.blankNode('y'), EX('knows'), dataFactory.blankNode('z'), dg()),
  dataFactory.quad(dataFactory.blankNode('y'), EX('name'), dataFactory.literal('Alice'), dg()),
];

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe('Canonicalize.run — empty input', () => {
  it('returns an empty array without throwing', async () => {
    const result = await Canonicalize.run([]);
    assert.equal(result.length, 0);
  });

  it('returns an array (not null / undefined)', async () => {
    const result = await Canonicalize.run([]);
    assert.ok(Array.isArray(result) || (Symbol.iterator in result));
  });
});

// ---------------------------------------------------------------------------
// Round-trip (no blank nodes)
// ---------------------------------------------------------------------------

describe('Canonicalize.run — round-trip without blank nodes', () => {
  it('returns the same number of quads', async () => {
    const result = await Canonicalize.run(SIMPLE_QUADS);
    assert.equal(result.length, SIMPLE_QUADS.length);
  });

  it('preserves all subject IRIs', async () => {
    const result = await Canonicalize.run(SIMPLE_QUADS);
    const subjects = new Set(result.map(q => q.subject.value));
    assert.ok(subjects.has('http://example.org/alice'));
    assert.ok(subjects.has('http://example.org/bob'));
  });

  it('preserves predicate IRIs', async () => {
    const result = await Canonicalize.run(SIMPLE_QUADS);
    const preds = new Set(result.map(q => q.predicate.value));
    assert.ok(preds.has('http://example.org/name'));
    assert.ok(preds.has('http://example.org/knows'));
  });

  it('preserves literal values', async () => {
    const result = await Canonicalize.run(SIMPLE_QUADS);
    const literals = result
      .filter(q => q.object.termType === 'Literal')
      .map(q => q.object.value);
    assert.ok(literals.includes('Alice'));
    assert.ok(literals.includes('Bob'));
  });

  it('N-Quads serializations of input and output are byte-identical for IRIs-only datasets', async () => {
    const result = await Canonicalize.run(SIMPLE_QUADS);
    const inputNq  = quadsToNQuads(SIMPLE_QUADS);
    const outputNq = quadsToNQuads(result);
    assert.equal(outputNq, inputNq);
  });
});

// ---------------------------------------------------------------------------
// Determinism (blank nodes)
// ---------------------------------------------------------------------------

/**
 * Extract the canonical suffix from a blank node value produced by the
 * n3-parse round-trip.  n3 adds a document-scoped prefix (`b<N>_`) to
 * avoid identifier collisions between separately parsed documents, so a
 * canonical identifier like `c14n0` becomes `b5_c14n0` after round-trip.
 * The suffix after the last `_c14n` fragment is what RDFC-1.0 assigned.
 */
function canonicalSuffix(bnodeValue: string): string {
  const idx = bnodeValue.lastIndexOf('_c14n');
  return idx === -1 ? bnodeValue : bnodeValue.slice(idx + 1);
}

/**
 * Normalize a quad array to a canonical string for comparison: replace each
 * blank-node value with its `c14nN` suffix and sort lines.  This strips the
 * n3-added document prefix so two independently parsed N-Quads strings from
 * the same logical graph can be compared byte-for-byte.
 */
function normalizeQuads(quads: ReadonlyArray<{ subject: { termType: string; value: string }; predicate: { termType: string; value: string }; object: { termType: string; value: string; language?: string; datatype?: { value: string } }; graph: { termType: string; value: string } }>): string {
  const normalizeTerm = (t: { termType: string; value: string; language?: string; datatype?: { value: string } }): string => {
    if (t.termType === 'BlankNode') return `_:${canonicalSuffix(t.value)}`;
    return serializeTerm(t);
  };
  const lines = quads.map(q => {
    const g = q.graph.termType === 'DefaultGraph' ? '' : ` ${normalizeTerm(q.graph)}`;
    return `${normalizeTerm(q.subject)} ${normalizeTerm(q.predicate)} ${normalizeTerm(q.object)}${g} .`;
  });
  lines.sort();
  return lines.join('\n');
}

describe('Canonicalize.run — determinism with blank nodes', () => {
  it('canonicalized output for two differently-ordered inputs produces the same canonical structure', async () => {
    const result1 = await Canonicalize.run(BLANK_QUADS);
    const result2 = await Canonicalize.run(BLANK_QUADS_REVERSED);

    // Normalize away the n3-added document prefix so we compare canonical suffixes only
    const nq1 = normalizeQuads(result1);
    const nq2 = normalizeQuads(result2);

    assert.equal(nq1, nq2, 'canonical structure must be identical regardless of input order or blank-node names');
  });

  it('blank-node identifiers in the output contain the c14nN canonical suffix', async () => {
    const result = await Canonicalize.run(BLANK_QUADS);
    const bnodes = result
      .flatMap(q => [q.subject, q.object])
      .filter(t => t.termType === 'BlankNode')
      .map(t => canonicalSuffix(t.value));
    for (const suffix of bnodes) {
      assert.match(suffix, /^c14n\d+$/, `Expected c14nN canonical suffix, got: ${suffix}`);
    }
  });

  it('returns the same quad count as the input', async () => {
    const result = await Canonicalize.run(BLANK_QUADS);
    assert.equal(result.length, BLANK_QUADS.length);
  });

  it('calling run twice on the same input produces structurally identical results', async () => {
    const a = await Canonicalize.run(BLANK_QUADS);
    const b = await Canonicalize.run(BLANK_QUADS);
    // Normalize away n3 document prefix — canonical structure must be identical
    assert.equal(normalizeQuads(a), normalizeQuads(b));
  });
});

// ---------------------------------------------------------------------------
// Term structure of returned quads
// ---------------------------------------------------------------------------

describe('Canonicalize.run — returned quad term structure', () => {
  it('each quad has subject, predicate, object, graph fields', async () => {
    const result = await Canonicalize.run(SIMPLE_QUADS);
    for (const q of result) {
      assert.ok('subject'   in q, 'quad must have subject');
      assert.ok('predicate' in q, 'quad must have predicate');
      assert.ok('object'    in q, 'quad must have object');
      assert.ok('graph'     in q, 'quad must have graph');
    }
  });

  it('each term has a termType string field', async () => {
    const result = await Canonicalize.run(SIMPLE_QUADS);
    for (const q of result) {
      assert.equal(typeof q.subject.termType,   'string');
      assert.equal(typeof q.predicate.termType, 'string');
      assert.equal(typeof q.object.termType,    'string');
      assert.equal(typeof q.graph.termType,     'string');
    }
  });

  it('subjects from IRI-only dataset are NamedNode', async () => {
    const result = await Canonicalize.run(SIMPLE_QUADS);
    for (const q of result) {
      assert.equal(q.subject.termType, 'NamedNode');
    }
  });
});
