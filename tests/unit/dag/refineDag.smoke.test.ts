/**
 * End-to-end smoke test: run the squashage:refine DAG over a temp directory
 * containing one draft + one refinement, assert that the final schema was
 * written with the expected transformation applied.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SquashageRun } from '../../../src/SquashageRun.js';
import type { TargetConfigInterface } from '../../../src/config/SquashageConfig.js';
import type { OutputConfigInterface } from '../../../src/config/OutputConfig.js';
import type { SquashageRefineRunState } from '../../../src/state/SquashageRefineRunState.js';

const fixturesDir = join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'fixtures', 'dagonizer-port',
);

class SmokeTestConfig {
  static forSchemasBase(schemasBase: string): TargetConfigInterface {
    const output: OutputConfigInterface = {
      kind:   'file',
      path:   join(schemasBase, 'aonprd.trig'),
      format: 'trig',
    } as OutputConfigInterface;
    return {
      input:    { basePath: fixturesDir, format: 'json' },
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
}

test('refineDag smoke — single draft + refinement', async (t) => {
  await t.test('applies refinement and writes final schema', async () => {
    const work = await mkdtemp(join(tmpdir(), 'refine-smoke-'));
    try {
      // Create the required directory structure.
      const inferred    = join(work, 'schemas', 'inferred');
      const refinements = join(work, 'schemas', 'refinements');
      const finals      = join(work, 'schemas');
      await mkdir(inferred,    { recursive: true });
      await mkdir(refinements, { recursive: true });

      // Write a draft schema.
      const draft = {
        $schema:    'https://json-schema.org/draft/2020-12/schema',
        $id:        'https://example.org/schemas/inferred/Feat.draft.json',
        title:      'Feat',
        type:       'object',
        properties: {
          name:     { type: 'string' },
          _type:    { type: 'string' },
          raw_html: { type: 'string' },
        },
        additionalProperties: true,
      };
      await writeFile(join(inferred, 'Feat.draft.json'), JSON.stringify(draft, null, 2), 'utf8');

      // Write a matching refinement.
      const refinement = {
        $schema:   'https://squashage.dev/schemas/refinement.schema.json',
        appliesTo: 'Feat',
        drop:      ['/raw_html'],
        rename:    { '/_type': 'kind' },
        rdfsLabel: 'name',
      };
      await writeFile(join(refinements, 'Feat.refine.json'), JSON.stringify(refinement, null, 2), 'utf8');

      const targetConfig = SmokeTestConfig.forSchemasBase(work);
      const run = await SquashageRun.forTargetWithNullObserver({
        target:      'aonprd',
        targetConfig,
        output:      targetConfig.output,
        outDir:      work,
        schemasBase: work,
      });

      const result     = await run.executeRefine();
      const finalState = result.state as unknown as SquashageRefineRunState;

      assert.equal(finalState.lifecycle.variant, 'completed');
      assert.equal(finalState.refinedCount,   1, 'should have refined one draft');
      assert.equal(finalState.passthroughCount, 0);
      assert.equal(finalState.runErrors.length, 0);

      // Verify the final schema file exists.
      const finalPath = join(finals, 'Feat.schema.json');
      const text      = await readFile(finalPath, 'utf8');
      const parsed    = JSON.parse(text) as Record<string, unknown>;

      const props = parsed['properties'] as Record<string, unknown>;
      assert.ok(!Object.prototype.hasOwnProperty.call(props, 'raw_html'), 'raw_html should be dropped');
      assert.ok(!Object.prototype.hasOwnProperty.call(props, '_type'),    '_type should be renamed');
      assert.ok(Object.prototype.hasOwnProperty.call(props, 'kind'),      'kind should be present');
      assert.equal(parsed['x-squashage-rdfs-label'], '/name', 'rdfsLabel annotation should be set');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  await t.test('passthrough: no refinement file → writes draft as final', async () => {
    const work = await mkdtemp(join(tmpdir(), 'refine-passthrough-'));
    try {
      const inferred = join(work, 'schemas', 'inferred');
      await mkdir(inferred, { recursive: true });

      const draft = {
        $schema:    'https://json-schema.org/draft/2020-12/schema',
        title:      'Trait',
        type:       'object',
        properties: { name: { type: 'string' } },
      };
      await writeFile(join(inferred, 'Trait.draft.json'), JSON.stringify(draft, null, 2), 'utf8');

      const targetConfig = SmokeTestConfig.forSchemasBase(work);
      const run = await SquashageRun.forTargetWithNullObserver({
        target:      'aonprd',
        targetConfig,
        output:      targetConfig.output,
        outDir:      work,
        schemasBase: work,
      });

      const result     = await run.executeRefine();
      const finalState = result.state as unknown as SquashageRefineRunState;

      assert.equal(finalState.lifecycle.variant, 'completed');
      assert.equal(finalState.passthroughCount, 1);
      assert.equal(finalState.refinedCount,     0);

      const finalPath = join(work, 'schemas', 'Trait.schema.json');
      const text      = await readFile(finalPath, 'utf8');
      const parsed    = JSON.parse(text) as Record<string, unknown>;
      assert.equal(parsed['title'], 'Trait');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  await t.test('determinism: two identical runs produce byte-identical final schemas', async () => {
    const work1 = await mkdtemp(join(tmpdir(), 'refine-det-a-'));
    const work2 = await mkdtemp(join(tmpdir(), 'refine-det-b-'));
    try {
      const draft = {
        $schema:    'https://json-schema.org/draft/2020-12/schema',
        title:      'Feat',
        type:       'object',
        properties: { name: { type: 'string' }, raw_html: { type: 'string' }, _type: { type: 'string' } },
      };
      const refinement = {
        $schema:   'https://squashage.dev/schemas/refinement.schema.json',
        appliesTo: 'Feat',
        drop:      ['/raw_html'],
        rename:    { '/_type': 'kind' },
      };

      const setup = async (work: string): Promise<string> => {
        const inferred    = join(work, 'schemas', 'inferred');
        const refinements = join(work, 'schemas', 'refinements');
        await mkdir(inferred,    { recursive: true });
        await mkdir(refinements, { recursive: true });
        await writeFile(join(inferred,    'Feat.draft.json'),  JSON.stringify(draft,      null, 2), 'utf8');
        await writeFile(join(refinements, 'Feat.refine.json'), JSON.stringify(refinement, null, 2), 'utf8');
        const targetConfig = SmokeTestConfig.forSchemasBase(work);
        const run = await SquashageRun.forTargetWithNullObserver({
          target:      'aonprd',
          targetConfig,
          output:      targetConfig.output,
          outDir:      work,
          schemasBase: work,
        });
        await run.executeRefine();
        return join(work, 'schemas', 'Feat.schema.json');
      };

      const [path1, path2] = await Promise.all([setup(work1), setup(work2)]);
      const [content1, content2] = await Promise.all([readFile(path1, 'utf8'), readFile(path2, 'utf8')]);
      assert.equal(content1, content2, 'two runs must produce byte-identical final schemas');
    } finally {
      await Promise.all([
        rm(work1, { recursive: true, force: true }),
        rm(work2, { recursive: true, force: true }),
      ]);
    }
  });
});
