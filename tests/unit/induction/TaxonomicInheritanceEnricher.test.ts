/**
 * @fileoverview Unit tests for {@link TaxonomicInheritanceEnricher}.
 *
 * @remarks
 * All tests use inline fixtures only — no filesystem access.
 *
 * Covers:
 * - Empty ancestor list → returns baseQuads unchanged (same reference).
 * - Single ancestor → adds one rdf:type triple.
 * - Multiple ancestors → adds one triple per ancestor in given order.
 * - Deduplication: existing `<subject> rdf:type <ancestor>` in baseQuads
 *   is not re-emitted.
 * - Deduplication within a single call: duplicate entries in ancestorIris
 *   are collapsed.
 * - Target graph: emitted triples carry the supplied targetGraph.
 * - Determinism: same inputs → same output structure.
 * - className parameter is accepted without side-effects.
 *
 * @category Induction
 * @since 0.8.0
 */

import { describe, it } from 'node:test';
import assert            from 'node:assert/strict';

import dataFactory from '@rdfjs/data-model';
import type { DefaultGraph, NamedNode, Quad } from '@rdfjs/types';

import { TaxonomicInheritanceEnricher } from '../../../src/induction/TaxonomicInheritanceEnricher.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_IRI     = 'https://squashage.dev/vocabulary/test';
const SUBJECT_IRI  = 'https://squashage.dev/instances/test/feat-power-attack';
const RDF_TYPE     = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const CLASS_IRI    = `${BASE_IRI}#Feat`;
const PARENT_IRI   = `${BASE_IRI}#ContentEntry`;
const GRANDPARENT_IRI = `${BASE_IRI}#Thing`;
const OTHER_IRI    = `${BASE_IRI}#Action`;

const targetGraph: NamedNode    = dataFactory.namedNode('https://squashage.dev/graphs/default');
const otherGraph:  NamedNode    = dataFactory.namedNode('https://squashage.dev/graphs/other');
const defaultGraph: DefaultGraph = dataFactory.defaultGraph();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTypeQuad(subjectIri: string, classIri: string, graph: NamedNode | DefaultGraph = targetGraph): Quad {
  return dataFactory.quad(
    dataFactory.namedNode(subjectIri),
    dataFactory.namedNode(RDF_TYPE),
    dataFactory.namedNode(classIri),
    graph,
  );
}

function enrich(
  baseQuads:    Quad[],
  className:    string,
  ancestorIris: string[],
  subjectIri:   string = SUBJECT_IRI,
  graph:        NamedNode | DefaultGraph = targetGraph,
): ReadonlyArray<Quad> {
  return TaxonomicInheritanceEnricher.enrich(
    baseQuads,
    className,
    ancestorIris,
    subjectIri,
    dataFactory,
    graph,
  );
}

// ─── Empty ancestor list ──────────────────────────────────────────────────────

describe('TaxonomicInheritanceEnricher — empty ancestor list', () => {
  it('returns the same baseQuads reference when ancestorIris is empty', () => {
    const base = [makeTypeQuad(SUBJECT_IRI, CLASS_IRI)];
    const result = enrich(base, 'Feat', []);
    assert.strictEqual(result, base, 'must return the exact same array reference');
  });

  it('returns empty array unchanged when baseQuads is empty and ancestors is empty', () => {
    const result = enrich([], 'Feat', []);
    assert.strictEqual(result.length, 0);
  });
});

// ─── Single ancestor ──────────────────────────────────────────────────────────

describe('TaxonomicInheritanceEnricher — single ancestor', () => {
  it('appends one rdf:type quad for a single ancestor IRI', () => {
    const base   = [makeTypeQuad(SUBJECT_IRI, CLASS_IRI)];
    const result = enrich(base, 'Feat', [PARENT_IRI]);

    assert.equal(result.length, 2);
    const ancestorQuad = result.find(
      q => q.object.termType === 'NamedNode' && q.object.value === PARENT_IRI,
    );
    assert.ok(ancestorQuad !== undefined, 'ancestor rdf:type quad must be present');
    assert.equal(ancestorQuad.predicate.value, RDF_TYPE);
    assert.equal(ancestorQuad.subject.value, SUBJECT_IRI);
  });

  it('new quad uses the supplied targetGraph', () => {
    const base   = [makeTypeQuad(SUBJECT_IRI, CLASS_IRI, otherGraph)];
    const result = enrich(base, 'Feat', [PARENT_IRI], SUBJECT_IRI, targetGraph);

    const newQuad = result.find(q => q.object.value === PARENT_IRI);
    assert.ok(newQuad !== undefined);
    assert.equal(newQuad.graph.value, targetGraph.value);
  });
});

// ─── Multiple ancestors ───────────────────────────────────────────────────────

