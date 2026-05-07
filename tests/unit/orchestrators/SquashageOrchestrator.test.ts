/**
 * @fileoverview Unit tests for {@link SquashageOrchestrator}.
 *
 * @remarks
 * Exercises the run-wide context construction, per-record pipeline dispatch,
 * drain-then-finalize lifecycle, and {@link RunResultInterface} computation
 * across four scenarios:
 *
 * 1. Happy path: 2 input `.json` files, a fixture:squash task that emits one
 *    quad per record, verified by parsing the Turtle output.
 * 2. Failure case: pipeline references an unregistered task; `TaskRegistry.get`
 *    throws `ExternalSchemaError` before any record is processed.
 * 3. Empty input directory: `recordCount === 0`, output file is empty/written.
 * 4. Missing target: `SquashageConfigError` is thrown before the walk phase.
 *
 * @category Orchestrator
 * @since 0.1.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  access,
} from 'node:fs/promises';
import { tmpdir }        from 'node:os';
import { join }          from 'node:path';

import { SquashageOrchestrator } from '../../../src/orchestrators/SquashageOrchestrator.js';
import { TaskRegistry }          from '../../../src/registry/TaskRegistry.js';
import { ExternalSchemaError }   from '../../../src/errors/ExternalSchemaError.js';
import { SquashageConfigError }  from '../../../src/errors/SquashageConfigError.js';
import { dataFactory }           from '../../../src/rdf/DataFactory.js';
import { Parser }                from '../../../src/rdf/Parser.js';
import type { SquashageConfigInterface } from '../../../src/config/SquashageConfig.js';
import type { PipelineStateInterface }   from '../../../src/types/PipelineState.js';
import type { NextFnInterface }          from '../../../src/types/Pipeline.js';
import type { PrefixResolutionInterface } from '../../../src/classification/PrefixResolver.js';

// ---------------------------------------------------------------------------
// Fixture task registration
// ---------------------------------------------------------------------------

/** Name for the per-test squash fixture task. */
const FIXTURE_TASK_NAME = 'fixture:squash';

/**
 * Registers `fixture:squash` — emits one quad per record into the shared dataset.
 * Called once at suite setup; idempotent due to TaskRegistry overwriting existing tasks.
 */
