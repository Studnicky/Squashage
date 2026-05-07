/**
 * @fileoverview End-to-end smoke test: full pipeline walk
 * `json:read → fixture:classify → fixture:squash → rdfjs:finalize`
 * writing a TriG output file.
 *
 * @remarks
 * Exercises three scenarios against a live {@link SquashageOrchestrator.run}
 * invocation backed by fixture plugin tasks and a real filesystem under
 * `os.tmpdir()`:
 *
 * 1. **Happy path** — 2 valid JSON records flow through the full pipeline;
 *    the produced `.trig` file is parsed back and verified to contain exactly
 *    4 quads (2 per record: `rdf:type` + `ex:name`).
 *
 * 2. **Malformed JSON record** — one of the two input files contains invalid
 *    JSON.  `json:read` quarantines the bad record (writes a JSON artifact under
 *    `<outDir>/<target>/quarantine/projection/`) without throwing, so the
 *    orchestrator pipeline does not fail — both records complete (one handled
 *    by quarantine, one normally).  The quarantine file is verified on disk.
 *    Note: the current orchestrator implementation returns `exitCode === 0`
 *    and `failed === 0` for per-record quarantine (quarantine is a graceful
 *    path, not an unhandled error).
 *
 * 3. **SHACL validation hook** — a shapes file requiring `sh:minCount 1` on
 *    `ex:name` is configured in `output.validate.shapes`.
 *    - Conforming run: all records emit `ex:name`; `rdfjs:finalize` succeeds.
 *    - Non-conforming run: a `fixture:squash-type-only` variant omits `ex:name`;
 *      `rdfjs:finalize` throws `FileOutputError` and quarantine artifacts are
 *      written under `<outDir>/<target>/quarantine/output/`.
 *
 * @remarks
 * **TaskRegistry isolation** — `TaskRegistry.reset()` is not called between
 * tests because it also clears the built-in tasks registered at module-import
 * time (`json:read`, `rdfjs:finalize`), and those module side-effects will not
 * re-run after the first import.  Instead, fixture tasks are (re-)registered
 * with `TaskRegistry.register` in each `before` hook; `register` is idempotent
 * for same-name tasks (overwrites silently).  Each test case receives its own
 * subdirectory under `os.tmpdir()` to prevent quarantine cross-contamination.
 *
 * @module tests/integration/build-trig
 * @category Integration
 * @since 0.1.0
 */

import { describe, it, before, after } from 'node:test';
import assert  from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join }   from 'node:path';

import { SquashageOrchestrator } from '../../src/orchestrators/SquashageOrchestrator.js';
import { Parser }                from '../../src/rdf/Parser.js';
import { FileOutputError }       from '../../src/errors/FileOutputError.js';
import type { SquashageConfigInterface } from '../../src/config/SquashageConfig.js';
import {
  registerFixtureTasks,
  CLASSIFY_TASK_NAME,
  SQUASH_TASK_NAME,
  SQUASH_TYPE_ONLY_NAME,
} from '../fixtures/squashage/build-trig/plugin.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal {@link SquashageConfigInterface} suitable for the happy-path
 * and malformed-record scenarios.
 *
 * @param inputDir  - Directory containing `.json` input records.
 * @param outputPath - Absolute path for the produced TriG output file.
 * @param pipeline  - Task name array; defaults to the standard 4-task fixture pipeline.
 * @returns A valid `SquashageConfigInterface` with a `things` target.
 */
const buildConfig = (
  inputDir:   string,
  outputPath: string,
  pipeline:   string[] = [
    'json:read',
    CLASSIFY_TASK_NAME,
    SQUASH_TASK_NAME,
    'rdfjs:finalize',
  ],
): SquashageConfigInterface => ({
  input: { basePath: inputDir, format: 'json' },
  targets: {
    things: {
      input:    inputDir,
      pipeline,
      output:   { kind: 'file', path: outputPath },
      graphs:   {},
      ontology: { baseIri: 'https://example.org/' },
    },
  },
});

/**
 * Writes two sample input JSON records to `<inputDir>/{record1,record2}.json`.
 *
 * @param inputDir - Directory into which the records are written.
 */
