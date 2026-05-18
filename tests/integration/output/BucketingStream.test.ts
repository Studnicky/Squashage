/**
 * @fileoverview Integration test: streaming output with bucketing.
 *
 * @remarks
 * Covers:
 * - per-config-bucket strategy with pre-open mode produces one file per
 *   declared bucket
 * - per-graph-iri strategy with lazy-open mode opens files on demand
 * - MultiStreamWriter LRU eviction under maxOpenFiles pressure
 * - Report contains correct buckets array
 *
 * @category Integration
 * @since 0.7.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SquashageOrchestrator } from '../../../src/orchestrators/SquashageOrchestrator.js';
import { SquashageConfig }       from '../../../src/config/SquashageConfig.js';
import { TaskRegistry }          from '../../../src/registry/TaskRegistry.js';
import { dataFactory }           from '../../../src/rdf/DataFactory.js';
import { OUTPUT_REPORT_FILENAME, OutputReport } from '../../../src/output/OutputReport.js';

let workDir: string;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'squashage-stream-bucket-'));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Shared plugin
// ---------------------------------------------------------------------------

const PLUGIN_NAME = 'squash:stream-bucket-integration';

before(() => {
  if (!TaskRegistry.has(PLUGIN_NAME)) {
    TaskRegistry.register(PLUGIN_NAME, async (next, state) => {
      const ctx = state.context;
      if (ctx === undefined) { await next(); return; }

      const record = state.input as Record<string, unknown>;
      const id     = record['id'] as number;
      const kind   = record['kind'] as string;

      const graphNode = dataFactory.namedNode(`https://stream-bucket.test/graph/${kind}`);
      const subject   = dataFactory.namedNode(`https://stream-bucket.test/item/${id}`);
      const predicate = dataFactory.namedNode('https://stream-bucket.test/vocab#id');
      const object    = dataFactory.literal(String(id));

      ctx.dataset.add(dataFactory.quad(subject, predicate, object, graphNode));

      await next();
    });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeInputRecords(dir: string, records: unknown[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < records.length; i++) {
    await writeFile(join(dir, `record-${i}.json`), JSON.stringify(records[i]), 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Streaming bucketing — per-graph-iri lazy-open', () => {
  it('lazy-open: one file per named graph via streaming', async () => {
    const inputDir  = join(workDir, 'input-stream-lazy');
    const bucketDir = join(workDir, 'buckets-stream-lazy');

    const records = [
      { id: 1, kind: 'feats' },
      { id: 2, kind: 'spells' },
      { id: 3, kind: 'feats' },   // second in same graph
    ];

    await writeInputRecords(inputDir, records);

    const rawConfig = {
      input:   { basePath: inputDir, format: 'json' },
      targets: {
        test: {
          input:    inputDir,
          pipeline: ['json:read', PLUGIN_NAME, 'rdfjs:stream'],
          output:   {
            kind:     'file',
            path:     bucketDir,
            format:   'nquads',
            encoding: 'stream',
            bucketing: {
              enabled:  true,
              strategy: 'per-graph-iri',
            },
          },
        },
      },
    };

    const config = SquashageConfig.validate(rawConfig as Parameters<typeof SquashageConfig.validate>[0]);
    const result = await SquashageOrchestrator.run(config, 'test', {
      outDir: join(workDir, 'graphs-lazy'),
    });

    assert.equal(result.exitCode, 0, `exitCode=${result.exitCode}`);
    assert.equal(result.succeeded, records.length);

    const reportPath = join(workDir, 'graphs-lazy', 'test', OUTPUT_REPORT_FILENAME);
    const report = OutputReport.fromJson(await readFile(reportPath, 'utf8'));

    assert.equal(report.path, bucketDir, 'report.path is bucket directory');
    assert.ok(report.buckets !== undefined);
    assert.equal(report.buckets?.length, 2, 'should have feats and spells buckets');

    const bucketFiles = await readdir(bucketDir);
    assert.equal(bucketFiles.filter(f => f.endsWith('.nq')).length, 2);

    const feats = report.buckets?.find(b => b.graphIri?.includes('feats'));
    assert.equal(feats?.quadCount, 2, 'feats should have 2 quads');
  });
});

describe('Streaming bucketing — per-config-bucket pre-open', () => {
  it('pre-open: uses mapped stems for declared buckets', async () => {
    const inputDir  = join(workDir, 'input-stream-preopen');
    const bucketDir = join(workDir, 'buckets-stream-preopen');

    const records = [
      { id: 10, kind: 'feats' },
      { id: 20, kind: 'spells' },
    ];

    await writeInputRecords(inputDir, records);

    const rawConfig = {
      input:   { basePath: inputDir, format: 'json' },
      targets: {
        test: {
          input:    inputDir,
          pipeline: ['json:read', PLUGIN_NAME, 'rdfjs:stream'],
          output:   {
            kind:     'file',
            path:     bucketDir,
            format:   'nquads',
            encoding: 'stream',
            bucketing: {
              enabled:  true,
              strategy: 'per-config-bucket',
              buckets: {
                'https://stream-bucket.test/graph/feats':  'feats-output',
                'https://stream-bucket.test/graph/spells': 'spells-output',
              },
            },
          },
        },
      },
    };

    const config = SquashageConfig.validate(rawConfig as Parameters<typeof SquashageConfig.validate>[0]);
    const result = await SquashageOrchestrator.run(config, 'test', {
      outDir: join(workDir, 'graphs-preopen'),
    });

    assert.equal(result.exitCode, 0, `exitCode=${result.exitCode}`);

    const reportPath = join(workDir, 'graphs-preopen', 'test', OUTPUT_REPORT_FILENAME);
    const report = OutputReport.fromJson(await readFile(reportPath, 'utf8'));

    assert.ok(report.buckets !== undefined);
    const stems = new Set(report.buckets?.map(b => b.stem));
    assert.ok(stems.has('feats-output'));
    assert.ok(stems.has('spells-output'));

    // Check files were created with correct names
    const bucketFiles = await readdir(bucketDir);
    assert.ok(bucketFiles.includes('feats-output.nq'), 'feats-output.nq should exist');
    assert.ok(bucketFiles.includes('spells-output.nq'), 'spells-output.nq should exist');
  });
});

describe('Streaming bucketing — LRU eviction', () => {
  it('LRU eviction under maxOpenFiles pressure: all quads written correctly', async () => {
    const inputDir  = join(workDir, 'input-lru');
    const bucketDir = join(workDir, 'buckets-lru');

    // Create 5 distinct graph kinds but set maxOpenFiles=2 to force LRU
    const records = [];
    for (let i = 0; i < 10; i++) {
      records.push({ id: i, kind: `kind${i % 5}` });
    }

    await writeInputRecords(inputDir, records);

    const rawConfig = {
      input:   { basePath: inputDir, format: 'json' },
      targets: {
        test: {
          input:    inputDir,
          pipeline: ['json:read', PLUGIN_NAME, 'rdfjs:stream'],
          output:   {
            kind:     'file',
            path:     bucketDir,
            format:   'nquads',
            encoding: 'stream',
            bucketing: {
              enabled:      true,
              strategy:     'per-graph-iri',
              maxOpenFiles: 2,
            },
          },
        },
      },
    };

    const config = SquashageConfig.validate(rawConfig as Parameters<typeof SquashageConfig.validate>[0]);
    const result = await SquashageOrchestrator.run(config, 'test', {
      outDir: join(workDir, 'graphs-lru'),
    });

    assert.equal(result.exitCode, 0, `exitCode=${result.exitCode}`);

    const reportPath = join(workDir, 'graphs-lru', 'test', OUTPUT_REPORT_FILENAME);
    const report = OutputReport.fromJson(await readFile(reportPath, 'utf8'));

    // Should have 5 distinct buckets
    assert.ok(report.buckets !== undefined);
    assert.equal(report.buckets?.length, 5, 'should have 5 buckets (5 distinct graph kinds)');

    // Total quads should be 10 (2 per kind)
    const totalQuads = report.buckets?.reduce((sum, b) => sum + b.quadCount, 0);
    assert.equal(totalQuads, 10, 'total quads across all buckets should be 10');

    // All 5 bucket files should exist and be non-empty
    const bucketFiles = (await readdir(bucketDir)).filter(f => f.endsWith('.nq'));
    assert.equal(bucketFiles.length, 5, '5 bucket files should be created');

    for (const file of bucketFiles) {
      const content = await readFile(join(bucketDir, file), 'utf8');
      assert.ok(content.length > 0, `bucket file ${file} should be non-empty`);
    }
  });
});
