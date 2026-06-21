import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Batch } from '@studnicky/dagonizer';
import { readRefinementNode } from '../../../../src/nodes/refine/readRefinement.js';
import { SquashageRefineState } from '../../../../src/state/SquashageRefineState.js';
import type { SquashageServices } from '../../../../src/services/SquashageServices.js';

import AjvModule        from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { AjvCtorType, AddFormatsFnInterface } from '../../../../src/types/AjvInterop.js';

const Ajv        = (AjvModule        as unknown as { default?: AjvCtorType }).default        ?? (AjvModule        as unknown as AjvCtorType);
const addFormats = (addFormatsModule as unknown as { default?: AddFormatsFnInterface }).default ?? (addFormatsModule as unknown as AddFormatsFnInterface);

const noopLogger = {
  forComponent: () => ({
    debug: () => undefined,
    info:  () => undefined,
    warn:  () => undefined,
    error: () => undefined,
  }),
} as unknown as SquashageServices['logger'];

function makeAjv(): InstanceType<AjvCtorType> {
  const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: false });
  addFormats(ajv);
  return ajv;
}

function makeContext(): { services: SquashageServices } {
  return {
    services: {
      logger: noopLogger,
      ajv:    makeAjv(),
    } as unknown as SquashageServices,
  };
}

async function runNode(
  state: SquashageRefineState,
  context: { services: SquashageServices },
): Promise<string> {
  const result = await readRefinementNode.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof readRefinementNode.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

const VALID_REFINEMENT = {
  $schema:   'https://squashage.dev/schemas/refinement.schema.json',
  appliesTo: 'Feat',
};

describe('readRefinementNode — null refinementPath', () => {
  it('returns missing without reading any file', async () => {
    const state  = new SquashageRefineState('/Feat.draft.json', 'Feat', null);
    const output = await runNode(state, makeContext());
    assert.equal(output, 'missing');
    assert.equal(state.refinementJson, null);
  });
});

describe('readRefinementNode — missing file', () => {
  it('returns error when file does not exist', async () => {
    const state  = new SquashageRefineState('/x.draft.json', 'X', '/nonexistent/X.refine.json');
    const output = await runNode(state, makeContext());
    assert.equal(output, 'error');
    assert.ok(state.errors.length > 0);
  });
});

describe('readRefinementNode — invalid JSON', () => {
  it('returns error for malformed JSON', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'read-refine-'));
    try {
      const path = join(tmp, 'Feat.refine.json');
      await writeFile(path, 'NOT JSON', 'utf8');
      const state  = new SquashageRefineState('/Feat.draft.json', 'Feat', path);
      const output = await runNode(state, makeContext());
      assert.equal(output, 'error');
      assert.equal(state.refinementJson, null);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('readRefinementNode — schema validation failure', () => {
  it('returns error when document violates the meta-schema', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'read-refine-'));
    try {
      const path = join(tmp, 'Feat.refine.json');
      // Missing required 'appliesTo'.
      await writeFile(path, JSON.stringify({ $schema: 'https://squashage.dev/schemas/refinement.schema.json', unknownKey: true }), 'utf8');
      const state  = new SquashageRefineState('/Feat.draft.json', 'Feat', path);
      const output = await runNode(state, makeContext());
      assert.equal(output, 'error');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('readRefinementNode — valid refinement', () => {
  it('returns loaded and populates refinementJson', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'read-refine-'));
    try {
      const path = join(tmp, 'Feat.refine.json');
      await writeFile(path, JSON.stringify(VALID_REFINEMENT), 'utf8');
      const state  = new SquashageRefineState('/Feat.draft.json', 'Feat', path);
      const output = await runNode(state, makeContext());
      assert.equal(output, 'loaded');
      assert.ok(state.refinementJson !== null);
      assert.equal(state.refinementJson['appliesTo'], 'Feat');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
