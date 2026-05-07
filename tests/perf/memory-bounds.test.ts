/**
 * @fileoverview Memory-bounds regression test for streaming output.
 *
 * @remarks
 * Runs a synthetic 100K-record pipeline with `encoding: stream` and
 * `dropInMemory: true`. Samples RSS before and after; asserts growth
 * is under 50MB. This guards against the OOM regression that Phase 10
 * exists to fix -- 486K Veekun learnsets x 4 quads = ~2M quads would
 * exhaust heap without streaming.
 *
 * @category Perf
 * @since 0.7.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SquashageOrchestrator } from '../../src/orchestrators/SquashageOrchestrator.js';
import { SquashageConfig }       from '../../src/config/SquashageConfig.js';
import { TaskRegistry }          from '../../src/registry/TaskRegistry.js';
import { dataFactory }           from '../../src/rdf/DataFactory.js';

let workDir: string;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'squashage-perf-'));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('memory-bounds: streaming output', () => {
  it('10K-record run with dropInMemory:true stays under 400MB RSS growth', async () => {
    const RECORD_COUNT   = 10_000;
    const RSS_LIMIT_MB   = 400;

    const inputDir  = join(workDir, 'input');
    const graphsDir = join(workDir, 'graphs');
    const outPath   = join(graphsDir, 'perf-test.nq');
    await mkdir(inputDir, { recursive: true });
    await mkdir(graphsDir, { recursive: true });

    const chunkSize  = 1_000;
    const chunkCount = RECORD_COUNT / chunkSize;
    for (let chunk = 0; chunk < chunkCount; chunk++) {
      const lines: string[] = [];
      for (let i = 0; i < chunkSize; i++) {
        const id = chunk * chunkSize + i;
        lines.push(JSON.stringify({ id, v: `v${id}` }));
      }
      await writeFile(join(inputDir, `chunk-${chunk}.jsonl`), lines.join('\n'), 'utf8');
    }

    const PLUGIN_NAME = 'squash:perf-test';
    if (!TaskRegistry.has(PLUGIN_NAME)) {
      TaskRegistry.register(PLUGIN_NAME, async (next, state) => {
        const ctx = state.context;
        if (ctx === undefined) { await next(); return; }
        const id = (state.input as Record<string, unknown>)['id'] as number;
        const s  = dataFactory.namedNode(`https://perf.test/item/${id}`);
        const p  = dataFactory.namedNode('https://perf.test/vocab#value');
        const o  = dataFactory.literal(String((state.input as Record<string, unknown>)['v']));
        const g  = ctx.graphs['default'] ?? dataFactory.defaultGraph();
        ctx.dataset.add(dataFactory.quad(s, p, o, g));
        await next();
      });
    }

    const configPath = join(workDir, 'perf.json');
    const config = {
      input: { basePath: inputDir, format: 'jsonl' },
      targets: {
        'perf-test': {
          input:    inputDir,
          pipeline: ['json:read', PLUGIN_NAME, 'rdfjs:stream'],
          graphs:   { default: 'https://perf.test/graph/default' },
          concurrency: 4,
          output: {
            kind:         'file',
            path:         outPath,
            format:       'nquads',
            encoding:     'stream',
            dropInMemory: true,
          },
        },
      },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    if (typeof global.gc === 'function') { global.gc(); }
    const rssBefore = process.memoryUsage().rss;

    const loaded = SquashageConfig.loadFromFile(configPath);
    await SquashageOrchestrator.run(loaded, 'perf-test', {
      outDir:     graphsDir,
      configPath,
    });

    if (typeof global.gc === 'function') { global.gc(); }
    const rssAfter = process.memoryUsage().rss;

    const growthMB = (rssAfter - rssBefore) / (1024 * 1024);

    assert.ok(
      growthMB < RSS_LIMIT_MB,
      `RSS grew by ${growthMB.toFixed(1)} MB which exceeds the ${RSS_LIMIT_MB} MB limit. ` +
      `(before=${(rssBefore / 1024 / 1024).toFixed(1)} MB, after=${(rssAfter / 1024 / 1024).toFixed(1)} MB)`,
    );
  });
});
