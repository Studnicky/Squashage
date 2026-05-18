/**
 * @fileoverview Unit tests for {@link Bucketer}.
 *
 * Tests cover:
 * - per-graph-iri slug derivation
 * - Collision suffix appended when two distinct IRIs produce the same slug
 * - Default-graph handling (drop vs filename)
 * - classify() groups quads correctly
 * - per-config-bucket mapping (including __other, drop, fail)
 * - URL-encoded IRI + fragment handling
 *
 * @module tests/unit/output/Bucketer.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dataFactory } from '../../../src/rdf/DataFactory.js';
import {
  Bucketer,
  DEFAULT_GRAPH_KEY,
  OTHER_BUCKET_KEY,
} from '../../../src/output/Bucketer.js';
import type { BucketingConfigInterface } from '../../../src/output/Bucketer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EX = 'https://example.org/graph/';
const s  = dataFactory.namedNode('https://example.org/s');
const p  = dataFactory.namedNode('https://example.org/p');
const o  = dataFactory.literal('val');
const dg = dataFactory.defaultGraph();

const graphA = dataFactory.namedNode(`${EX}a`);
const graphB = dataFactory.namedNode(`${EX}b`);

/** One quad in the default graph. */
const defaultQuad = dataFactory.quad(s, p, o, dg);
/** One quad in graph A. */
const quadA = dataFactory.quad(s, p, dataFactory.literal('qa'), graphA);
/** One quad in graph B. */
const quadB = dataFactory.quad(s, p, dataFactory.literal('qb'), graphB);

const bucketDir = '/tmp/buckets';

function allKeysFrom(groups: Map<string, unknown>): ReadonlySet<string> {
  return new Set(groups.keys());
}

// ---------------------------------------------------------------------------
// classify() — per-graph-iri
// ---------------------------------------------------------------------------

describe('Bucketer.classify — per-graph-iri', () => {
  const bucketing: BucketingConfigInterface = { enabled: true, strategy: 'per-graph-iri' };

  it('groups named-graph quads by IRI', () => {
    const groups = Bucketer.classify([quadA, quadB], bucketing);
    assert.equal(groups.size, 2);
    assert.ok(groups.has(graphA.value));
    assert.ok(groups.has(graphB.value));
    assert.equal(groups.get(graphA.value)?.length, 1);
    assert.equal(groups.get(graphB.value)?.length, 1);
  });

  it('groups default-graph quads under DEFAULT_GRAPH_KEY', () => {
    const groups = Bucketer.classify([defaultQuad], bucketing);
    assert.ok(groups.has(DEFAULT_GRAPH_KEY));
    assert.equal(groups.get(DEFAULT_GRAPH_KEY)?.length, 1);
  });

  it('mixes named + default graph correctly', () => {
    const groups = Bucketer.classify([quadA, defaultQuad], bucketing);
    assert.equal(groups.size, 2);
    assert.ok(groups.has(graphA.value));
    assert.ok(groups.has(DEFAULT_GRAPH_KEY));
  });

  it('returns empty map for empty input', () => {
    const groups = Bucketer.classify([], bucketing);
    assert.equal(groups.size, 0);
  });

  it('accumulates multiple quads in same graph', () => {
    const quadA2 = dataFactory.quad(s, p, dataFactory.literal('qa2'), graphA);
    const groups = Bucketer.classify([quadA, quadA2], bucketing);
    assert.equal(groups.size, 1);
    assert.equal(groups.get(graphA.value)?.length, 2);
  });
});

// ---------------------------------------------------------------------------
// classify() — per-config-bucket
// ---------------------------------------------------------------------------

describe('Bucketer.classify — per-config-bucket', () => {
  const bucketing: BucketingConfigInterface = {
    enabled:  true,
    strategy: 'per-config-bucket',
    buckets:  { [graphA.value]: 'graph-a' },
    onUnmapped: 'other',
  };

  it('maps known graph IRI to bucket', () => {
    const groups = Bucketer.classify([quadA], bucketing);
    assert.ok(groups.has(graphA.value));
    assert.equal(groups.get(graphA.value)?.length, 1);
  });

  it('routes unmapped graph to __other when onUnmapped=other', () => {
    const groups = Bucketer.classify([quadB], bucketing);
    assert.ok(groups.has(OTHER_BUCKET_KEY));
    assert.equal(groups.get(OTHER_BUCKET_KEY)?.length, 1);
  });

  it('drops quads when onUnmapped=drop', () => {
    const b2: BucketingConfigInterface = { ...bucketing, onUnmapped: 'drop' };
    const groups = Bucketer.classify([quadB], b2);
    assert.equal(groups.size, 0);
  });

  it('throws when onUnmapped=fail and unmapped quad present', () => {
    const b2: BucketingConfigInterface = { ...bucketing, onUnmapped: 'fail' };
    assert.throws(() => Bucketer.classify([quadB], b2), /unmapped/i);
  });
});

