import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readDraftNode } from '../../../../src/nodes/refine/readDraft.js';
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

function makeContext(): { services: SquashageServices } {
  return { services: { logger: noopLogger } as unknown as SquashageServices };
}

function makeState(draftPath: string): SquashageRefineState {
  return new SquashageRefineState(draftPath, 'Feat', null);
}

describe('readDraftNode — missing file', () => {
  it('returns error and collects an error in state', async () => {
    const state  = makeState('/nonexistent/Feat.draft.json');
    const result = await readDraftNode.execute(state, makeContext());
    assert.equal(result.output, 'error');
    assert.equal(state.draftJson, null);
    assert.ok(state.errors.length > 0);
  });
});

describe('readDraftNode — invalid JSON', () => {
  it('returns error for malformed JSON', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'read-draft-'));
    try {
      const path = join(tmp, 'Feat.draft.json');
      await writeFile(path, 'NOT JSON', 'utf8');
      const state  = makeState(path);
      const result = await readDraftNode.execute(state, makeContext());
      assert.equal(result.output, 'error');
      assert.equal(state.draftJson, null);
      assert.ok(state.errors.length > 0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('readDraftNode — valid draft', () => {
  it('returns loaded and populates draftJson', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'read-draft-'));
    try {
      const schema = { $schema: 'x', title: 'Feat', type: 'object', properties: {} };
      const path   = join(tmp, 'Feat.draft.json');
      await writeFile(path, JSON.stringify(schema), 'utf8');
      const state  = makeState(path);
      const result = await readDraftNode.execute(state, makeContext());
      assert.equal(result.output, 'loaded');
      assert.ok(state.draftJson !== null);
      assert.equal(state.draftJson['title'], 'Feat');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
