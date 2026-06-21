import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Batch } from '@studnicky/dagonizer';
import { refineRequiredGateNode } from '../../../../src/nodes/run/refineRequiredGate.js';
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

function makeContext(refinementsDir: string): { services: SquashageServices } {
  return {
    services: {
      logger:      noopLogger,
      schemaPaths: { inferred: '', refinements: refinementsDir, finals: '' },
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
  const result = await refineRequiredGateNode.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof refineRequiredGateNode.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

test('refineRequiredGate — missing directory', async (t) => {
  await t.test('returns refinements-absent when directory does not exist', async () => {
    const nonExistent = '/tmp/__squashage_gate_no_such_dir__/refinements';
    const output = await runNode(makeState(), makeContext(nonExistent));
    assert.equal(output, 'refinements-absent');
  });
});

test('refineRequiredGate — empty directory', async (t) => {
  await t.test('returns refinements-absent for an empty directory', async () => {
    const work = await mkdtemp(join(tmpdir(), 'refine-gate-empty-'));
    try {
      const refinementsDir = join(work, 'refinements');
      await mkdir(refinementsDir, { recursive: true });
      const output = await runNode(makeState(), makeContext(refinementsDir));
      assert.equal(output, 'refinements-absent');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  await t.test('returns refinements-absent when directory has non-refine files', async () => {
    const work = await mkdtemp(join(tmpdir(), 'refine-gate-norefine-'));
    try {
      const refinementsDir = join(work, 'refinements');
      await mkdir(refinementsDir, { recursive: true });
      await writeFile(join(refinementsDir, 'Feat.draft.json'), '{}', 'utf8');
      const output = await runNode(makeState(), makeContext(refinementsDir));
      assert.equal(output, 'refinements-absent');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

test('refineRequiredGate — populated directory', async (t) => {
  await t.test('returns refinements-present when at least one *.refine.json exists', async () => {
    const work = await mkdtemp(join(tmpdir(), 'refine-gate-ok-'));
    try {
      const refinementsDir = join(work, 'refinements');
      await mkdir(refinementsDir, { recursive: true });
      await writeFile(join(refinementsDir, 'Feat.refine.json'), '{}', 'utf8');
      const output = await runNode(makeState(), makeContext(refinementsDir));
      assert.equal(output, 'refinements-present');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  await t.test('returns refinements-present when multiple refine files exist', async () => {
    const work = await mkdtemp(join(tmpdir(), 'refine-gate-multi-'));
    try {
      const refinementsDir = join(work, 'refinements');
      await mkdir(refinementsDir, { recursive: true });
      await writeFile(join(refinementsDir, 'Feat.refine.json'),  '{}', 'utf8');
      await writeFile(join(refinementsDir, 'Spell.refine.json'), '{}', 'utf8');
      const output = await runNode(makeState(), makeContext(refinementsDir));
      assert.equal(output, 'refinements-present');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
