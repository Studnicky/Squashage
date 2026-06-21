import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Batch } from '@studnicky/dagonizer';
import { writeFinalNode } from '../../../../src/nodes/refine/writeFinal.js';
import { SquashageRefineState } from '../../../../src/state/SquashageRefineState.js';
import type { SquashageServices } from '../../../../src/services/SquashageServices.js';

const noopLogger = {
  forComponent: () => ({
    debug: () => undefined,
    info:  () => undefined,
    warn:  () => undefined,
    error: () => undefined,
  }),
} as unknown as SquashageServices['logger'];

async function runNode(
  state: SquashageRefineState,
  context: { services: SquashageServices },
): Promise<string> {
  const result = await writeFinalNode.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof writeFinalNode.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

function makeContext(finalsDir: string): { services: SquashageServices } {
  return {
    services: {
      logger:      noopLogger,
      schemaPaths: { inferred: '', refinements: '', finals: finalsDir },
    } as unknown as SquashageServices,
  };
}

describe('writeFinalNode — happy path', () => {
  it('creates finals dir, writes schema.json, sets outcome = refined', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'write-final-'));
    const finalsDir = join(tmp, 'schemas');
    try {
      const schema = { title: 'Feat', type: 'object', properties: { name: { type: 'string' } } };
      const state  = new SquashageRefineState('/Feat.draft.json', 'Feat', '/Feat.refine.json');
      state.finalJson = schema;
      state.outcome   = 'error'; // should be overwritten

      const output = await runNode(state, makeContext(finalsDir));
      assert.equal(output, 'written');
      assert.equal(state.outcome, 'refined');

      const filePath = join(finalsDir, 'Feat.schema.json');
      const text     = await readFile(filePath, 'utf8');
      assert.ok(text.endsWith('\n'), 'file should end with newline');
      const parsed   = JSON.parse(text) as Record<string, unknown>;
      assert.equal(parsed['title'], 'Feat');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('does not overwrite passthrough outcome', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'write-final-'));
    const finalsDir = join(tmp, 'schemas');
    try {
      const state = new SquashageRefineState('/Feat.draft.json', 'Feat', null);
      state.finalJson = { title: 'Feat' };
      state.outcome   = 'passthrough'; // should remain passthrough

      await runNode(state, makeContext(finalsDir));
      assert.equal(state.outcome, 'passthrough');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  // ── Class-IRI promotion (P20 regression guard) ──────────────────────────

  it('promotes x-squashage-class to $id when present, preserving path-form IRI', async () => {
    // The path-form class IRI must survive writeFinal unchanged.
    // json-tology then mints property IRIs as <classIri>#<prop> — single '#'.
    const tmp = await mkdtemp(join(tmpdir(), 'write-final-'));
    const finalsDir = join(tmp, 'schemas');
    try {
      const classIri = 'https://2e.aonprd.com/vocab/Feat';
      const schema = {
        '$id':     'https://2e.aonprd.com/schemas/inferred/Feat.draft.json',
        title:     'Feat',
        type:      'object',
        'x-squashage-class': classIri,
      };
      const state  = new SquashageRefineState('/Feat.draft.json', 'Feat', '/Feat.refine.json');
      state.finalJson = schema;

      await runNode(state, makeContext(finalsDir));

      const text   = await readFile(join(finalsDir, 'Feat.schema.json'), 'utf8');
      const parsed = JSON.parse(text) as Record<string, unknown>;

      // $id promoted to the class IRI.
      assert.equal(parsed['$id'], classIri);
      // Promoted $id must NOT contain '#' (path-form, single-hash guarantee).
      assert.ok(!(classIri.includes('#')), `promoted $id "${classIri}" must not contain "#"`);
      // A simulated property IRI must contain exactly one '#'.
      const propIri = `${parsed['$id'] as string}#level`;
      const hashCount = (propIri.match(/#/g) ?? []).length;
      assert.equal(hashCount, 1, `property IRI "${propIri}" must contain exactly one "#"`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('preserves draft $id unchanged when x-squashage-class is absent (extracted schema)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'write-final-'));
    const finalsDir = join(tmp, 'schemas', 'primitives');
    try {
      const draftId = 'https://2e.aonprd.com/schemas/inferred/primitives/FeatRarity.draft.json';
      const schema = {
        '$id':  draftId,
        title:  'FeatRarity',
        type:   'string',
        enum:   ['common', 'uncommon', 'rare'],
      };
      const state = new SquashageRefineState('/primitives/FeatRarity.draft.json', 'FeatRarity', null);
      state.finalJson = schema;
      state.subdir    = 'primitives';

      await runNode(state, makeContext(join(tmp, 'schemas')));

      const text   = await readFile(join(finalsDir, 'FeatRarity.schema.json'), 'utf8');
      const parsed = JSON.parse(text) as Record<string, unknown>;
      // No x-squashage-class → $id preserved as draft path.
      assert.equal(parsed['$id'], draftId);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
