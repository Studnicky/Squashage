/**
 * @fileoverview Unit tests for catalog:emit task.
 *
 * Tests cover:
 * - no-op when catalog.enabled=false
 * - no-op when bucketing.enabled=false (even if catalog.enabled=true)
 * - reads output.report.json and produces catalog
 * - catalog contains <uri> entries for named-graph buckets
 * - default-graph bucket skipped unless defaultGraphCatalogIri is set
 * - defaultGraphCatalogIri adds sentinel <uri> entry
 * - atomic write semantics (file exists after task)
 * - catalog filename defaults to <targetId>.catalog.xml
 * - custom filename override
 * - rewriteRoots entries
 *
 * @module tests/unit/tasks/emitCatalog.test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join }  from 'node:path';
import { tmpdir } from 'node:os';

// Side-effect import to ensure catalog:emit is registered
import '../../../src/tasks/emitCatalog.js';

import { TaskRegistry }          from '../../../src/registry/TaskRegistry.js';
import { OutputReport }          from '../../../src/output/OutputReport.js';
import type { OutputReportInterface } from '../../../src/output/OutputInterface.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'catalog-task-test-'));
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; }
  catch { return false; }
}

/** Builds a minimal synthetic state for the task. */
function makeState(
  tmpDir: string,
  outputConfig: Record<string, unknown>,
  targetId = 'test-target',
) {
  const outDir = tmpDir;
  return {
    targetId,
    source:          { target: targetId, path: '__synthetic__' },
    input:           {},
    classification:  null,
    classifications: [],
    output:          null,
    context:         {
      target:  targetId,
      outDir:  outDir,
      config:  {},
      output:  outputConfig,
      dataset: {} as unknown,
    } as unknown,
  } as unknown;
}

/** Writes a synthetic output.report.json to the run directory. */
async function writeReport(
  outDir:   string,
  target:   string,
  report:   OutputReportInterface,
): Promise<void> {
  const runDir = join(outDir, target);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'output.report.json'), OutputReport.toJson(report), 'utf8');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EX = 'https://example.org/graph/';