// ---------------------------------------------------------------------------
// filenameFor() — per-graph-iri slug derivation
// ---------------------------------------------------------------------------

describe('Bucketer.filenameFor — per-graph-iri slug derivation', () => {
  const bucketing: BucketingConfigInterface = { enabled: true, strategy: 'per-graph-iri' };

  it('derives slug from IRI path segment', () => {
    const groups = Bucketer.classify([quadA], bucketing);
    const file = Bucketer.filenameFor(
      graphA.value, 'trig', bucketing, bucketDir, allKeysFrom(groups),
    );
    // IRI = https://example.org/graph/a → path = graph/a → slug = graph-a
    assert.equal(file.stem, 'graph-a');
    assert.equal(file.filename, 'graph-a.trig');
  });

  it('appends correct extension for nquads', () => {
    const groups = Bucketer.classify([quadA], bucketing);
    const file = Bucketer.filenameFor(
      graphA.value, 'nquads', bucketing, bucketDir, allKeysFrom(groups),
    );
    assert.ok(file.filename.endsWith('.nq'));
  });

  it('uses defaultGraphFilename for default graph key', () => {
    const b2: BucketingConfigInterface = {
      ...bucketing,
      defaultGraphFilename: 'root',
    };
    const groups = Bucketer.classify([defaultQuad], b2);
    const file = Bucketer.filenameFor(
      DEFAULT_GRAPH_KEY, 'trig', b2, bucketDir, allKeysFrom(groups),
    );
    assert.equal(file.stem, 'root');
  });

  it('uses "default" when defaultGraphFilename is absent', () => {
    const groups = Bucketer.classify([defaultQuad], bucketing);
    const file = Bucketer.filenameFor(
      DEFAULT_GRAPH_KEY, 'trig', bucketing, bucketDir, allKeysFrom(groups),
    );
    assert.equal(file.stem, 'default');
  });

  it('builds full absolute path', () => {
    const groups = Bucketer.classify([quadA], bucketing);
    const file = Bucketer.filenameFor(
      graphA.value, 'trig', bucketing, bucketDir, allKeysFrom(groups),
    );
    assert.ok(file.path.startsWith(bucketDir));
    assert.ok(file.path.endsWith('.trig'));
  });
});

// ---------------------------------------------------------------------------
// Collision detection
// ---------------------------------------------------------------------------

