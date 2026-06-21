/**
 * Integration-style smoke test: construct a SquashageRun against the
 * one-record dagonizer-port fixture, execute the induce DAG, assert that
 * one draft file was written.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SquashageRun } from '../../../src/SquashageRun.js';
import type { TargetConfigInterface } from '../../../src/config/SquashageConfig.js';
import type { OutputConfigInterface } from '../../../src/config/OutputConfig.js';
import type { SquashageInduceRunState } from '../../../src/state/SquashageInduceRunState.js';

const fixturesDir = join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'fixtures', 'dagonizer-port',
);

function buildTargetConfig(schemasBase: string): TargetConfigInterface {
  const output: OutputConfigInterface = {
    kind:   'file',
    path:   join(schemasBase, 'aonprd.trig'),
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
    concurrency: 1,
  };
}

test('induceDag smoke — one-record fixture', async (t) => {
  await t.test('executeInduce writes at least one draft file', async () => {
    const work = await mkdtemp(join(tmpdir(), 'induce-smoke-'));
    try {
      const targetConfig = buildTargetConfig(work);
      const run = await SquashageRun.forTargetWithNullObserver({
        target:      'aonprd',
        targetConfig,
        output:      targetConfig.output,
        outDir:      work,
        schemasBase: work,
      });

      const result     = await run.executeInduce();
      const finalState = result.state as unknown as SquashageInduceRunState;

      assert.equal(finalState.lifecycle.variant, 'completed');
      assert.equal(finalState.locators.length, 1, 'should have found one record');
      assert.ok(
        finalState.observedRecords > 0,
        `observedRecords should be > 0, got ${String(finalState.observedRecords)}`,
      );
      assert.ok(
        finalState.discoveredClasses.length > 0,
        'discoveredClasses should be non-empty',
      );
      assert.ok(
        finalState.draftsWritten > 0,
        `draftsWritten should be > 0, got ${String(finalState.draftsWritten)}`,
      );

      // Verify the file exists on disk.
      const inferredDir = run.services.schemaPaths.inferred;
      const files       = await readdir(inferredDir);
      assert.ok(files.length > 0, `expected at least one draft file in ${inferredDir}`);
      assert.ok(
        files.some((f) => f.endsWith('.draft.json')),
        `expected a *.draft.json file, found: ${files.join(', ')}`,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  await t.test('re-run over same fixture produces identical draft content', async () => {
    const work1 = await mkdtemp(join(tmpdir(), 'induce-smoke-a-'));
    const work2 = await mkdtemp(join(tmpdir(), 'induce-smoke-b-'));
    try {
      const makeRun = async (work: string): Promise<{ inferredDir: string }> => {
        const targetConfig = buildTargetConfig(work);
        const run = await SquashageRun.forTargetWithNullObserver({
          target:      'aonprd',
          targetConfig,
          output:      targetConfig.output,
          outDir:      work,
          schemasBase: work,
        });
        await run.executeInduce();
        return { inferredDir: run.services.schemaPaths.inferred };
      };

      const { inferredDir: dir1 } = await makeRun(work1);
      const { inferredDir: dir2 } = await makeRun(work2);

      const { readFile } = await import('node:fs/promises');
      // Only compare .draft.json files at the top level (exclude subdirs like primitives/, objects/).
      const allFiles1 = (await readdir(dir1)).sort();
      const allFiles2 = (await readdir(dir2)).sort();
      assert.deepEqual(allFiles1, allFiles2, 'both runs should produce the same directory entries');

      const draftFiles1 = allFiles1.filter((f) => f.endsWith('.draft.json'));
      for (const file of draftFiles1) {
        const content1 = await readFile(join(dir1, file), 'utf8');
        const content2 = await readFile(join(dir2, file), 'utf8');
        assert.equal(content1, content2, `${file} must be byte-identical across two runs`);
      }
    } finally {
      await rm(work1, { recursive: true, force: true });
      await rm(work2, { recursive: true, force: true });
    }
  });
});
