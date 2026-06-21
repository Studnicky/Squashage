import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SquashageRun } from '../../../src/SquashageRun.js';
import { SquashageRunState } from '../../../src/state/SquashageRunState.js';
import type { TargetConfigInterface } from '../../../src/config/SquashageConfig.js';
import type { OutputConfigInterface } from '../../../src/config/OutputConfig.js';

const fixturesDir = join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'fixtures', 'dagonizer-port',
);

function buildTargetConfig(outputPath: string): TargetConfigInterface {
  const output: OutputConfigInterface = {
    kind:   'file',
    path:   outputPath,
    format: 'trig',
  } as OutputConfigInterface;
  return {
    input:    fixturesDir,
    output,
    graphs:   { default: 'https://squashage.dev/graph/aonprd/default' },
    ontology: { baseIri: 'https://2e.aonprd.com/' },
    classification: {
      conflict:   { onConflict: 'pickPriority', evidence: true },
      structural: [
        {
          className: 'feat',
          priority:  20,
          predicate: { path: '/_type', equals: 'feat' },
          reasons:   ['_type=feat'],
        },
      ],
      urlPattern: {
        patterns: [
          { className: 'feat', match: '/Feats\\.aspx', priority: 35 },
        ],
      },
    },
    concurrency: 2,
  };
}

test('happy path', async (t) => {
  await t.test('end-to-end run on a one-record fixture writes a success-graph file', async () => {
    const work = await mkdtemp(join(tmpdir(), 'squashage-port-'));
    try {
      const outputPath = join(work, 'aonprd.trig');
      const targetConfig = buildTargetConfig(outputPath);

      const run = await SquashageRun.forTargetWithNullObserver({
        target: 'aonprd',
        targetConfig,
        output: targetConfig.output,
        outDir: work,
        schemasBase: process.cwd(),
      });

      const result   = await run.execute();
      const runState = result.state as SquashageRunState;
      assert.equal(result.state.lifecycle.variant, 'completed');
      assert.equal(result.state.locators.length, 1);
      assert.equal(runState.squashedCount, 1, 'one squashed record');
      assert.equal(runState.quarantinedCount, 0, 'no quarantined records');
      assert.ok(runState.sampleSummaries.length >= 1, 'sample summaries populated');
      assert.equal(runState.sampleSummaries[0]!.outcome, 'squashed');
      assert.equal(runState.sampleSummaries[0]!.className, 'feat');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  await t.test('async-iterator consumption visits every node placement', async () => {
    const work = await mkdtemp(join(tmpdir(), 'squashage-port-'));
    try {
      const outputPath = join(work, 'aonprd.trig');
      const targetConfig = buildTargetConfig(outputPath);
      const run = await SquashageRun.forTargetWithNullObserver({
        target: 'aonprd',
        targetConfig,
        output: targetConfig.output,
        outDir: work,
        schemasBase: process.cwd(),
      });

      const seen: string[] = [];
      const exec = run.execute();
      for await (const node of exec) {
        seen.push(node.nodeName);
      }
      const result = await exec;
      assert.equal(result.state.lifecycle.variant, 'completed');
      assert.ok(seen.includes('walk-input'), 'walk-input fires');
      assert.ok(seen.includes('process-all-records'), 'process-all-records fires');
      assert.ok(seen.includes('rdfjs-finalize'), 'rdfjs-finalize fires');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