function registerFixtureTask(): void {
  TaskRegistry.register(
    FIXTURE_TASK_NAME,
    async (next: NextFnInterface, state: PipelineStateInterface): Promise<void> => {
      const ctx = state.context;
      if (ctx !== undefined) {
        const subject   = dataFactory.namedNode(`https://example.org/record/${state.source.path.replace(/[^a-z0-9]/gi, '_')}`);
        const predicate = dataFactory.namedNode('https://schema.org/name');
        const object    = typeof state.input['name'] === 'string'
          ? dataFactory.literal(state.input['name'])
          : dataFactory.literal('unknown');
        ctx.dataset.add(dataFactory.quad(subject, predicate, object));
      }
      await next();
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal SquashageConfigInterface for testing. */
const buildConfig = (
  inputDir:    string,
  outputPath:  string,
  pipeline:    string[] = ['json:read', FIXTURE_TASK_NAME, 'rdfjs:finalize'],
): SquashageConfigInterface => ({
  input: { basePath: inputDir, format: 'json' },
  targets: {
    target1: {
      input:    inputDir,
      pipeline,
      output:   { kind: 'file', path: outputPath },
    },
  },
});

/** Name for the context-capture fixture task. */
const CAPTURE_TASK_NAME = 'fixture:capture-context';

/** Mutable slot that gets written by the capture task during a run. */
let capturedPrefixes: PrefixResolutionInterface | undefined;

/**
 * Registers `fixture:capture-context` — records `state.context.prefixes` for assertions.
 * The capture slot is reset before each test that uses it.
 */
function registerCaptureTask(): void {
  TaskRegistry.register(
    CAPTURE_TASK_NAME,
    async (next: NextFnInterface, state: PipelineStateInterface): Promise<void> => {
      const ctx = state.context;
      if (ctx !== undefined) {
        capturedPrefixes = ctx.prefixes;
      }
      await next();
    },
  );
}

// ---------------------------------------------------------------------------
// Suite-level setup
// ---------------------------------------------------------------------------

let workDir = '';

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'squashage-orchestrator-'));
  registerFixtureTask();
  registerCaptureTask();
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SquashageOrchestrator', () => {

  describe('run — happy path (2 JSON records)', () => {
    let runDir = '';

    before(async () => {
      runDir = join(workDir, 'happy');
      await mkdir(runDir, { recursive: true });

      await writeFile(join(runDir, 'record1.json'),
        JSON.stringify({ _type: 'thing', name: 'Alpha' }),
        'utf8',
      );
      await writeFile(join(runDir, 'record2.json'),
        JSON.stringify({ _type: 'thing', name: 'Beta' }),
        'utf8',
      );
    });

    it('returns recordCount === 2, succeeded === 2, failed === 0', async () => {
      const outDir = join(workDir, 'happy-out');
      await mkdir(outDir, { recursive: true });
      const outPath = join(outDir, 'out.ttl');
      const config  = buildConfig(runDir, outPath);

      const result = await SquashageOrchestrator.run(config, 'target1', { outDir });

      assert.equal(result.recordCount, 2);
      assert.equal(result.succeeded,   2);
      assert.equal(result.failed,      0);
    });

    it('outputPath exists on disk', async () => {
      const outDir  = join(workDir, 'happy-out2');
      await mkdir(outDir, { recursive: true });
      const outPath = join(outDir, 'out.ttl');
      const config  = buildConfig(runDir, outPath);

      await SquashageOrchestrator.run(config, 'target1', { outDir });

      await access(outPath);  // throws if not found
    });

    it('output Turtle file parses back to exactly 2 quads', async () => {
      const outDir  = join(workDir, 'happy-parse');
      await mkdir(outDir, { recursive: true });
      const outPath = join(outDir, 'out.ttl');
      const config  = buildConfig(runDir, outPath);

      await SquashageOrchestrator.run(config, 'target1', { outDir });

      const text = await readFile(outPath, 'utf8');
      const { quads } = await Parser.parse(text, { format: 'turtle' });
      assert.equal(quads.length, 2);
    });

    it('quarantine is all zeros', async () => {
      const outDir  = join(workDir, 'happy-quarantine');
      await mkdir(outDir, { recursive: true });
      const outPath = join(outDir, 'out.ttl');
      const config  = buildConfig(runDir, outPath);

      const result = await SquashageOrchestrator.run(config, 'target1', { outDir });

      assert.equal(result.quarantine.unknown,    0);
      assert.equal(result.quarantine.conflicts,  0);
      assert.equal(result.quarantine.projection, 0);
      assert.equal(result.quarantine.output,     0);
    });

    it('exitCode is 0', async () => {
      const outDir  = join(workDir, 'happy-exit');
      await mkdir(outDir, { recursive: true });
      const outPath = join(outDir, 'out.ttl');
      const config  = buildConfig(runDir, outPath);

      const result = await SquashageOrchestrator.run(config, 'target1', { outDir });

      assert.equal(result.exitCode, 0);
    });
  });

  describe('run — failure: unregistered task throws ExternalSchemaError', () => {
    it('throws ExternalSchemaError when pipeline contains broken:task', async () => {
      const outDir  = join(workDir, 'broken-task');
      await mkdir(outDir, { recursive: true });
      const outPath = join(outDir, 'out.ttl');
      const config  = buildConfig(outDir, outPath, ['json:read', 'broken:task', 'rdfjs:finalize']);

      await assert.rejects(
        () => SquashageOrchestrator.run(config, 'target1', { outDir }),
        (err: unknown) => err instanceof ExternalSchemaError,
      );
    });
  });

  describe('run — empty input directory', () => {
    it('returns recordCount === 0', async () => {
      const emptyDir = join(workDir, 'empty-in');
      const outDir   = join(workDir, 'empty-out');
      await mkdir(emptyDir, { recursive: true });
      await mkdir(outDir,   { recursive: true });
      const outPath  = join(outDir, 'out.ttl');
      const config   = buildConfig(emptyDir, outPath);

      const result = await SquashageOrchestrator.run(config, 'target1', { outDir });

      assert.equal(result.recordCount, 0);
    });

    it('output file is still created (empty serialization)', async () => {
      const emptyDir = join(workDir, 'empty-in2');
      const outDir   = join(workDir, 'empty-out2');
      await mkdir(emptyDir, { recursive: true });
      await mkdir(outDir,   { recursive: true });
      const outPath  = join(outDir, 'out.ttl');
      const config   = buildConfig(emptyDir, outPath);

      await SquashageOrchestrator.run(config, 'target1', { outDir });

      // File exists (rdfjs:finalize writes even for 0 quads).
      await access(outPath);
    });
  });

  describe('run — missing target throws SquashageConfigError', () => {
    it('throws SquashageConfigError for unknown target', async () => {
      const outDir = join(workDir, 'missing-target');
      await mkdir(outDir, { recursive: true });
      const config = buildConfig(outDir, join(outDir, 'out.ttl'));

      await assert.rejects(
        () => SquashageOrchestrator.run(config, 'does-not-exist', { outDir }),
        (err: unknown) => err instanceof SquashageConfigError,
      );
    });
  });

  describe('run — prefixes are populated and propagated into state.context', () => {
    let prefixRunDir = '';

    before(async () => {
      prefixRunDir = join(workDir, 'prefix-test');
      await mkdir(prefixRunDir, { recursive: true });

      await writeFile(join(prefixRunDir, 'record1.json'),
        JSON.stringify({ name: 'PrefixTestRecord' }),
        'utf8',
      );
    });

    it('state.context.prefixes is populated after a run', async () => {
      capturedPrefixes = undefined;

      const outDir  = join(workDir, 'prefix-out');
      await mkdir(outDir, { recursive: true });
      const outPath = join(outDir, 'out.ttl');
      const config: SquashageConfigInterface = {
        input:   { basePath: prefixRunDir, format: 'json' },
        targets: {
          target1: {
            input:    prefixRunDir,
            pipeline: ['json:read', CAPTURE_TASK_NAME, 'rdfjs:finalize'],
            output:   { kind: 'file', path: outPath },
          },
        },
      };

      await SquashageOrchestrator.run(config, 'target1', { outDir });

      assert.ok(capturedPrefixes !== undefined, 'capturedPrefixes should be set');
      assert.ok(typeof capturedPrefixes.instances.base   === 'string', 'instances.base is a string');
      assert.ok(typeof capturedPrefixes.instances.prefix === 'string', 'instances.prefix is a string');
      assert.ok(typeof capturedPrefixes.graphs.base      === 'string', 'graphs.base is a string');
      assert.ok(typeof capturedPrefixes.graphs.prefix    === 'string', 'graphs.prefix is a string');
      assert.ok(typeof capturedPrefixes.vocabulary.base  === 'string', 'vocabulary.base is a string');
      assert.ok(
        typeof capturedPrefixes.vocabulary.prefix === 'string',
        'vocabulary.prefix is a string',
      );
      assert.ok(
        ['config', 'derived', 'fallback'].includes(capturedPrefixes.source),
        `source must be config|derived|fallback, got "${capturedPrefixes.source}"`,
      );
    });

    it('prefixes.instances.base ends with /', async () => {
      capturedPrefixes = undefined;

      const outDir  = join(workDir, 'prefix-out2');
      await mkdir(outDir, { recursive: true });
      const outPath = join(outDir, 'out.ttl');
      const config: SquashageConfigInterface = {
        input:   { basePath: prefixRunDir, format: 'json' },
        targets: {
          target1: {
            input:    prefixRunDir,
            pipeline: ['json:read', CAPTURE_TASK_NAME, 'rdfjs:finalize'],
            output:   { kind: 'file', path: outPath },
          },
        },
      };

      await SquashageOrchestrator.run(config, 'target1', { outDir });

      assert.ok(capturedPrefixes !== undefined);
      assert.ok(
        capturedPrefixes.instances.base.endsWith('/'),
        `instances.base must end with '/', got "${capturedPrefixes.instances.base}"`,
      );
    });

    it('fallback: prefixes use squashage.dev namespace for target with no config or URL source', async () => {
      capturedPrefixes = undefined;

      const outDir  = join(workDir, 'prefix-fallback');
      await mkdir(outDir, { recursive: true });
      const outPath = join(outDir, 'out.ttl');
      const config: SquashageConfigInterface = {
        input:   { basePath: prefixRunDir, format: 'json' },
        targets: {
          'my-target': {
            input:    prefixRunDir,
            pipeline: ['json:read', CAPTURE_TASK_NAME, 'rdfjs:finalize'],
            output:   { kind: 'file', path: outPath },
          },
        },
      };

      await SquashageOrchestrator.run(config, 'my-target', { outDir });

      assert.ok(capturedPrefixes !== undefined);
      assert.equal(capturedPrefixes.source, 'fallback');
      assert.ok(capturedPrefixes.instances.base.includes('squashage.dev'));
    });
  });

    describe('run — parallel runs do not pollute each other\'s registries', () => {
    let parallelRunDir = '';

    before(async () => {
      parallelRunDir = join(workDir, 'parallel');
      await mkdir(parallelRunDir, { recursive: true });

      // Two input files for target A
      const dirA = join(parallelRunDir, 'a-in');
      await mkdir(dirA, { recursive: true });
      await writeFile(join(dirA, 'a1.json'), JSON.stringify({ name: 'A1' }), 'utf8');
      await writeFile(join(dirA, 'a2.json'), JSON.stringify({ name: 'A2' }), 'utf8');

      // Two input files for target B
      const dirB = join(parallelRunDir, 'b-in');
      await mkdir(dirB, { recursive: true });
      await writeFile(join(dirB, 'b1.json'), JSON.stringify({ name: 'B1' }), 'utf8');
      await writeFile(join(dirB, 'b2.json'), JSON.stringify({ name: 'B2' }), 'utf8');
    });

    it('two simultaneous runs for different targets complete independently without registry cross-contamination', async () => {
      const outDirA = join(parallelRunDir, 'out-a');
      const outDirB = join(parallelRunDir, 'out-b');
      await mkdir(outDirA, { recursive: true });
      await mkdir(outDirB, { recursive: true });

      const configA = buildConfig(
        join(parallelRunDir, 'a-in'),
        join(outDirA, 'out.ttl'),
      );

      // configB is a distinct config with its own target key, same pipeline.
      const configB: SquashageConfigInterface = {
        input: { basePath: join(parallelRunDir, 'b-in'), format: 'json' },
        targets: {
          targetB: {
            input:    join(parallelRunDir, 'b-in'),
            pipeline: ['json:read', FIXTURE_TASK_NAME, 'rdfjs:finalize'],
            output:   { kind: 'file', path: join(outDirB, 'out.ttl') },
          },
        },
      };

      // Run both targets concurrently — each must get its own isolated registry.
      const [resultA, resultB] = await Promise.all([
        SquashageOrchestrator.run(configA, 'target1', { outDir: outDirA }),
        SquashageOrchestrator.run(configB, 'targetB', { outDir: outDirB }),
      ]);

      // Both runs succeed with 2 records each.
      assert.equal(resultA.recordCount, 2, 'run A: recordCount');
      assert.equal(resultA.succeeded,   2, 'run A: succeeded');
      assert.equal(resultA.failed,      0, 'run A: failed');

      assert.equal(resultB.recordCount, 2, 'run B: recordCount');
      assert.equal(resultB.succeeded,   2, 'run B: succeeded');
      assert.equal(resultB.failed,      0, 'run B: failed');
    });
  });
});