const writeSampleRecords = async (inputDir: string): Promise<void> => {
  await mkdir(inputDir, { recursive: true });
  await writeFile(
    join(inputDir, 'record1.json'),
    JSON.stringify({ _type: 'thing', name: 'Alice', age: 30 }),
    'utf8',
  );
  await writeFile(
    join(inputDir, 'record2.json'),
    JSON.stringify({ _type: 'thing', name: 'Bob', age: 42 }),
    'utf8',
  );
};

// ---------------------------------------------------------------------------
// Suite-level root tempdir
// ---------------------------------------------------------------------------

let rootDir = '';

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'squashage-integration-'));
  registerFixtureTasks();
});

after(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: Happy path — full pipeline, 2 valid records
// ---------------------------------------------------------------------------

describe('build-trig integration — happy path (2 valid JSON records)', () => {
  const TARGET      = 'things';
  let inputDir  = '';
  let outDir    = '';
  let trigPath  = '';

  before(async () => {
    const base  = join(rootDir, 'happy');
    inputDir    = join(base, 'input', TARGET);
    outDir      = join(base, 'graphs');
    trigPath    = join(base, 'output', `${TARGET}.trig`);

    await writeSampleRecords(inputDir);
    await mkdir(outDir, { recursive: true });

    // Re-register fixture tasks so this describe block is self-contained.
    registerFixtureTasks();
  });

  it('result.recordCount is 2', async () => {
    const config = buildConfig(inputDir, trigPath);
    const result = await SquashageOrchestrator.run(config, TARGET, { outDir });
    assert.equal(result.recordCount, 2);
  });

  it('result.succeeded is 2 and result.failed is 0', async () => {
    const trigP  = join(rootDir, 'happy', 'output', `${TARGET}-2.trig`);
    const config = buildConfig(inputDir, trigP);
    const result = await SquashageOrchestrator.run(config, TARGET, { outDir });
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed,    0);
  });

  it('result.exitCode is 0', async () => {
    const trigP  = join(rootDir, 'happy', 'output', `${TARGET}-3.trig`);
    const config = buildConfig(inputDir, trigP);
    const result = await SquashageOrchestrator.run(config, TARGET, { outDir });
    assert.equal(result.exitCode, 0);
  });

  it('result.quarantine is all zeros', async () => {
    const trigP  = join(rootDir, 'happy', 'output', `${TARGET}-4.trig`);
    const config = buildConfig(inputDir, trigP);
    const result = await SquashageOrchestrator.run(config, TARGET, { outDir });
    assert.equal(result.quarantine.unknown,    0);
    assert.equal(result.quarantine.conflicts,  0);
    assert.equal(result.quarantine.projection, 0);
    assert.equal(result.quarantine.output,     0);
  });

  it('result.outputPath matches the configured trig path', async () => {
    const trigP  = join(rootDir, 'happy', 'output', `${TARGET}-5.trig`);
    const config = buildConfig(inputDir, trigP);
    const result = await SquashageOrchestrator.run(config, TARGET, { outDir });
    assert.equal(result.outputPath, trigP);
  });

  it('output file exists on disk', async () => {
    const trigP  = join(rootDir, 'happy', 'output', `${TARGET}-6.trig`);
    const config = buildConfig(inputDir, trigP);
    await SquashageOrchestrator.run(config, TARGET, { outDir });
    await access(trigP);  // throws if absent
  });

  it('output TriG file parses to exactly 4 quads (2 per record)', async () => {
    const trigP  = join(rootDir, 'happy', 'output', `${TARGET}-7.trig`);
    const config = buildConfig(inputDir, trigP);
    await SquashageOrchestrator.run(config, TARGET, { outDir });

    const text           = await readFile(trigP, 'utf8');
    const { quads }      = await Parser.parse(text, { format: 'trig' });
    assert.equal(quads.length, 4);
  });

  it('parsed quads have expected subjects (https://example.org/Alice and /Bob)', async () => {
    const trigP  = join(rootDir, 'happy', 'output', `${TARGET}-8.trig`);
    const config = buildConfig(inputDir, trigP);
    await SquashageOrchestrator.run(config, TARGET, { outDir });

    const text      = await readFile(trigP, 'utf8');
    const { quads } = await Parser.parse(text, { format: 'trig' });

    const subjects = new Set(quads.map(q => q.subject.value));
    assert.ok(subjects.has('https://example.org/Alice'),
      'Expected subject https://example.org/Alice');
    assert.ok(subjects.has('https://example.org/Bob'),
      'Expected subject https://example.org/Bob');
  });

  it('parsed quads include rdf:type and ex:name predicates', async () => {
    const trigP  = join(rootDir, 'happy', 'output', `${TARGET}-9.trig`);
    const config = buildConfig(inputDir, trigP);
    await SquashageOrchestrator.run(config, TARGET, { outDir });

    const text      = await readFile(trigP, 'utf8');
    const { quads } = await Parser.parse(text, { format: 'trig' });

    const predicates = new Set(quads.map(q => q.predicate.value));
    assert.ok(
      predicates.has('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      'Expected rdf:type predicate',
    );
    assert.ok(
      predicates.has('https://example.org/name'),
      'Expected ex:name predicate',
    );
  });
});

// ---------------------------------------------------------------------------
// Test 2: Malformed JSON record
// ---------------------------------------------------------------------------

describe('build-trig integration — malformed JSON record (quarantine path)', () => {
  const TARGET   = 'things';
  let inputDir   = '';
  let outDir     = '';
  let trigPath   = '';

  before(async () => {
    const base  = join(rootDir, 'malformed');
    inputDir    = join(base, 'input', TARGET);
    outDir      = join(base, 'graphs');
    trigPath    = join(base, 'output', `${TARGET}.trig`);

    await mkdir(inputDir, { recursive: true });
    await mkdir(outDir,   { recursive: true });

    // One valid record, one intentionally malformed.
    await writeFile(
      join(inputDir, 'record1.json'),
      JSON.stringify({ _type: 'thing', name: 'Alice', age: 30 }),
      'utf8',
    );
    await writeFile(
      join(inputDir, 'record2.json'),
      '{ this is not valid json !!!',
      'utf8',
    );

    registerFixtureTasks();
  });

  it('result.recordCount is 2 (both files were discovered by the walk)', async () => {
    const config = buildConfig(inputDir, trigPath);
    const result = await SquashageOrchestrator.run(config, TARGET, { outDir });
    assert.equal(result.recordCount, 2);
  });

  it('malformed record is quarantined — projection artifact exists on disk', async () => {
    const config = buildConfig(inputDir, trigPath);
    await SquashageOrchestrator.run(config, TARGET, { outDir });

    // json:read writes one JSON file per bad record under
    // <outDir>/<target>/quarantine/projection/<sha1-id>.json
    const projectionDir = join(outDir, TARGET, 'quarantine', 'projection');
    const entries = await (await import('node:fs/promises')).readdir(projectionDir);
    assert.ok(entries.length >= 1,
      `Expected at least one quarantine file in ${projectionDir}`);
  });

  it('result.failed is 0 — json:read quarantines gracefully without throwing', async () => {
    // The orchestrator treats json:read quarantine as a graceful path:
    // the task returns without calling next() but also without throwing,
    // so the record ends in completed (not failed) and exitCode stays 0.
    const trigP  = join(rootDir, 'malformed', 'output', `${TARGET}-2.trig`);
    const config = buildConfig(inputDir, trigP);
    const result = await SquashageOrchestrator.run(config, TARGET, { outDir });
    assert.equal(result.failed, 0);
  });
});

// ---------------------------------------------------------------------------
// Test 3: SHACL validation hook — conforming and non-conforming datasets
// ---------------------------------------------------------------------------

describe('build-trig integration — SHACL validation hook', () => {
  const TARGET     = 'things';
  const BASE_IRI   = 'https://example.org/';
  let shapesPath   = '';
  let conformDir   = '';
  let conformOut   = '';
  let conformGraphs= '';
  let violateDir   = '';
  let violateOut   = '';
  let violateGraphs= '';

  before(async () => {
    const base = join(rootDir, 'shacl');

    // Write the SHACL shapes file — requires ex:name on every ex:Thing.
    shapesPath = join(base, 'shapes.ttl');
    await mkdir(base, { recursive: true });
    await writeFile(shapesPath, [
      `@prefix sh:  <http://www.w3.org/ns/shacl#> .`,
      `@prefix ex:  <${BASE_IRI}> .`,
      `@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .`,
      ``,
      `ex:ThingShape`,
      `  a sh:NodeShape ;`,
      `  sh:targetClass ex:Thing ;`,
      `  sh:property [`,
      `    sh:path ex:name ;`,
      `    sh:minCount 1 ;`,
      `    sh:datatype xsd:string ;`,
      `  ] .`,
    ].join('\n'), 'utf8');

    // --- Conforming scenario ---
    conformDir    = join(base, 'conform-input', TARGET);
    conformOut    = join(base, 'conform-output', `${TARGET}.trig`);
    conformGraphs = join(base, 'conform-graphs');

    await mkdir(conformDir,    { recursive: true });
    await mkdir(conformGraphs, { recursive: true });
    await writeFile(
      join(conformDir, 'record1.json'),
      JSON.stringify({ _type: 'thing', name: 'Alice', age: 30 }),
      'utf8',
    );

    // --- Non-conforming scenario ---
    violateDir    = join(base, 'violate-input', TARGET);
    violateOut    = join(base, 'violate-output', `${TARGET}.trig`);
    violateGraphs = join(base, 'violate-graphs');

    await mkdir(violateDir,    { recursive: true });
    await mkdir(violateGraphs, { recursive: true });
    await writeFile(
      join(violateDir, 'record1.json'),
      JSON.stringify({ _type: 'thing', name: 'Charlie' }),
      'utf8',
    );

    registerFixtureTasks();
  });

  it('SHACL conforming: run succeeds when all records include ex:name', async () => {
    const config: SquashageConfigInterface = {
      input: { basePath: conformDir, format: 'json' },
      targets: {
        [TARGET]: {
          input:    conformDir,
          pipeline: ['json:read', CLASSIFY_TASK_NAME, SQUASH_TASK_NAME, 'rdfjs:finalize'],
          output:   {
            kind:     'file',
            path:     conformOut,
            validate: { shapes: shapesPath },
          },
          graphs:   {},
          ontology: { baseIri: BASE_IRI },
        },
      },
    };

    const result = await SquashageOrchestrator.run(config, TARGET, { outDir: conformGraphs });
    assert.equal(result.exitCode, 0);
    assert.equal(result.succeeded, 1);
  });

  it('SHACL non-conforming: rdfjs:finalize throws FileOutputError on violation', async () => {
    const config: SquashageConfigInterface = {
      input: { basePath: violateDir, format: 'json' },
      targets: {
        [TARGET]: {
          input:    violateDir,
          // Uses fixture:squash-type-only which emits rdf:type but NOT ex:name
          pipeline: ['json:read', CLASSIFY_TASK_NAME, SQUASH_TYPE_ONLY_NAME, 'rdfjs:finalize'],
          output:   {
            kind:     'file',
            path:     violateOut,
            validate: { shapes: shapesPath },
          },
          graphs:   {},
          ontology: { baseIri: BASE_IRI },
        },
      },
    };

    await assert.rejects(
      () => SquashageOrchestrator.run(config, TARGET, { outDir: violateGraphs }),
      (err: unknown) => err instanceof FileOutputError,
    );
  });

  it('SHACL non-conforming: quarantine output artifacts exist on disk', async () => {
    const violateOut2    = join(rootDir, 'shacl', 'violate-output', `${TARGET}-2.trig`);
    const violateGraphs2 = join(rootDir, 'shacl', 'violate-graphs-2');
    await mkdir(violateGraphs2, { recursive: true });

    const config: SquashageConfigInterface = {
      input: { basePath: violateDir, format: 'json' },
      targets: {
        [TARGET]: {
          input:    violateDir,
          pipeline: ['json:read', CLASSIFY_TASK_NAME, SQUASH_TYPE_ONLY_NAME, 'rdfjs:finalize'],
          output:   {
            kind:     'file',
            path:     violateOut2,
            validate: { shapes: shapesPath },
          },
          graphs:   {},
          ontology: { baseIri: BASE_IRI },
        },
      },
    };

    // Ignore the thrown error — we only care that artifacts were written.
    try {
      await SquashageOrchestrator.run(config, TARGET, { outDir: violateGraphs2 });
    } catch {
      // Expected FileOutputError from rdfjs:finalize; proceed to artifact check.
    }

    const quarantineDir = join(violateGraphs2, TARGET, 'quarantine', 'output');
    const txt = join(quarantineDir, 'validation.report.txt');
    const ttl = join(quarantineDir, 'validation.report.ttl');

    await access(txt);  // throws if absent
    await access(ttl);  // throws if absent
  });
});
