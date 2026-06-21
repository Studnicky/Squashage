import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Batch } from '@studnicky/dagonizer';
import { buildReadyGateNode } from '../../../../src/nodes/run/buildReadyGate.js';
import { SquashageBootstrapState } from '../../../../src/state/SquashageBootstrapState.js';
import type { SquashageServices } from '../../../../src/services/SquashageServices.js';

const noopLogger = {
  forComponent: () => ({
    debug: () => undefined,
    info:  () => undefined,
    warn:  () => undefined,
    error: () => undefined,
  }),
} as unknown as SquashageServices['logger'];

function makeContext(finalsDir: string): { services: SquashageServices } {
  return {
    services: {
      logger:      noopLogger,
      schemaPaths: { inferred: '', refinements: '', finals: finalsDir },
    } as unknown as SquashageServices,
  };
}

function makeState(): SquashageBootstrapState {
  return new SquashageBootstrapState('test', new Date().toISOString());
}

async function runNode(
  state:   SquashageBootstrapState,
  context: { services: SquashageServices },
): Promise<string> {
  const result = await buildReadyGateNode.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof buildReadyGateNode.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

test('buildReadyGate — missing directory', async (t) => {
  await t.test('returns schemas-absent when directory does not exist', async () => {
    const nonExistent = '/tmp/__squashage_build_gate_no_such_dir__/schemas';
    const output = await runNode(makeState(), makeContext(nonExistent));
    assert.equal(output, 'schemas-absent');
  });
});

test('buildReadyGate — empty directory', async (t) => {
  await t.test('returns schemas-absent for an empty directory', async () => {
    const work = await mkdtemp(join(tmpdir(), 'build-gate-empty-'));
    try {
      const finalsDir = join(work, 'schemas');
      await mkdir(finalsDir, { recursive: true });
      const output = await runNode(makeState(), makeContext(finalsDir));
      assert.equal(output, 'schemas-absent');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  await t.test('returns schemas-absent when directory has only non-schema files', async () => {
    const work = await mkdtemp(join(tmpdir(), 'build-gate-noschema-'));
    try {
      const finalsDir = join(work, 'schemas');
      await mkdir(finalsDir, { recursive: true });
      await writeFile(join(finalsDir, 'Feat.draft.json'), '{}', 'utf8');
      await writeFile(join(finalsDir, 'README.md'),       '#',  'utf8');
      const output = await runNode(makeState(), makeContext(finalsDir));
      assert.equal(output, 'schemas-absent');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  await t.test('returns schemas-absent when only subdirectory contains schema files', async () => {
    const work = await mkdtemp(join(tmpdir(), 'build-gate-subdir-'));
    try {
      const finalsDir = join(work, 'schemas');
      const inferredDir = join(finalsDir, 'inferred');
      await mkdir(inferredDir, { recursive: true });
      // A *.schema.json inside a subdirectory should not count.
      await writeFile(join(inferredDir, 'Feat.schema.json'), '{}', 'utf8');
      const output = await runNode(makeState(), makeContext(finalsDir));
      assert.equal(output, 'schemas-absent');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

test('buildReadyGate — populated directory', async (t) => {
  await t.test('returns schemas-present when at least one *.schema.json exists as direct child', async () => {
    const work = await mkdtemp(join(tmpdir(), 'build-gate-ok-'));
    try {
      const finalsDir = join(work, 'schemas');
      await mkdir(finalsDir, { recursive: true });
      await writeFile(join(finalsDir, 'Feat.schema.json'), '{}', 'utf8');
      const output = await runNode(makeState(), makeContext(finalsDir));
      assert.equal(output, 'schemas-present');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  await t.test('returns schemas-present when multiple schema files exist', async () => {
    const work = await mkdtemp(join(tmpdir(), 'build-gate-multi-'));
    try {
      const finalsDir = join(work, 'schemas');
      await mkdir(finalsDir, { recursive: true });
      await writeFile(join(finalsDir, 'Feat.schema.json'),  '{}', 'utf8');
      await writeFile(join(finalsDir, 'Spell.schema.json'), '{}', 'utf8');
      const output = await runNode(makeState(), makeContext(finalsDir));
      assert.equal(output, 'schemas-present');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
