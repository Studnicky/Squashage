/**
 * @fileoverview Integration test: FileOutput bucketing with `encoding: atomic`.
 *
 * @remarks
 * Synthesizes 3 multi-graph records (each emitting quads into distinct named
 * graphs), runs the pipeline with bucketing enabled (per-graph-iri strategy),
 * and asserts:
 *   - One file per named graph is created under the bucket directory
 *   - Each file is valid TriG
 *   - The output report contains a `buckets` array with correct metadata
 *   - Single-file mode regression: aonprd-like config without bucketing
 *     produces one file and no `buckets` in the report
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
  workDir = await mkdtemp(join(tmpdir(), 'squashage-bucketing-integration-'));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Shared plugin registration
// ---------------------------------------------------------------------------

const PLUGIN_NAME = 'squash:bucketing-integration';

before(() => {
  if (!TaskRegistry.has(PLUGIN_NAME)) {
    TaskRegistry.register(PLUGIN_NAME, async (next, state) => {
      const ctx = state.context;
      if (ctx === undefined) { await next(); return; }

      const record = state.input as Record<string, unknown>;
      const id     = record['id'] as number;
      const kind   = record['kind'] as string;

      // Emit one quad into a named graph derived from the record kind
      const graphIri  = `https://bucketing.test/graph/${kind}`;
      const graphNode = dataFactory.namedNode(graphIri);
      const subject   = dataFactory.namedNode(`https://bucketing.test/item/${id}`);
      const predicate = dataFactory.namedNode('https://bucketing.test/vocab#id');
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

function buildConfig(outputPath: string, inputDir: string, bucketingEnabled: boolean) {
  const outputBlock: Record<string, unknown> = {
    kind:   'file',
    path:   outputPath,
    format: 'trig',
  };

  if (bucketingEnabled) {
    outputBlock['bucketing'] = { enabled: true, strategy: 'per-graph-iri' };
  }

  return {
    input:   { basePath: inputDir, format: 'json' },
    targets: {
      test: {
        input:    inputDir,
        pipeline: ['json:read', PLUGIN_NAME, 'rdfjs:finalize'],
        output:   outputBlock,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bucketing integration — per-graph-iri atomic', () => {
  it('produces one file per named graph in the bucket directory', async () => {
    const inputDir  = join(workDir, 'input-multi');
    const bucketDir = join(workDir, 'buckets');

    const records = [
      { id: 1, kind: 'feats' },
      { id: 2, kind: 'spells' },
      { id: 3, kind: 'feats' },   // second feat — goes to same bucket
      { id: 4, kind: 'monsters' },
    ];

    await writeInputRecords(inputDir, records);

    const rawConfig = buildConfig(bucketDir, inputDir, true);
    const config = SquashageConfig.validate(rawConfig as Parameters<typeof SquashageConfig.validate>[0]);

    const result = await SquashageOrchestrator.run(config, 'test', {
      outDir: join(workDir, 'graphs'),
    });

    assert.equal(result.exitCode, 0, `run should succeed; exitCode=${result.exitCode}`);
    assert.equal(result.succeeded, records.length);

    // Read the output report
    const reportPath = join(workDir, 'graphs', 'test', OUTPUT_REPORT_FILENAME);
    const report = OutputReport.fromJson(await readFile(reportPath, 'utf8'));

    assert.equal(report.path, bucketDir, 'report.path should be the bucket directory');
    assert.ok(report.buckets !== undefined, 'report.buckets should be set');
    assert.equal(report.buckets?.length, 3, 'should have 3 buckets: feats, spells, monsters');

    // All bucket files should exist
    const bucketFiles = await readdir(bucketDir);
    assert.equal(bucketFiles.filter(f => f.endsWith('.trig')).length, 3);

    // Quad counts
    const feats    = report.buckets?.find(b => b.graphIri?.includes('feats'));
    const spells   = report.buckets?.find(b => b.graphIri?.includes('spells'));
    const monsters = report.buckets?.find(b => b.graphIri?.includes('monsters'));

    assert.ok(feats !== undefined);
    assert.equal(feats?.quadCount, 2, 'feats bucket should have 2 quads');
    assert.equal(spells?.quadCount, 1, 'spells bucket should have 1 quad');
    assert.equal(monsters?.quadCount, 1, 'monsters bucket should have 1 quad');

    // Each bucket file should contain valid TriG (at minimum, non-empty)
    for (const bucket of report.buckets ?? []) {
      if (bucket.path !== null) {
        const content = await readFile(bucket.path, 'utf8');
        assert.ok(content.length > 0, `bucket file should be non-empty: ${bucket.path}`);
        // Should contain a GRAPH block
        assert.ok(content.includes('GRAPH') || content.includes('<https://bucketing.test/graph/'), `bucket should reference a named graph: ${bucket.path}`);
      }
    }
  });

  it('single-file regression: no bucketing → no report.buckets', async () => {
    const inputDir = join(workDir, 'input-single');
    const outFile  = join(workDir, 'single-out.trig');

    await writeInputRecords(inputDir, [{ id: 10, kind: 'items' }]);

    const rawConfig = buildConfig(outFile, inputDir, false);
    const config = SquashageConfig.validate(rawConfig as Parameters<typeof SquashageConfig.validate>[0]);

    const result = await SquashageOrchestrator.run(config, 'test', {
      outDir: join(workDir, 'graphs-single'),
    });

    assert.equal(result.exitCode, 0);

    const reportPath = join(workDir, 'graphs-single', 'test', OUTPUT_REPORT_FILENAME);
    const report = OutputReport.fromJson(await readFile(reportPath, 'utf8'));

    // Single-file mode: path is the file, no buckets
    assert.equal(report.path, outFile, 'report.path should be the output file');
    assert.equal(report.buckets, undefined, 'no buckets in single-file mode');
    assert.ok(report.quadCount > 0);
  });
});
