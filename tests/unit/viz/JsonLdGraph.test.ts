/**
 * @fileoverview Unit tests for `JsonLdGraph.fromCompactedJsonLd` and
 * `JsonLdGraph.fromJsonLd`.
 *
 * @module tests/unit/viz/JsonLdGraph
 * @category Unit
 * @since 0.2.0
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { JsonLdGraph } from '../../../src/viz/JsonLdGraph.js';
import type { VizPayloadInterface } from '../../../src/viz/JsonLdGraph.js';

// ---------------------------------------------------------------------------
// Test 1: Empty / invalid inputs → empty payload (no throws)
// ---------------------------------------------------------------------------

describe('JsonLdGraph.fromCompactedJsonLd — empty/invalid inputs', () => {
  it('null input → empty payload', () => {
    const p = JsonLdGraph.fromCompactedJsonLd(null);
    assert.equal(p.nodes.length, 0);
    assert.equal(p.edges.length, 0);
    assert.equal(p.graphs.length, 0);
  });

  it('number input → empty payload', () => {
    const p = JsonLdGraph.fromCompactedJsonLd(42);
    assert.equal(p.nodes.length, 0);
    assert.equal(p.edges.length, 0);
  });

  it('empty object with no @id or @graph → empty payload', () => {
    const p = JsonLdGraph.fromCompactedJsonLd({});
    assert.equal(p.nodes.length, 0);
    assert.equal(p.edges.length, 0);
  });

  it('object with empty @graph → empty payload', () => {
    const p = JsonLdGraph.fromCompactedJsonLd({
      '@context': {},
      '@graph': [],
    });
    assert.equal(p.nodes.length, 0);
    assert.equal(p.edges.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Single entity, one named graph → one node, no edges
// ---------------------------------------------------------------------------

describe('JsonLdGraph.fromCompactedJsonLd — single entity, named graph', () => {
  const doc = {
    '@context': { ex: 'https://example.org/' },
    '@graph': [
      {
        '@id': 'https://example.org/graph/feats',
        '@graph': [
          { '@id': 'https://example.org/feat/1', '@type': 'https://example.org/Feat' },
        ],
      },
    ],
  };

  let payload: VizPayloadInterface;
  before(() => { payload = JsonLdGraph.fromCompactedJsonLd(doc); });

  it('produces exactly one node', () => {
    assert.equal(payload.nodes.length, 1);
  });

  it('node id is the entity @id', () => {
    assert.equal(payload.nodes[0]?.id, 'https://example.org/feat/1');
  });

  it('node classIri is the @type', () => {
    assert.equal(payload.nodes[0]?.classIri, 'https://example.org/Feat');
  });

  it('node classLabel is compacted', () => {
    assert.equal(payload.nodes[0]?.classLabel, 'ex:Feat');
  });

  it('node graphIri is the named graph IRI', () => {
    assert.equal(payload.nodes[0]?.graphIri, 'https://example.org/graph/feats');
  });

  it('produces no edges', () => {
    assert.equal(payload.edges.length, 0);
  });

  it('graphs list has one entry', () => {
    assert.equal(payload.graphs.length, 1);
    assert.equal(payload.graphs[0]?.id, 'https://example.org/graph/feats');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Two entities, one references the other → one edge
// ---------------------------------------------------------------------------

describe('JsonLdGraph.fromCompactedJsonLd — object reference produces edge', () => {
  const doc = {
    '@context': { ex: 'https://example.org/' },
    '@graph': [
      {
        '@id': 'https://example.org/a',
        'https://example.org/knows': { '@id': 'https://example.org/b' },
      },
      { '@id': 'https://example.org/b' },
    ],
  };

  let payload: VizPayloadInterface;
  before(() => { payload = JsonLdGraph.fromCompactedJsonLd(doc); });

  it('produces two nodes', () => {
    assert.equal(payload.nodes.length, 2);
  });

  it('produces exactly one edge', () => {
    assert.equal(payload.edges.length, 1);
  });

  it('edge source is entity a', () => {
    assert.equal(payload.edges[0]?.source, 'https://example.org/a');
  });

  it('edge target is entity b', () => {
    assert.equal(payload.edges[0]?.target, 'https://example.org/b');
  });

  it('edge label is compacted predicate', () => {
    assert.equal(payload.edges[0]?.label, 'ex:knows');
  });
});

// ---------------------------------------------------------------------------
// Test 4: Same predicate twice → two edges
// ---------------------------------------------------------------------------

describe('JsonLdGraph.fromCompactedJsonLd — two @id references on same predicate', () => {
  const doc = {
    '@context': { ex: 'https://example.org/' },
    '@graph': [
      {
        '@id': 'https://example.org/a',
        'https://example.org/related': [
          { '@id': 'https://example.org/b' },
          { '@id': 'https://example.org/c' },
        ],
      },
      { '@id': 'https://example.org/b' },
      { '@id': 'https://example.org/c' },
    ],
  };

  let payload: VizPayloadInterface;
  before(() => { payload = JsonLdGraph.fromCompactedJsonLd(doc); });

  it('produces three nodes', () => {
    assert.equal(payload.nodes.length, 3);
  });

  it('produces two edges', () => {
    assert.equal(payload.edges.length, 2);
  });

  it('both edges originate from entity a', () => {
    assert.ok(payload.edges.every(e => e.source === 'https://example.org/a'));
  });
});

// ---------------------------------------------------------------------------
// Test 5: Literal property → contributes to properties, not edges
// ---------------------------------------------------------------------------

describe('JsonLdGraph.fromCompactedJsonLd — literal property → node.properties', () => {
  const doc = {
    '@context': { ex: 'https://example.org/' },
    '@graph': [
      {
        '@id': 'https://example.org/a',
        'https://example.org/name': { '@value': 'Fireball' },
        'https://example.org/level': { '@value': 3 },
      },
    ],
  };

  let payload: VizPayloadInterface;
  before(() => { payload = JsonLdGraph.fromCompactedJsonLd(doc); });

  it('produces one node', () => {
    assert.equal(payload.nodes.length, 1);
  });

  it('produces no edges', () => {
    assert.equal(payload.edges.length, 0);
  });

  it('node.properties has ex:name', () => {
    const node = payload.nodes[0];
    assert.ok(node !== undefined);
    assert.ok('ex:name' in node.properties);
    assert.deepEqual(node.properties['ex:name'], ['Fireball']);
  });

  it('node.properties has ex:level', () => {
    const node = payload.nodes[0];
    assert.ok(node !== undefined);
    assert.ok('ex:level' in node.properties);
    assert.deepEqual(node.properties['ex:level'], ['3']);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Nested @graph containers → nodes carry graphIri
// ---------------------------------------------------------------------------

describe('JsonLdGraph.fromCompactedJsonLd — nested @graph containers', () => {
  const doc = {
    '@context': { ex: 'https://example.org/' },
    '@graph': [
      {
        '@id': 'https://example.org/graph/feats',
        '@graph': [
          { '@id': 'https://example.org/feat/1' },
          { '@id': 'https://example.org/feat/2' },
        ],
      },
      {
        '@id': 'https://example.org/graph/spells',
        '@graph': [
          { '@id': 'https://example.org/spell/1' },
        ],
      },
    ],
  };

  let payload: VizPayloadInterface;
  before(() => { payload = JsonLdGraph.fromCompactedJsonLd(doc); });

  it('produces three nodes', () => {
    assert.equal(payload.nodes.length, 3);
  });

  it('feat nodes carry feat graphIri', () => {
    const featNodes = payload.nodes.filter(n => n.graphIri === 'https://example.org/graph/feats');
    assert.equal(featNodes.length, 2);
  });

  it('spell node carries spell graphIri', () => {
    const spellNodes = payload.nodes.filter(n => n.graphIri === 'https://example.org/graph/spells');
    assert.equal(spellNodes.length, 1);
  });

  it('two named graphs appear in graphs list', () => {
    assert.equal(payload.graphs.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Determinism — two conversions produce deep-equal result
// ---------------------------------------------------------------------------

describe('JsonLdGraph.fromCompactedJsonLd — determinism', () => {
  const doc = {
    '@context': { ex: 'https://example.org/' },
    '@graph': [
      {
        '@id': 'https://example.org/graph/g',
        '@graph': [
          {
            '@id': 'https://example.org/a',
            '@type': 'https://example.org/Feat',
            'https://example.org/name': { '@value': 'Power Attack' },
            'https://example.org/related': { '@id': 'https://example.org/b' },
          },
          { '@id': 'https://example.org/b', '@type': 'https://example.org/Feat' },
        ],
      },
    ],
  };

  it('two conversions of the same doc produce deep-equal payloads', () => {
    const p1 = JsonLdGraph.fromCompactedJsonLd(doc);
    const p2 = JsonLdGraph.fromCompactedJsonLd(doc);
    assert.deepEqual(p1, p2);
  });
});

// ---------------------------------------------------------------------------
// Test 8: @context-driven label compaction
// ---------------------------------------------------------------------------

describe('JsonLdGraph.fromCompactedJsonLd — @context label compaction', () => {
  const doc = {
    '@context': {
      aon:   'https://aon.example.org/vocabulary/aonprd#',
      aong:  'https://aon.example.org/graph/',
    },
    '@graph': [
      {
        '@id': 'https://aon.example.org/graph/feats',
        '@graph': [
          {
            '@id':    'https://aon.example.org/instance/Feats.aspx?ID=750',
            '@type':  'https://aon.example.org/vocabulary/aonprd#Feat',
          },
        ],
      },
    ],
  };

  let payload: VizPayloadInterface;
  before(() => { payload = JsonLdGraph.fromCompactedJsonLd(doc); });

  it('node classLabel is compacted using aon prefix', () => {
    assert.equal(payload.nodes[0]?.classLabel, 'aon:Feat');
  });

  it('graph label is compacted using aong prefix', () => {
    assert.equal(payload.graphs[0]?.label, 'aong:feats');
  });

  it('prefixes record contains aon and aong', () => {
    assert.equal(payload.prefixes['aon'], 'https://aon.example.org/vocabulary/aonprd#');
    assert.equal(payload.prefixes['aong'], 'https://aon.example.org/graph/');
  });
});

// ---------------------------------------------------------------------------
// Test 9: Edges sorted deterministically
// ---------------------------------------------------------------------------

describe('JsonLdGraph.fromCompactedJsonLd — edge sort order', () => {
  const doc = {
    '@context': { ex: 'https://example.org/' },
    '@graph': [
      {
        '@id': 'https://example.org/a',
        'https://example.org/z': { '@id': 'https://example.org/c' },
        'https://example.org/a': { '@id': 'https://example.org/b' },
      },
      { '@id': 'https://example.org/b' },
      { '@id': 'https://example.org/c' },
    ],
  };

  it('edges are sorted by (source, label, target)', () => {
    const payload = JsonLdGraph.fromCompactedJsonLd(doc);
    assert.equal(payload.edges.length, 2);
    // ex:a predicate sorts before ex:z
    assert.equal(payload.edges[0]?.label, 'ex:a');
    assert.equal(payload.edges[1]?.label, 'ex:z');
  });
});

// ---------------------------------------------------------------------------
// Test 10: Node property keys sorted lexicographically
// ---------------------------------------------------------------------------

describe('JsonLdGraph.fromCompactedJsonLd — node property key sort', () => {
  const doc = {
    '@context': { ex: 'https://example.org/' },
    '@graph': [
      {
        '@id': 'https://example.org/a',
        'https://example.org/z-prop': { '@value': 'Z' },
        'https://example.org/a-prop': { '@value': 'A' },
        'https://example.org/m-prop': { '@value': 'M' },
      },
    ],
  };

  it('node.properties keys are lexicographically sorted', () => {
    const payload = JsonLdGraph.fromCompactedJsonLd(doc);
    const node = payload.nodes[0];
    assert.ok(node !== undefined);
    const keys = Object.keys(node.properties);
    assert.deepEqual(keys, [...keys].sort());
  });
});

// ---------------------------------------------------------------------------
// Test 11: Single resource (no @graph wrapper)
// ---------------------------------------------------------------------------

describe('JsonLdGraph.fromCompactedJsonLd — single top-level resource', () => {
  const doc = {
    '@context': { ex: 'https://example.org/' },
    '@id': 'https://example.org/thing',
    '@type': 'https://example.org/Thing',
    'https://example.org/label': { '@value': 'My Thing' },
  };

  let payload: VizPayloadInterface;
  before(() => { payload = JsonLdGraph.fromCompactedJsonLd(doc); });

  it('produces one node from top-level @id', () => {
    assert.equal(payload.nodes.length, 1);
  });

  it('node has no graphIri', () => {
    assert.equal(payload.nodes[0]?.graphIri, undefined);
  });
});

// ---------------------------------------------------------------------------
// Test 12: fromJsonLd — compacted CURIE-string reference produces an edge
//
// Root cause of the missing-edges bug in the cytoscape demo: compacted JSON-LD
// with `@type: @id` term definitions writes object-property references as bare
// CURIE strings (e.g. `"rarity": "aonprd:Rarity-common"`). The old
// `fromCompactedJsonLd` treated these as literal properties, not edges.
// `fromJsonLd` expands the document first so every reference becomes a
// canonical `{ "@id": "..." }` object, and the walker emits edges correctly.
// ---------------------------------------------------------------------------

describe('JsonLdGraph.fromJsonLd — compacted CURIE-string reference produces an edge', () => {
  // A compacted document where `rarity` is declared as `@type: @id` in the context.
  // The compacted value `"aonprd:Rarity-common"` is a CURIE that should expand to
  // `{ "@id": "https://squashage.dev/vocabulary/aonprd#Rarity-common" }` when
  // the document is expanded.
  const doc = {
    '@context': {
      'aonprd': 'https://squashage.dev/vocabulary/aonprd#',
      'aonprd:rarity': { '@id': 'aonprd:rarity', '@type': '@id' },
    },
    '@graph': [
      {
        '@id':          'https://squashage.dev/instance/aonprd/Feats.aspx?ID=750',
        '@type':        'aonprd:Feat',
        'aonprd:rarity': 'aonprd:Rarity-common',
      },
    ],
  };

  let payload: VizPayloadInterface;
  before(async () => { payload = await JsonLdGraph.fromJsonLd(doc); });

  it('produces nodes for the feat entity and the rarity reference target', () => {
    // The feat entity produces one typed node; the rarity reference target
    // (aonprd:Rarity-common) produces a stub node because it is an edge target.
    assert.equal(payload.nodes.length, 2);
  });

  it('produces one edge for the rarity reference', () => {
    assert.equal(payload.edges.length, 1);
  });

  it('edge source is the feat IRI', () => {
    assert.equal(
      payload.edges[0]?.source,
      'https://squashage.dev/instance/aonprd/Feats.aspx?ID=750',
    );
  });

  it('edge target is the expanded rarity IRI', () => {
    assert.equal(
      payload.edges[0]?.target,
      'https://squashage.dev/vocabulary/aonprd#Rarity-common',
    );
  });

  it('node classIri is the Feat class IRI', () => {
    assert.equal(
      payload.nodes[0]?.classIri,
      'https://squashage.dev/vocabulary/aonprd#Feat',
    );
  });
});

// ---------------------------------------------------------------------------
// Test 13: fromJsonLd — explicit @id reference produces an edge
// ---------------------------------------------------------------------------

describe('JsonLdGraph.fromJsonLd — explicit @id reference in compacted doc', () => {
  const doc = {
    '@context': { ex: 'https://example.org/' },
    '@graph': [
      {
        '@id':              'https://example.org/a',
        'https://example.org/knows': { '@id': 'https://example.org/b' },
      },
      { '@id': 'https://example.org/b' },
    ],
  };

  let payload: VizPayloadInterface;
  before(async () => { payload = await JsonLdGraph.fromJsonLd(doc); });

  it('produces two nodes', () => {
    assert.equal(payload.nodes.length, 2);
  });

  it('produces exactly one edge', () => {
    assert.equal(payload.edges.length, 1);
  });

  it('edge source is entity a', () => {
    assert.equal(payload.edges[0]?.source, 'https://example.org/a');
  });

  it('edge target is entity b', () => {
    assert.equal(payload.edges[0]?.target, 'https://example.org/b');
  });
});

// ---------------------------------------------------------------------------
// Test 14: fromJsonLd — human-readable label from name literal
// ---------------------------------------------------------------------------

describe('JsonLdGraph.fromJsonLd — human-readable labels from name/title/label literals', () => {
  const doc = {
    '@context': { ex: 'https://example.org/' },
    '@graph': [
      {
        '@id':   'https://example.org/feat/PowerAttack',
        '@type': 'https://example.org/Feat',
        'https://example.org/name':  { '@value': 'Power Attack' },
        'https://example.org/level': { '@value': 1 },
      },
    ],
  };

  let payload: VizPayloadInterface;
  before(async () => { payload = await JsonLdGraph.fromJsonLd(doc); });

  it('node label is the name literal value, not the compacted IRI', async () => {
    assert.equal(payload.nodes[0]?.label, 'Power Attack');
  });
});

describe('JsonLdGraph.fromJsonLd — name wins over rdfs:label', () => {
  const doc = {
    '@context': { ex: 'https://example.org/', rdfs: 'http://www.w3.org/2000/01/rdf-schema#' },
    '@graph': [
      {
        '@id':          'https://example.org/feat/Toughness',
        '@type':        'https://example.org/Feat',
        'https://example.org/name':              { '@value': 'Toughness' },
        'http://www.w3.org/2000/01/rdf-schema#label': { '@value': 'rdfsLabel' },
      },
    ],
  };

  let payload: VizPayloadInterface;
  before(async () => { payload = await JsonLdGraph.fromJsonLd(doc); });

  it('name property wins over rdfs:label', async () => {
    assert.equal(payload.nodes[0]?.label, 'Toughness');
  });
});

describe('JsonLdGraph.fromJsonLd — fallback to compacted IRI when no name literal', () => {
  const doc = {
    '@context': { ex: 'https://example.org/' },
    '@graph': [
      {
        '@id':   'https://example.org/feat/Special',
        '@type': 'https://example.org/Feat',
        'https://example.org/level': { '@value': 5 },
      },
    ],
  };

  let payload: VizPayloadInterface;
  before(async () => { payload = await JsonLdGraph.fromJsonLd(doc); });

  it('label falls back to compacted IRI when no name/title/label literal', async () => {
    assert.equal(payload.nodes[0]?.label, 'ex:feat/Special');
  });
});

describe('JsonLdGraph.fromJsonLd — implicit-IRI node gets human-friendlier local name', () => {
  const doc = {
    '@context': {
      aonprd: 'https://squashage.dev/vocabulary/aonprd#',
      'aonprd:rarity': { '@id': 'aonprd:rarity', '@type': '@id' },
    },
    '@graph': [
      {
        '@id':            'https://squashage.dev/instance/aonprd/Feats.aspx?ID=1',
        '@type':          'aonprd:Feat',
        'aonprd:rarity':  'aonprd:Rarity-common',
      },
    ],
  };

  let payload: VizPayloadInterface;
  before(async () => { payload = await JsonLdGraph.fromJsonLd(doc); });

  it('implicit rarity node label strips TypeName- prefix', async () => {
    const rarityNode = payload.nodes.find(n =>
      n.id === 'https://squashage.dev/vocabulary/aonprd#Rarity-common'
    );
    assert.ok(rarityNode !== undefined, 'rarity node should exist');
    assert.equal(rarityNode.label, 'common');
  });
});
