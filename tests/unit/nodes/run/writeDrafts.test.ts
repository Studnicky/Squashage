import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Batch } from '@studnicky/dagonizer';
import { writeDraftsNode } from '../../../../src/nodes/run/writeDrafts.js';
import { SquashageInduceRunState } from '../../../../src/state/SquashageInduceRunState.js';
import type { InducedSchemaInterface, InducedSchemaSetInterface } from '../../../../src/induction/SchemaInducer.js';
import type { SquashageServices } from '../../../../src/services/SquashageServices.js';

const noopLogger = {
  forComponent: () => ({
    debug: () => undefined,
    info:  () => undefined,
    warn:  () => undefined,
    error: () => undefined,
  }),
} as unknown as SquashageServices['logger'];

const SAMPLE_CLASS: InducedSchemaInterface = {
  className: 'Feat',
  schemaId:  'https://example.org/vocab/schemas/inferred/Feat.draft.json',
  kind:      'class',
  schema: {
    '$id':     'https://example.org/vocab/schemas/inferred/Feat.draft.json',
    '$schema': 'https://json-schema.org/draft/2020-12/schema',
    title:     'Feat',
    type:      'object',
    additionalProperties: true,
    properties: { name: { type: 'string' } },
  },
};

const SAMPLE_PRIMITIVE: InducedSchemaInterface = {
  className: 'Rarity',
  schemaId:  'https://example.org/vocab/schemas/inferred/primitives/Rarity.draft.json',
  kind:      'primitive',
  schema: {
    '$id':     'https://example.org/vocab/schemas/inferred/primitives/Rarity.draft.json',
    '$schema': 'https://json-schema.org/draft/2020-12/schema',
    title:     'Rarity',
    type:      'string',
    enum:      ['common', 'rare', 'uncommon'],
    'x-squashage-closed-enum': true,
  },
};

const SAMPLE_OBJECT: InducedSchemaInterface = {
  className: 'FeatSource',
  schemaId:  'https://example.org/vocab/schemas/inferred/objects/FeatSource.draft.json',
  kind:      'object',
  schema: {
    '$id':     'https://example.org/vocab/schemas/inferred/objects/FeatSource.draft.json',
    '$schema': 'https://json-schema.org/draft/2020-12/schema',
    title:     'FeatSource',
    type:      'object',
    properties: { book: { type: 'string' } },
  },
};

function makeSchemaSet(
  classes: InducedSchemaInterface[] = [SAMPLE_CLASS],
  primitives: InducedSchemaInterface[] = [],
  objects: InducedSchemaInterface[] = [],
): InducedSchemaSetInterface {
  return { classes, primitives, objects };
}

function makeState(schemaSet: InducedSchemaSetInterface | null): SquashageInduceRunState {
  const state = new SquashageInduceRunState('test', new Date().toISOString());
  state.inducedSchemas = schemaSet;
  return state;
}

function makeContext(inferredDir: string): { services: SquashageServices } {
  return {
    services: {
      logger:      noopLogger,
      schemaPaths: { inferred: inferredDir, refinements: '', finals: '' },
    } as unknown as SquashageServices,
  };
}

/**
 * Helper: run the node over a single-state batch and return the output port name.
 * The result is a ReadonlyMap<TOutput, Batch<TState>>; the winning port is the
 * first (and only) key when a single item is processed.
 */
