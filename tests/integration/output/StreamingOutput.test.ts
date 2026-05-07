/**
 * @fileoverview Integration test: full pipeline run with `encoding: stream`.
 *
 * @remarks
 * Synthesizes 1000 in-memory JSON records, runs the pipeline with streaming
 * N-Quads output enabled, and asserts that the output file contains at least
 * 1000 lines and each line matches the N-Quads pattern.
 *
 * @category Integration
 * @since 0.7.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SquashageOrchestrator } from '../../../src/orchestrators/SquashageOrchestrator.js';
import { SquashageConfig }       from '../../../src/config/SquashageConfig.js';
import { TaskRegistry }          from '../../../src/registry/TaskRegistry.js';
import { dataFactory }           from '../../../src/rdf/DataFactory.js';

let workDir: string;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'squashage-stream-integration-'));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('StreamingOutput integration', () => {
  it('full pipeline with encoding:stream produces valid N-Quads output (1000 records)', async () => {
    const inputDir  = join(workDir, 'input');
    const graphsDir = join(workDir, 'graphs');
    const outPath   = join(graphsDir, 'stream-test.nq');
    await mkdir(inputDir, { recursive: true });
    await mkdir(graphsDir, { recursive: true });

    // Write 1000 synthetic JSONL records.
    const RECORD_COUNT = 1000;
    const jsonlLines: string[] = [];
    for (let i = 0; i < RECORD_COUNT; i++) {
      jsonlLines.push(JSON.stringify({ id: i, name: `item-${i}` }));
    }
    await writeFile(join(inputDir, 'synthetic.jsonl'), jsonlLines.join('\n'), 'utf8');

    // Register a minimal squash plugin that emits 1 quad per record.
    const PLUGIN_NAME = 'squash:synthetic-stream';
    if (!TaskRegistry.has(PLUGIN_NAME)) {
      TaskRegistry.register(PLUGIN_NAME, async (next, state) => {
        const ctx = state.context;
        if (ctx === undefined) { await next(); return; }
        const id  = (state.input as Record<string, unknown>)['id'] as number;
        const s   = dataFactory.namedNode(`https://streaming.test/item/${id}`);
        const p   = dataFactory.namedNode('https://streaming.test/vocab#name');
        const o   = dataFactory.literal(String((state.input as Record<string, unknown>)['name']));
        const g   = ctx.graphs['default'] ?? dataFactory.defaultGraph();
        ctx.dataset.add(dataFactory.quad(s, p, o, g));
        await next();
      });
    }

    const configPath = join(workDir, 'sq.json');
    const config = {
      input: { basePath: inputDir, format: 'jsonl' },
      targets: {
        'stream-test': {
          input:    inputDir,
          pipeline: ['json:read', PLUGIN_NAME, 'rdfjs:stream'],
          graphs:   { default: 'https://streaming.test/graph/default' },
          output: {
            kind:     'file',
            path:     outPath,
            format:   'nquads',
            encoding: 'stream',
          },
        },
      },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const loaded = SquashageConfig.loadFromFile(configPath);
    const result = await SquashageOrchestrator.run(loaded, 'stream-test', {
      outDir:     graphsDir,
      configPath,
    });

    assert.equal(result.recordCount, RECORD_COUNT, 'all records processed');

    // Verify the output file.
    const text = await readFile(outPath, 'utf8');
    const outputLines = text.trim().split('\n').filter(l => l.trim().length > 0);
    assert.ok(
      outputLines.length >= RECORD_COUNT,
      `Expected >= ${RECORD_COUNT} lines, got ${outputLines.length}`,
    );

    // Every line must match the N-Quads pattern: <s> <p> <o> <g> .
    const NQ_LINE = /^<[^>]+> <[^>]+> ("[^"]*"|<[^>]+>) <[^>]+> \.$/;
    for (const line of outputLines) {
      assert.ok(NQ_LINE.test(line.trim()), `Line does not match N-Quads pattern: ${line}`);
    }
  });
});
