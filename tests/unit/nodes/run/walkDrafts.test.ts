import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Batch } from '@studnicky/dagonizer';
import { walkDraftsNode } from '../../../../src/nodes/run/walkDrafts.js';
import { SquashageRefineRunState } from '../../../../src/state/SquashageRefineRunState.js';
import type { SquashageServices } from '../../../../src/services/SquashageServices.js';

const noopLogger = {
  forComponent: () => ({
    debug: () => undefined,
    info:  () => undefined,
    warn:  () => undefined,
    error: () => undefined,
  }),
} as unknown as SquashageServices['logger'];

function makeContext(inferredDir: string, refinementsDir: string): { services: SquashageServices } {
  return {
    services: {
      logger:      noopLogger,
      schemaPaths: { inferred: inferredDir, refinements: refinementsDir, finals: '' },
    } as unknown as SquashageServices,
  };
}

async function runNode(
  state: SquashageRefineRunState,
  context: { services: SquashageServices },
): Promise<string> {
  const result = await walkDraftsNode.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof walkDraftsNode.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

describe('walkDraftsNode — missing inferred directory', () => {
  it('returns empty when directory does not exist', async () => {
    const state  = new SquashageRefineRunState('test', new Date().toISOString());
    const output = await runNode(state, makeContext('/nonexistent/dir', '/nonexistent/ref'));
    assert.equal(output, 'empty');
    assert.deepEqual(state.drafts, []);
  });
});

describe('walkDraftsNode — empty inferred directory', () => {
  it('returns empty when no draft files present', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'walk-drafts-'));
    try {
      const inferredDir = join(tmp, 'inferred');
      await mkdir(inferredDir, { recursive: true });
      const state  = new SquashageRefineRunState('test', new Date().toISOString());
      const output = await runNode(state, makeContext(inferredDir, join(tmp, 'ref')));
      assert.equal(output, 'empty');
      assert.deepEqual(state.drafts, []);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('walkDraftsNode — walks drafts, pairs refinements', () => {
  it('produces sorted DraftLocator array with correct refinementPath', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'walk-drafts-'));
    try {
      const inferredDir    = join(tmp, 'inferred');
      const refinementsDir = join(tmp, 'refinements');
      await mkdir(inferredDir,    { recursive: true });
      await mkdir(refinementsDir, { recursive: true });

      // Write draft files out-of-order to verify sorting.
      await writeFile(join(inferredDir, 'Spell.draft.json'),   '{}', 'utf8');
      await writeFile(join(inferredDir, 'Feat.draft.json'),    '{}', 'utf8');
      await writeFile(join(inferredDir, 'Monster.draft.json'), '{}', 'utf8');
      // Only Feat has a refinement.
      await writeFile(join(refinementsDir, 'Feat.refine.json'), '{}', 'utf8');

      const state  = new SquashageRefineRunState('test', new Date().toISOString());
      const output = await runNode(state, makeContext(inferredDir, refinementsDir));

      assert.equal(output, 'walked');
      assert.equal(state.drafts.length, 3);

      // Should be sorted by draftPath (lexicographic).
      const classNames = state.drafts.map((d) => d.className);
      assert.deepEqual(classNames, ['Feat', 'Monster', 'Spell']);

      const feat    = state.drafts.find((d) => d.className === 'Feat')!;
      const monster = state.drafts.find((d) => d.className === 'Monster')!;
      const spell   = state.drafts.find((d) => d.className === 'Spell')!;

      assert.ok(feat.refinementPath !== null, 'Feat should have a refinement path');
      assert.ok(feat.refinementPath!.endsWith('Feat.refine.json'));
      assert.equal(monster.refinementPath, null);
      assert.equal(spell.refinementPath,   null);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('ignores non-draft-json files', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'walk-drafts-'));
    try {
      const inferredDir = join(tmp, 'inferred');
      await mkdir(inferredDir, { recursive: true });
      await writeFile(join(inferredDir, 'Feat.draft.json'), '{}', 'utf8');
      await writeFile(join(inferredDir, 'README.md'),       '',   'utf8');
      await writeFile(join(inferredDir, 'Feat.schema.json'),'{}', 'utf8');

      const state  = new SquashageRefineRunState('test', new Date().toISOString());
      const output = await runNode(state, makeContext(inferredDir, join(tmp, 'ref')));

      assert.equal(output, 'walked');
      assert.equal(state.drafts.length, 1);
      assert.equal(state.drafts[0]!.className, 'Feat');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