describe('TaxonomicInheritanceEnricher — multiple ancestors', () => {
  it('appends one quad per ancestor in given order', () => {
    const base   = [makeTypeQuad(SUBJECT_IRI, CLASS_IRI)];
    const result = enrich(base, 'Feat', [PARENT_IRI, GRANDPARENT_IRI, OTHER_IRI]);

    assert.equal(result.length, 4);
    // New quads are appended after base quads, in given order.
    assert.equal(result[1]?.object.value, PARENT_IRI);
    assert.equal(result[2]?.object.value, GRANDPARENT_IRI);
    assert.equal(result[3]?.object.value, OTHER_IRI);
  });

  it('all appended quads use the supplied targetGraph', () => {
    const base   = [makeTypeQuad(SUBJECT_IRI, CLASS_IRI)];
    const result = enrich(base, 'Feat', [PARENT_IRI, GRANDPARENT_IRI], SUBJECT_IRI, targetGraph);

    for (const quad of result.slice(1)) {
      assert.equal(quad.graph.value, targetGraph.value, `quad graph must be targetGraph; got "${quad.graph.value}"`);
    }
  });

  it('works with DefaultGraph as targetGraph', () => {
    const base   = [makeTypeQuad(SUBJECT_IRI, CLASS_IRI, defaultGraph)];
    const result = enrich(base, 'Feat', [PARENT_IRI], SUBJECT_IRI, defaultGraph);

    assert.equal(result.length, 2);
    assert.equal(result[1]?.graph.termType, 'DefaultGraph');
  });
});

// ─── Deduplication ────────────────────────────────────────────────────────────

describe('TaxonomicInheritanceEnricher — deduplication', () => {
  it('does not emit duplicate when ancestor already present in baseQuads', () => {
    const base = [
      makeTypeQuad(SUBJECT_IRI, CLASS_IRI),
      makeTypeQuad(SUBJECT_IRI, PARENT_IRI),  // already asserted
    ];
    const result = enrich(base, 'Feat', [PARENT_IRI]);

    // Should remain length 2 — no new quad for PARENT_IRI.
    assert.equal(result.length, 2);
    const parentQuads = result.filter(q =>
      q.predicate.value === RDF_TYPE && q.object.value === PARENT_IRI,
    );
    assert.equal(parentQuads.length, 1, 'exactly one rdf:type <parent> must exist');
  });

  it('deduplicates within a single call when ancestorIris has repeated entries', () => {
    const base   = [makeTypeQuad(SUBJECT_IRI, CLASS_IRI)];
    const result = enrich(base, 'Feat', [PARENT_IRI, PARENT_IRI, PARENT_IRI]);

    const parentQuads = result.filter(q => q.object.value === PARENT_IRI);
    assert.equal(parentQuads.length, 1, 'duplicate entries in ancestorIris must be collapsed');
  });

  it('only deduplicates for matching subject IRI', () => {
    const OTHER_SUBJECT = 'https://squashage.dev/instances/test/feat-other';
    const base = [
      makeTypeQuad(SUBJECT_IRI, CLASS_IRI),
      makeTypeQuad(OTHER_SUBJECT, PARENT_IRI),  // different subject
    ];
    const result = enrich(base, 'Feat', [PARENT_IRI]);

    // PARENT_IRI is present for a different subject, so it should be emitted
    // for SUBJECT_IRI.
    const subjectParentQuads = result.filter(q =>
      q.subject.value    === SUBJECT_IRI &&
      q.predicate.value  === RDF_TYPE &&
      q.object.value     === PARENT_IRI,
    );
    assert.equal(subjectParentQuads.length, 1, 'must emit rdf:type for the correct subject');
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────

describe('TaxonomicInheritanceEnricher — determinism', () => {
  it('same inputs produce identical output on repeated calls', () => {
    const base   = [makeTypeQuad(SUBJECT_IRI, CLASS_IRI)];
    const run1   = enrich(base, 'Feat', [PARENT_IRI, GRANDPARENT_IRI]);
    const run2   = enrich(base, 'Feat', [PARENT_IRI, GRANDPARENT_IRI]);

    const serialize = (quads: ReadonlyArray<Quad>): string =>
      quads.map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value} ${q.graph.value}`).join('\n');

    assert.equal(serialize(run1), serialize(run2), 'output must be byte-identical across runs');
  });

  it('order of new quads matches the order of ancestorIris', () => {
    const ancestors = [OTHER_IRI, GRANDPARENT_IRI, PARENT_IRI];
    const base      = [makeTypeQuad(SUBJECT_IRI, CLASS_IRI)];
    const result    = enrich(base, 'Feat', ancestors);

    assert.equal(result[1]?.object.value, OTHER_IRI);
    assert.equal(result[2]?.object.value, GRANDPARENT_IRI);
    assert.equal(result[3]?.object.value, PARENT_IRI);
  });
});

// ─── className parameter ─────────────────────────────────────────────────────

describe('TaxonomicInheritanceEnricher — className', () => {
  it('className does not appear in any emitted quad', () => {
    const base   = [makeTypeQuad(SUBJECT_IRI, CLASS_IRI)];
    const result = enrich(base, 'SomeArbitraryClassName', [PARENT_IRI]);

    const classNameInQuads = [...result].some(
      q => q.subject.value === 'SomeArbitraryClassName' ||
           q.predicate.value === 'SomeArbitraryClassName' ||
           q.object.value === 'SomeArbitraryClassName',
    );
    assert.equal(classNameInQuads, false, 'className must not appear in any quad term');
  });
});
