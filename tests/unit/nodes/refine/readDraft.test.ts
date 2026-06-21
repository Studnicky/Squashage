import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Batch } from '@studnicky/dagonizer';
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

async function runNode(
  state: SquashageRefineState,
  context: { services: SquashageServices },
): Promise<string> {
  const result = await readDraftNode.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof readDraftNode.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

describe('readDraftNode — missing file', () => {
  it('returns error and collects an error in state', async () => {
    const state  = makeState('/nonexistent/Feat.draft.json');
    const output = await runNode(state, makeContext());
    assert.equal(output, 'error');
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
      const output = await runNode(state, makeContext());
      assert.equal(output, 'error');
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
      const output = await runNode(state, makeContext());
      assert.equal(output, 'loaded');
      assert.ok(state.draftJson !== null);
      assert.equal(state.draftJson['title'], 'Feat');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