async function runNode(
  state: SquashageInduceRunState,
  context: { services: SquashageServices },
): Promise<string> {
  const result = await writeDraftsNode.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof writeDraftsNode.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

describe('writeDraftsNode — empty inducedSchemas', () => {
  it('returns skipped when inducedSchemas is null; draftsWritten remains 0', async () => {
    const state  = makeState(null);
    const output = await runNode(state, makeContext('/tmp/irrelevant'));
    assert.equal(output,             'skipped');
    assert.equal(state.draftsWritten, 0);
  });

  it('returns skipped when all arrays are empty; draftsWritten remains 0', async () => {
    const state  = makeState(makeSchemaSet([], [], []));
    const output = await runNode(state, makeContext('/tmp/irrelevant'));
    assert.equal(output,             'skipped');
    assert.equal(state.draftsWritten, 0);
  });
});

describe('writeDraftsNode — writes class files', () => {
  it('creates outDir, writes one class file, sets draftsWritten', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'write-drafts-'));
    const inferredDir = join(tmpDir, 'schemas', 'inferred');
    try {
      const state  = makeState(makeSchemaSet([SAMPLE_CLASS]));
      const output = await runNode(state, makeContext(inferredDir));

      assert.equal(output,             'written');
      assert.equal(state.draftsWritten, 1);

      const files = await readdir(inferredDir);
      assert.ok(files.includes('Feat.draft.json'));

      const content = await readFile(join(inferredDir, 'Feat.draft.json'), 'utf8');
      const parsed  = JSON.parse(content) as Record<string, unknown>;
      assert.equal(parsed['title'], 'Feat');
      assert.ok(content.endsWith('\n'), 'file should end with newline');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('byte-stable JSON output across two invocations', async () => {
    const tmpDir1 = await mkdtemp(join(tmpdir(), 'write-drafts-a-'));
    const tmpDir2 = await mkdtemp(join(tmpdir(), 'write-drafts-b-'));
    try {
      const run1 = makeState(makeSchemaSet([SAMPLE_CLASS]));
      const run2 = makeState(makeSchemaSet([SAMPLE_CLASS]));
      await runNode(run1, makeContext(tmpDir1));
      await runNode(run2, makeContext(tmpDir2));

      const content1 = await readFile(join(tmpDir1, 'Feat.draft.json'), 'utf8');
      const content2 = await readFile(join(tmpDir2, 'Feat.draft.json'), 'utf8');
      assert.equal(content1, content2, 'output must be byte-identical across two runs');
    } finally {
      await rm(tmpDir1, { recursive: true, force: true });
      await rm(tmpDir2, { recursive: true, force: true });
    }
  });

  it('creates nested outDir with mkdir -p semantics', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'write-drafts-mkdir-'));
    const deepDir = join(tmpDir, 'a', 'b', 'c', 'inferred');
    try {
      const state  = makeState(makeSchemaSet([SAMPLE_CLASS]));
      const output = await runNode(state, makeContext(deepDir));
      assert.equal(output, 'written');
      const files = await readdir(deepDir);
      assert.ok(files.includes('Feat.draft.json'));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('writeDraftsNode — writes extracted files', () => {
  it('writes primitive to primitives/ subdirectory', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'write-drafts-prim-'));
    const inferredDir = join(tmpDir, 'inferred');
    try {
      const state  = makeState(makeSchemaSet([SAMPLE_CLASS], [SAMPLE_PRIMITIVE]));
      const output = await runNode(state, makeContext(inferredDir));

      assert.equal(output,             'written');
      assert.equal(state.draftsWritten, 2);

      const primDir = join(inferredDir, 'primitives');
      const primFiles = await readdir(primDir);
      assert.ok(primFiles.includes('Rarity.draft.json'));

      const content = await readFile(join(primDir, 'Rarity.draft.json'), 'utf8');
      const parsed  = JSON.parse(content) as Record<string, unknown>;
      assert.equal(parsed['title'], 'Rarity');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('writes object to objects/ subdirectory', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'write-drafts-obj-'));
    const inferredDir = join(tmpDir, 'inferred');
    try {
      const state  = makeState(makeSchemaSet([SAMPLE_CLASS], [], [SAMPLE_OBJECT]));
      const output = await runNode(state, makeContext(inferredDir));

      assert.equal(output,             'written');
      assert.equal(state.draftsWritten, 2);

      const objDir = join(inferredDir, 'objects');
      const objFiles = await readdir(objDir);
      assert.ok(objFiles.includes('FeatSource.draft.json'));

      const content = await readFile(join(objDir, 'FeatSource.draft.json'), 'utf8');
      const parsed  = JSON.parse(content) as Record<string, unknown>;
      assert.equal(parsed['title'], 'FeatSource');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('draftsWritten counts all three categories', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'write-drafts-all-'));
    const inferredDir = join(tmpDir, 'inferred');
    try {
      const state  = makeState(makeSchemaSet([SAMPLE_CLASS], [SAMPLE_PRIMITIVE], [SAMPLE_OBJECT]));
      await runNode(state, makeContext(inferredDir));
      assert.equal(state.draftsWritten, 3);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
