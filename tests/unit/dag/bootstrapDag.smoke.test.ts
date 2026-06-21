/**
 * End-to-end smoke test for the squashage:bootstrap DAG.
 *
 * Uses the one-record dagonizer-port fixture. Verifies two scenarios:
 *   1. No refinements pre-authored → bootstrap halts at refine-required-gate
 *      (lifecycle = completed, induceResult populated, refineResult null).
 *   2. Refinement authored on disk → bootstrap proceeds past gate and produces
 *      a build output (refineResult populated, results non-empty).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SquashageRun } from '../../../src/SquashageRun.js';
import type { TargetConfigInterface } from '../../../src/config/SquashageConfig.js';
import type { OutputConfigInterface } from '../../../src/config/OutputConfig.js';
import type { SquashageBootstrapState } from '../../../src/state/SquashageBootstrapState.js';

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

test('bootstrapDag smoke — halts at gate when no refinements', async (t) => {
  await t.test('lifecycle completed, induceResult populated, refineResult null', async () => {
    const work = await mkdtemp(join(tmpdir(), 'bootstrap-smoke-norefine-'));
    try {
      const targetConfig = buildTargetConfig(work);
      const run = await SquashageRun.forTargetWithNullObserver({
        target:      'aonprd',
        targetConfig,
        output:      targetConfig.output,
        outDir:      work,
        schemasBase: work,
      });

      const result     = await run.executeBootstrap();
      const finalState = result.state as unknown as SquashageBootstrapState;

      assert.equal(finalState.lifecycle.variant, 'completed');
      assert.ok(
        finalState.induceResult !== null,
        'induceResult should be populated after induce phase',
      );
      assert.ok(
        finalState.induceResult.discoveredClasses.length > 0,
        'induceResult.discoveredClasses should be non-empty',
      );
      assert.ok(
        finalState.induceResult.draftsWritten > 0,
        `induceResult.draftsWritten should be > 0, got ${String(finalState.induceResult?.draftsWritten)}`,
      );
      assert.equal(
        finalState.refineResult,
        null,
        'refineResult should be null — bootstrap halted at gate',
      );
      assert.equal(
        finalState.buildResult,
        null,
        'buildResult should be null — build was skipped',
      );

      // Draft files should exist on disk.
      const inferredDir = run.services.schemaPaths.inferred;
      const draftFiles  = await readdir(inferredDir);
      assert.ok(
        draftFiles.some((f) => f.endsWith('.draft.json')),
        `expected at least one draft file in ${inferredDir}`,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

test('bootstrapDag smoke — proceeds past gate with refinements', async (t) => {
  await t.test('refineResult and build results populated when refinements exist', async () => {
    const work = await mkdtemp(join(tmpdir(), 'bootstrap-smoke-full-'));
    try {
      const targetConfig = buildTargetConfig(work);
      const run = await SquashageRun.forTargetWithNullObserver({
        target:      'aonprd',
        targetConfig,
        output:      targetConfig.output,
        outDir:      work,
        schemasBase: work,
      });

      // Phase 1: run induce to discover which classes exist.
      await run.executeInduce();

      // Determine which draft files were written.
      const inferredDir    = run.services.schemaPaths.inferred;
      const refinementsDir = run.services.schemaPaths.refinements;
      const draftFiles     = await readdir(inferredDir);
      const draftJsonFiles = draftFiles.filter((f) => f.endsWith('.draft.json'));
      assert.ok(draftJsonFiles.length > 0, 'precondition: induce must have written drafts');

      // Write a refinement for the first discovered class (passthrough — no changes).
      const firstDraft  = draftJsonFiles[0];
      assert.ok(firstDraft !== undefined, 'precondition: at least one draft file');
      const className   = firstDraft.replace('.draft.json', '');
      await mkdir(refinementsDir, { recursive: true });
      const refinement  = {
        $schema:   'https://squashage.dev/schemas/refinement.schema.json',
        appliesTo: className,
      };
      await writeFile(
        join(refinementsDir, `${className}.refine.json`),
        JSON.stringify(refinement, null, 2),
        'utf8',
      );

      // Phase 2: run full bootstrap — should proceed past both gates.
      const run2 = await SquashageRun.forTargetWithNullObserver({
        target:      'aonprd',
        targetConfig,
        output:      targetConfig.output,
        outDir:      work,
        schemasBase: work,
      });

      const result     = await run2.executeBootstrap();
      const finalState = result.state as unknown as SquashageBootstrapState;

      assert.equal(finalState.lifecycle.variant, 'completed');

      assert.ok(
        finalState.induceResult !== null,
        'induceResult should be populated',
      );

      assert.ok(
        finalState.refineResult !== null,
        'refineResult should be populated — bootstrap proceeded past refine-required-gate',
      );
      assert.ok(
        (finalState.refineResult.refinedCount + finalState.refineResult.passthroughCount) > 0,
        'at least one draft should have been processed by refine',
      );

      // Build phase ran — results array should have entries (even if some were quarantined).
      assert.ok(
        finalState.results.length > 0,
        'results should be non-empty after build phase',
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