function makeReport(bucketDir: string, buckets: OutputReportInterface['buckets']): OutputReportInterface {
  return {
    path:         bucketDir,
    format:       'trig',
    quadCount:    10,
    graphCount:   2,
    durationMs:   50,
    bytesWritten: 1000,
    errors:       [],
    buckets,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('catalog:emit — no-op conditions', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('does nothing when catalog.enabled is absent', async () => {
    const bucketDir = join(tmpDir, 'buckets-noop');
    await mkdir(bucketDir, { recursive: true });
    await writeReport(tmpDir, 'test-target', makeReport(bucketDir, []));

    const task = TaskRegistry.get('catalog:emit');
    let nextCalled = false;
    const state = makeState(tmpDir, {
      kind:     'file',
      path:     bucketDir,
      bucketing: { enabled: true },
      // no catalog field
    });

    await task(async () => { nextCalled = true; }, state as never);

    assert.ok(nextCalled, 'next() should be called even when skipping');
    // No catalog file should be created
    assert.equal(await exists(join(bucketDir, 'test-target.catalog.xml')), false);
  });

  it('does nothing when catalog.enabled=false', async () => {
    const bucketDir = join(tmpDir, 'buckets-disabled');
    await mkdir(bucketDir, { recursive: true });
    await writeReport(tmpDir, 'test-target', makeReport(bucketDir, []));

    const task = TaskRegistry.get('catalog:emit');
    const state = makeState(tmpDir, {
      kind:      'file',
      path:      bucketDir,
      bucketing: { enabled: true },
      catalog:   { enabled: false },
    });

    await task(async () => { /* no-op next */ }, state as never);

    assert.equal(await exists(join(bucketDir, 'test-target.catalog.xml')), false);
  });

  it('does nothing when bucketing.enabled=false even if catalog.enabled=true', async () => {
    const bucketDir = join(tmpDir, 'buckets-no-bucketing');
    await mkdir(bucketDir, { recursive: true });
    await writeReport(tmpDir, 'test-target', makeReport(bucketDir, []));

    const task = TaskRegistry.get('catalog:emit');
    const state = makeState(tmpDir, {
      kind:      'file',
      path:      bucketDir,
      bucketing: { enabled: false },
      catalog:   { enabled: true },
    });

    await task(async () => { /* no-op next */ }, state as never);

    assert.equal(await exists(join(bucketDir, 'test-target.catalog.xml')), false);
  });
});

describe('catalog:emit — basic catalog generation', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('creates <targetId>.catalog.xml in the bucket directory', async () => {
    const bucketDir = join(tmpDir, 'buckets-basic');
    await mkdir(bucketDir, { recursive: true });

    const bucketFilePath = join(bucketDir, 'graph-feats.trig');
    await writeFile(bucketFilePath, '<dummy/>');

    const report = makeReport(bucketDir, [
      {
        bucketKey:    `${EX}feats`,
        path:         bucketFilePath,
        graphIri:     `${EX}feats`,
        stem:         'graph-feats',
        format:       'trig',
        quadCount:    5,
        bytesWritten: 100,
      },
    ]);
    await writeReport(tmpDir, 'test-target', report);

    const task = TaskRegistry.get('catalog:emit');
    const state = makeState(tmpDir, {
      kind:      'file',
      path:      bucketDir,
      bucketing: { enabled: true },
      catalog:   { enabled: true },
    });

    await task(async () => { /* no-op next */ }, state as never);

    const catalogPath = join(bucketDir, 'test-target.catalog.xml');
    assert.ok(await exists(catalogPath), 'catalog file should exist');

    const content = await readFile(catalogPath, 'utf8');
    assert.ok(content.includes('<catalog '));
    assert.ok(content.includes(`name="${EX}feats"`));
    assert.ok(content.includes('graph-feats.trig'));
  });

  it('skips null-path (empty) buckets', async () => {
    const bucketDir = join(tmpDir, 'buckets-empty');
    await mkdir(bucketDir, { recursive: true });

    const report = makeReport(bucketDir, [
      {
        bucketKey:    `${EX}feats`,
        path:         null,   // empty bucket
        graphIri:     `${EX}feats`,
        stem:         'feats',
        format:       'trig',
        quadCount:    0,
        bytesWritten: 0,
      },
    ]);
    await writeReport(tmpDir, 'test-target', report);

    const task = TaskRegistry.get('catalog:emit');
    const state = makeState(tmpDir, {
      kind:      'file',
      path:      bucketDir,
      bucketing: { enabled: true },
      catalog:   { enabled: true },
    });

    await task(async () => { /* no-op next */ }, state as never);

    const content = await readFile(join(bucketDir, 'test-target.catalog.xml'), 'utf8');
    // Empty bucket should not appear in catalog
    assert.ok(!content.includes(`${EX}feats`), 'empty bucket should not appear in catalog');
  });

  it('skips default-graph bucket when defaultGraphCatalogIri is absent', async () => {
    const bucketDir = join(tmpDir, 'buckets-default-skip');
    await mkdir(bucketDir, { recursive: true });

    const defFilePath = join(bucketDir, 'default.trig');
    await writeFile(defFilePath, '<dummy/>');

    const report = makeReport(bucketDir, [
      {
        bucketKey:    '__default__',
        path:         defFilePath,
        graphIri:     null,
        stem:         'default',
        format:       'trig',
        quadCount:    3,
        bytesWritten: 50,
      },
    ]);
    await writeReport(tmpDir, 'test-target', report);

    const task = TaskRegistry.get('catalog:emit');
    const state = makeState(tmpDir, {
      kind:      'file',
      path:      bucketDir,
      bucketing: { enabled: true },
      catalog:   { enabled: true },
    });

    await task(async () => { /* no-op next */ }, state as never);

    const content = await readFile(join(bucketDir, 'test-target.catalog.xml'), 'utf8');
    assert.ok(!content.includes('__default__'), 'default graph key should not appear in catalog');
    // default.trig path should not appear either
    assert.ok(!content.includes('default.trig'), 'default.trig path should not appear when no catalogIri set');
  });

  it('adds default-graph <uri> when defaultGraphCatalogIri is set', async () => {
    const bucketDir = join(tmpDir, 'buckets-sentinel');
    await mkdir(bucketDir, { recursive: true });

    const defFilePath = join(bucketDir, 'default.trig');
    await writeFile(defFilePath, '<dummy/>');

    const report = makeReport(bucketDir, [
      {
        bucketKey:    '__default__',
        path:         defFilePath,
        graphIri:     null,
        stem:         'default',
        format:       'trig',
        quadCount:    3,
        bytesWritten: 50,
      },
    ]);
    await writeReport(tmpDir, 'test-target', report);

    const task = TaskRegistry.get('catalog:emit');
    const state = makeState(tmpDir, {
      kind:      'file',
      path:      bucketDir,
      bucketing: { enabled: true, defaultGraphCatalogIri: 'urn:x-arq:DefaultGraphNode' },
      catalog:   { enabled: true },
    });

    await task(async () => { /* no-op next */ }, state as never);

    const content = await readFile(join(bucketDir, 'test-target.catalog.xml'), 'utf8');
    assert.ok(content.includes('name="urn:x-arq:DefaultGraphNode"'), 'sentinel IRI should appear in catalog');
    assert.ok(content.includes('default.trig'), 'default.trig path should appear');
  });
});

describe('catalog:emit — filename override', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('uses catalog.filename when set', async () => {
    const bucketDir = join(tmpDir, 'buckets-filename');
    await mkdir(bucketDir, { recursive: true });
    await writeReport(tmpDir, 'test-target', makeReport(bucketDir, []));

    const task = TaskRegistry.get('catalog:emit');
    const state = makeState(tmpDir, {
      kind:      'file',
      path:      bucketDir,
      bucketing: { enabled: true },
      catalog:   { enabled: true, filename: 'my-catalog.xml' },
    });

    await task(async () => { /* no-op next */ }, state as never);

    assert.ok(await exists(join(bucketDir, 'my-catalog.xml')), 'custom filename should be used');
    assert.equal(await exists(join(bucketDir, 'test-target.catalog.xml')), false, 'default name should not exist');
  });
});

describe('catalog:emit — rewriteRoots', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('includes <rewriteURI> entries from catalog.rewriteRoots', async () => {
    const bucketDir = join(tmpDir, 'buckets-rewrite');
    await mkdir(bucketDir, { recursive: true });
    await writeReport(tmpDir, 'test-target', makeReport(bucketDir, []));

    const task = TaskRegistry.get('catalog:emit');
    const state = makeState(tmpDir, {
      kind:      'file',
      path:      bucketDir,
      bucketing: { enabled: true },
      catalog:   {
        enabled: true,
        rewriteRoots: [
          { uriStartString: 'https://example.org/graph/', rewritePrefix: './' },
        ],
      },
    });

    await task(async () => { /* no-op next */ }, state as never);

    const content = await readFile(join(bucketDir, 'test-target.catalog.xml'), 'utf8');
    assert.ok(content.includes('<rewriteURI '), 'rewriteURI element should be present');
    assert.ok(content.includes('uriStartString="https://example.org/graph/"'));
    assert.ok(content.includes('rewritePrefix="./"'));
  });
});
