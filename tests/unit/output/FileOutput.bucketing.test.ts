/**
 * @fileoverview Unit tests for FileOutput bucketing mode.
 *
 * Covers:
 * - Bucketing-on writes N files (one per distinct graph)
 * - Bucketing-off regression (single-file behaviour unchanged)
 * - Report contains buckets array with correct per-bucket metadata
 * - Report path is the bucket-root directory (not a file)
 * - per-config-bucket strategy uses mapped stems
 * - Empty bucket (zero quads) produces null path in report
 *
 * @module tests/unit/output/FileOutput.bucketing.test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readdir, rm } from 'node:fs/promises';
import { join }                        from 'node:path';
import { tmpdir }                      from 'node:os';

import { dataFactory }    from '../../../src/rdf/DataFactory.js';
import { FileOutput }     from '../../../src/output/FileOutput.js';
import type { OutputConfigInterface } from '../../../src/config/OutputConfig.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fo-bucketing-test-'));
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; }
  catch { return false; }
}

function config(
  path: string,
  overrides: Partial<Omit<OutputConfigInterface, 'kind' | 'path'>> = {},
): OutputConfigInterface {
  return { kind: 'file', path, format: 'trig', ...overrides } as OutputConfigInterface;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EX = 'https://example.org/';

const s  = dataFactory.namedNode(`${EX}s`);
const p  = dataFactory.namedNode(`${EX}p`);
const dg = dataFactory.defaultGraph();

const graphA = dataFactory.namedNode(`${EX}graph/a`);
const graphB = dataFactory.namedNode(`${EX}graph/b`);

const quadA1 = dataFactory.quad(s, p, dataFactory.literal('val-a1'), graphA);
const quadA2 = dataFactory.quad(s, p, dataFactory.literal('val-a2'), graphA);
const quadB1 = dataFactory.quad(s, p, dataFactory.literal('val-b1'), graphB);
const defaultQuad = dataFactory.quad(s, p, dataFactory.literal('default-val'), dg);

// ---------------------------------------------------------------------------
// Suite: bucketing-off regression
// ---------------------------------------------------------------------------

describe('FileOutput — bucketing OFF (regression)', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('writes a single file when bucketing is not configured', async () => {
    const outPath = join(tmpDir, 'out.trig');
    const out = new FileOutput(config(outPath), tmpDir);
    await out.open();
    await out.writeBatch([quadA1, quadB1]);
    const report = await out.close();

    assert.ok(await exists(outPath), 'single output file should exist');
    assert.equal(report.path, outPath, 'report.path is the file path');
    assert.equal(report.quadCount, 2);
    assert.equal(report.graphCount, 2);
    assert.equal(report.buckets, undefined, 'buckets should be absent when bucketing off');
  });
});

// ---------------------------------------------------------------------------
// Suite: bucketing ON — per-graph-iri
// ---------------------------------------------------------------------------

describe('FileOutput — bucketing ON (per-graph-iri)', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('writes one file per named graph', async () => {
    const bucketDir = join(tmpDir, 'buckets');
    const out = new FileOutput(config(bucketDir, {
      bucketing: { enabled: true, strategy: 'per-graph-iri' } as unknown as undefined,
    }), tmpDir);

    await out.open();
    await out.writeBatch([quadA1, quadA2, quadB1]);
    const report = await out.close();

    assert.equal(report.path, bucketDir, 'report.path is bucket root directory');
    assert.ok(report.buckets !== undefined, 'report.buckets should be set');
    assert.equal(report.buckets?.length, 2, 'two buckets (graph/a and graph/b)');
    assert.equal(report.quadCount, 3);
    assert.equal(report.graphCount, 2);

    // Both bucket files should exist
    for (const bucket of report.buckets ?? []) {
      assert.ok(bucket.path !== null, 'non-empty bucket should have a path');
      assert.ok(await exists(bucket.path!), `bucket file should exist: ${bucket.path}`);
      assert.ok(bucket.quadCount > 0);
      assert.ok(bucket.bytesWritten > 0);
    }
  });

  it('writes default-graph bucket to "default" stem', async () => {
    const bucketDir = join(tmpDir, 'buckets-default');
    const out = new FileOutput(config(bucketDir, {
      bucketing: { enabled: true, strategy: 'per-graph-iri' } as unknown as undefined,
    }), tmpDir);

    await out.open();
    await out.writeBatch([defaultQuad]);
    const report = await out.close();

    assert.ok(report.buckets !== undefined);
    const defBucket = report.buckets?.find(b => b.bucketKey === '__default__');
    assert.ok(defBucket !== undefined, 'should have a default-graph bucket');
    assert.equal(defBucket?.stem, 'default');
    assert.ok(defBucket?.path !== null);
    assert.ok(await exists(defBucket?.path ?? ''));
  });

  it('uses custom defaultGraphFilename when configured', async () => {
    const bucketDir = join(tmpDir, 'buckets-root');
    const out = new FileOutput(config(bucketDir, {
      bucketing: { enabled: true, strategy: 'per-graph-iri', defaultGraphFilename: 'root' } as unknown as undefined,
    }), tmpDir);

    await out.open();
    await out.writeBatch([defaultQuad]);
    const report = await out.close();

    const defBucket = report.buckets?.find(b => b.bucketKey === '__default__');
    assert.equal(defBucket?.stem, 'root', 'should use custom defaultGraphFilename');
  });

  it('report path is directory, not a file', async () => {
    const bucketDir = join(tmpDir, 'buckets-dir-check');
    const out = new FileOutput(config(bucketDir, {
      bucketing: { enabled: true } as unknown as undefined,
    }), tmpDir);

    await out.open();
    await out.writeBatch([quadA1]);
    const report = await out.close();

    const info = await stat(report.path);
    assert.ok(info.isDirectory(), 'report.path should be a directory');
  });

  it('bucket report has correct graphIri', async () => {
    const bucketDir = join(tmpDir, 'buckets-iri');
    const out = new FileOutput(config(bucketDir, {
      bucketing: { enabled: true } as unknown as undefined,
    }), tmpDir);

    await out.open();
    await out.writeBatch([quadA1, defaultQuad]);
    const report = await out.close();

    const namedBucket = report.buckets?.find(b => b.graphIri !== null);
    assert.ok(namedBucket !== undefined, 'should have a named-graph bucket');
    assert.equal(namedBucket?.graphIri, graphA.value);

    const defaultBucket = report.buckets?.find(b => b.bucketKey === '__default__');
    assert.equal(defaultBucket?.graphIri, null, 'default graph bucket graphIri is null');
  });
});

// ---------------------------------------------------------------------------
// Suite: bucketing ON — per-config-bucket
// ---------------------------------------------------------------------------

describe('FileOutput — bucketing ON (per-config-bucket)', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('uses mapped stems from bucketing.buckets', async () => {
    const bucketDir = join(tmpDir, 'buckets-mapped');
    const out = new FileOutput(config(bucketDir, {
      bucketing: {
        enabled:  true,
        strategy: 'per-config-bucket',
        buckets: {
          [graphA.value]: 'graph-alpha',
          [graphB.value]: 'graph-beta',
        },
      } as unknown as undefined,
    }), tmpDir);

    await out.open();
    await out.writeBatch([quadA1, quadB1]);
    const report = await out.close();

    assert.ok(report.buckets !== undefined);
    const stems = new Set(report.buckets?.map(b => b.stem));
    assert.ok(stems.has('graph-alpha'), 'should have "graph-alpha" stem');
    assert.ok(stems.has('graph-beta'), 'should have "graph-beta" stem');

    const entries = await readdir(bucketDir);
    assert.ok(entries.includes('graph-alpha.trig'));
    assert.ok(entries.includes('graph-beta.trig'));
  });
});

// ---------------------------------------------------------------------------
// Suite: dry run + bucketing
// ---------------------------------------------------------------------------

describe('FileOutput — dry run with bucketing', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('dry run skips all writes and returns 0 bytesWritten', async () => {
    const bucketDir = join(tmpDir, 'buckets-dry');
    const out = new FileOutput(config(bucketDir, {
      dryRun:   true,
      bucketing: { enabled: true } as unknown as undefined,
    }), tmpDir);

    await out.open();
    await out.writeBatch([quadA1, quadB1]);
    const report = await out.close();

    assert.equal(report.bytesWritten, 0, 'dry run should not write bytes');
    // dry run returns early before classify, so buckets is undefined
    assert.equal(report.buckets, undefined, 'dry run should not populate buckets');
  });
});