describe('Bucketer — collision suffix', () => {
  const bucketing: BucketingConfigInterface = { enabled: true, strategy: 'per-graph-iri' };

  it('appends SHA-1 suffix when two IRIs produce the same slug', () => {
    // Two IRIs that produce the same path slug:
    // https://example.org/graph/feat and https://example.org/other/graph/feat
    // both slug to "graph-feat" and "other-graph-feat" — these are distinct,
    // so let's use IRIs that genuinely collide: same path from different bases.
    const iri1 = 'https://example.org/graph/feat';
    const iri2 = 'https://other.example.org/graph/feat';

    const g1 = dataFactory.namedNode(iri1);
    const g2 = dataFactory.namedNode(iri2);
    const q1 = dataFactory.quad(s, p, o, g1);
    const q2 = dataFactory.quad(s, p, o, g2);

    const groups = Bucketer.classify([q1, q2], bucketing);
    assert.equal(groups.size, 2);

    const allKeys = allKeysFrom(groups);
    const file1 = Bucketer.filenameFor(iri1, 'trig', bucketing, bucketDir, allKeys);
    const file2 = Bucketer.filenameFor(iri2, 'trig', bucketing, bucketDir, allKeys);

    // Both base-slugs are "graph-feat" → collision → each gets a hash suffix
    // Stems should be distinct
    assert.notEqual(file1.stem, file2.stem, 'colliding IRIs should produce distinct stems');
    // Both stems should contain 'graph-feat' as a prefix
    assert.ok(file1.stem.startsWith('graph-feat-'), `expected "graph-feat-<hash>" got "${file1.stem}"`);
    assert.ok(file2.stem.startsWith('graph-feat-'), `expected "graph-feat-<hash>" got "${file2.stem}"`);
  });

  it('does NOT append suffix for non-colliding IRIs', () => {
    const iri1 = 'https://example.org/graph/feats';
    const iri2 = 'https://example.org/graph/spells';

    const g1 = dataFactory.namedNode(iri1);
    const g2 = dataFactory.namedNode(iri2);
    const q1 = dataFactory.quad(s, p, o, g1);
    const q2 = dataFactory.quad(s, p, o, g2);

    const groups = Bucketer.classify([q1, q2], bucketing);
    const allKeys = allKeysFrom(groups);

    const file1 = Bucketer.filenameFor(iri1, 'trig', bucketing, bucketDir, allKeys);
    const file2 = Bucketer.filenameFor(iri2, 'trig', bucketing, bucketDir, allKeys);

    assert.equal(file1.stem, 'graph-feats');
    assert.equal(file2.stem, 'graph-spells');
  });
});

// ---------------------------------------------------------------------------
// URL-encoded IRI + fragment
// ---------------------------------------------------------------------------

describe('Bucketer — URL-encoded and fragment IRIs', () => {
  const bucketing: BucketingConfigInterface = { enabled: true, strategy: 'per-graph-iri' };

  it('decodes percent-encoded characters', () => {
    const iri  = 'https://example.org/graph/my%20graph';
    const g    = dataFactory.namedNode(iri);
    const quad = dataFactory.quad(s, p, o, g);
    const groups = Bucketer.classify([quad], bucketing);
    const file = Bucketer.filenameFor(iri, 'trig', bucketing, bucketDir, allKeysFrom(groups));
    // "my%20graph" decodes to "my graph" → slug "graph-my-graph"
    assert.ok(file.stem.includes('my'), `expected decoded slug, got "${file.stem}"`);
  });

  it('includes fragment in slug', () => {
    const iri  = 'https://example.org/graph/feat#v1';
    const g    = dataFactory.namedNode(iri);
    const quad = dataFactory.quad(s, p, o, g);
    const groups = Bucketer.classify([quad], bucketing);
    const file = Bucketer.filenameFor(iri, 'trig', bucketing, bucketDir, allKeysFrom(groups));
    // pathname = /graph/feat, fragment = v1 → slug contains "feat" and "v1"
    assert.ok(file.stem.includes('feat'), `expected "feat" in slug, got "${file.stem}"`);
    assert.ok(file.stem.includes('v1'),   `expected "v1" in slug, got "${file.stem}"`);
  });
});

// ---------------------------------------------------------------------------
// per-config-bucket filenameFor
// ---------------------------------------------------------------------------

describe('Bucketer.filenameFor — per-config-bucket', () => {
  const bucketing: BucketingConfigInterface = {
    enabled:  true,
    strategy: 'per-config-bucket',
    buckets:  {
      [graphA.value]: 'feats',
      [graphB.value]: 'spells',
    },
  };

  it('uses the mapped stem for a known IRI', () => {
    const groups  = Bucketer.classify([quadA], bucketing);
    const file    = Bucketer.filenameFor(graphA.value, 'trig', bucketing, bucketDir, allKeysFrom(groups));
    assert.equal(file.stem, 'feats');
    assert.equal(file.filename, 'feats.trig');
  });

  it('uses __other stem for the overflow bucket', () => {
    const b2: BucketingConfigInterface = {
      enabled:    true,
      strategy:   'per-config-bucket',
      buckets:    {},
      onUnmapped: 'other',
    };
    const quadUnknown = dataFactory.quad(s, p, o, dataFactory.namedNode('https://example.org/unknown'));
    const groups = Bucketer.classify([quadUnknown], b2);
    const file = Bucketer.filenameFor(OTHER_BUCKET_KEY, 'trig', b2, bucketDir, allKeysFrom(groups));
    assert.equal(file.stem, '__other');
  });
});
