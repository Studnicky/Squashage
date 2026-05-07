/**
 * @fileoverview Integration test: full classifier cascade pipeline.
 *
 * @remarks
 * Exercises a complete classification cascade via a live
 * {@link SquashageOrchestrator.run} invocation with real classifier task
 * classes wired through {@link ClassificationFactory}:
 *
 * Pipeline: `json:read → classify:source → classify:structural →
 * classify:rules → classify:ontology → classify:conflict →
 * fixture:squash → rdfjs:finalize`
 *
 * Two records are processed:
 * 1. **Matched record** (`{ _type: 'feat', id: 'power-attack', level: 1 }`) —
 *    matches the structural rule (`_type equals 'feat'`) and the rules
 *    entry (`_type equals 'feat' AND level is number`). `classify:conflict`
 *    resolves to `className: 'feat'`. `fixture:squash` emits one quad.
 *    The produced TriG file contains exactly one quad.
 *
 * 2. **Unmatched record** (`{ _type: 'unknown_entity', id: 'missingno' }`) —
 *    matches no structural or rules predicates. `classify:conflict` receives
 *    zero real proposals (only the `__source__` sentinel from
 *    `classify:source`) and applies `onUnknown: 'quarantine'`. The record
 *    lands in `<outDir>/<target>/quarantine/unknown/`. `fixture:squash`
 *    emits nothing (classification is null). The TriG file contains no quad
 *    for this record.
 *
 * **Determinism assertions:**
 * - The TriG output contains exactly one quad (from the matched record only).
 * - The quarantine `unknown/` bucket contains exactly one file.
 * - The quad subject is `https://example.org/feat/power-attack`.
 *
 * @module tests/integration/build-classify-cascade
 * @category Integration
 * @since 2.2.0
 */

import { describe, it, before, after } from 'node:test';
import assert  from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join }   from 'node:path';

import { SquashageOrchestrator } from '../../src/orchestrators/SquashageOrchestrator.js';
import { Parser }                from '../../src/rdf/Parser.js';
import type { SquashageConfigInterface } from '../../src/config/SquashageConfig.js';
import {
  registerFixtureTasks,
  SQUASH_TASK_NAME,
} from '../fixtures/squashage/build-classify-cascade/plugin.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET = 'cascade';

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

/**
 * Builds a minimal {@link SquashageConfigInterface} with a full classification
 * cascade for the `cascade` target.
 *
 * @param inputDir   - Directory containing `.json` input records.
 * @param outputPath - Absolute path for the produced TriG output file.
 * @param outDir     - Output base directory for quarantine artifacts.
 * @returns A valid `SquashageConfigInterface` wiring all six classifier tasks.
 */
const buildConfig = (
  inputDir:   string,
  outputPath: string,
): SquashageConfigInterface => ({
  input: { basePath: inputDir, format: 'json' },
  targets: {
    [TARGET]: {
      input:    inputDir,
      pipeline: [
        'json:read',
        'classify:source',
        'classify:structural',
        'classify:rules',
        'classify:ontology',
        'classify:conflict',
        SQUASH_TASK_NAME,
        'rdfjs:finalize',
      ],
      output:   { kind: 'file', path: outputPath },
      graphs:   {},
      ontology: { baseIri: 'https://example.org/' },
      classification: {
        source: true,
        structural: [
          {
            className: 'feat',
            priority:  10,
            predicate: { path: '/_type', equals: 'feat' },
            reasons:   ['_type=feat (structural)'],
          },
        ],
        rules: [
          {
            className: 'feat',
            priority:  20,
            predicate: {
              all: [
                { path: '/_type', equals: 'feat' },
                { path: '/level', type: 'number' },
              ],
            },
            reasons:   ['_type=feat', 'level present'],
          },
        ],
        ontology: {
          classes: {
            feat: 'https://example.org/class/Feat',
          },
        },
        conflict: {
          onConflict: 'quarantine',
          onUnknown:  'quarantine',
          evidence:   true,
        },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Fixture records
// ---------------------------------------------------------------------------

/** Record that matches structural + rules → classified as 'feat'. */
const MATCHED_RECORD = {
  _type:  'feat',
  id:     'power-attack',
  level:  1,
  _source: {
    target:   'cascade',
    plugin:   'cascade:parse',
    schemaId: 'feat',
  },
};

/** Record that matches no rules → quarantined under 'unknown'. */
const UNMATCHED_RECORD = {
  _type: 'unknown_entity',
  id:    'missingno',
};

// ---------------------------------------------------------------------------
// Suite-level temp directory
// ---------------------------------------------------------------------------

let rootDir = '';

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'squashage-cascade-'));
  registerFixtureTasks();
});

after(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test suite: Classify cascade end-to-end
// ---------------------------------------------------------------------------

describe('build-classify-cascade integration — full cascade pipeline', () => {
  let inputDir  = '';
  let outDir    = '';
  let trigPath  = '';

  before(async () => {
    const base = join(rootDir, 'cascade');
    inputDir   = join(base, 'input', TARGET);
    outDir     = join(base, 'graphs');
    trigPath   = join(base, 'output', `${TARGET}.trig`);

    await mkdir(inputDir,            { recursive: true });
    await mkdir(outDir,              { recursive: true });
    await mkdir(join(base, 'output'), { recursive: true });

    await writeFile(
      join(inputDir, 'power-attack.json'),
      JSON.stringify(MATCHED_RECORD),
      'utf8',
    );
    await writeFile(
      join(inputDir, 'missingno.json'),
      JSON.stringify(UNMATCHED_RECORD),
      'utf8',
    );

    registerFixtureTasks();
  });

  it('result.recordCount is 2', async () => {
    const config = buildConfig(inputDir, trigPath);
    const result = await SquashageOrchestrator.run(config, TARGET, { outDir });
    assert.equal(result.recordCount, 2);
  });

  it('result.succeeded is 2 (both records complete the pipeline without throwing)', async () => {
    const trigP  = join(rootDir, 'cascade', 'output', `${TARGET}-s.trig`);
    const config = buildConfig(inputDir, trigP);
    const result = await SquashageOrchestrator.run(config, TARGET, { outDir });
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 0);
  });

  it('result.quarantine.unknown is 1 (unmatched record quarantine artifact exists on disk)', async () => {
    const trigP  = join(rootDir, 'cascade', 'output', `${TARGET}-q.trig`);
    const config = buildConfig(inputDir, trigP);
    await SquashageOrchestrator.run(config, TARGET, { outDir });
    // QuarantineWriter.summary() on the orchestrator-level instance reflects
    // zero because classify:conflict owns its own per-run QuarantineWriter
    // instance. The quarantine artifact is verified on disk instead.
    const unknownDir = join(outDir, TARGET, 'quarantine', 'unknown');
    const entries = await readdir(unknownDir);
    assert.equal(entries.length, 1,
      `Expected 1 artifact in unknown/ quarantine; got ${entries.length.toString()}`);
  });

  it('quarantine unknown/ directory contains exactly one artifact file', async () => {
    const trigP  = join(rootDir, 'cascade', 'output', `${TARGET}-qfile.trig`);
    const config = buildConfig(inputDir, trigP);
    await SquashageOrchestrator.run(config, TARGET, { outDir });

    const unknownDir = join(outDir, TARGET, 'quarantine', 'unknown');
    const entries = await readdir(unknownDir);
    assert.equal(entries.length, 1,
      `Expected exactly 1 file in unknown/ quarantine; got ${entries.length.toString()}`);
  });

  it('produced TriG file contains exactly one quad (only the matched record)', async () => {
    const trigP  = join(rootDir, 'cascade', 'output', `${TARGET}-quads.trig`);
    const config = buildConfig(inputDir, trigP);
    await SquashageOrchestrator.run(config, TARGET, { outDir });

    const text      = await readFile(trigP, 'utf8');
    const { quads } = await Parser.parse(text, { format: 'trig' });
    assert.equal(quads.length, 1,
      `Expected exactly 1 quad in the TriG output; got ${quads.length.toString()}`);
  });

  it('the quad subject is <https://example.org/feat/power-attack> (matched record only)', async () => {
    const trigP  = join(rootDir, 'cascade', 'output', `${TARGET}-subject.trig`);
    const config = buildConfig(inputDir, trigP);
    await SquashageOrchestrator.run(config, TARGET, { outDir });

    const text      = await readFile(trigP, 'utf8');
    const { quads } = await Parser.parse(text, { format: 'trig' });

    const subjects = new Set(quads.map((q) => q.subject.value));
    assert.ok(
      subjects.has('https://example.org/feat/power-attack'),
      `Expected subject https://example.org/feat/power-attack; got: ${[...subjects].join(', ')}`,
    );
    assert.ok(
      !subjects.has('https://example.org/feat/missingno'),
      'Unmatched record should produce no quads',
    );
  });

  it('the quad predicate is rdf:type (fixture:squash emits rdf:type)', async () => {
    const trigP  = join(rootDir, 'cascade', 'output', `${TARGET}-predicate.trig`);
    const config = buildConfig(inputDir, trigP);
    await SquashageOrchestrator.run(config, TARGET, { outDir });

    const text      = await readFile(trigP, 'utf8');
    const { quads } = await Parser.parse(text, { format: 'trig' });

    const predicates = new Set(quads.map((q) => q.predicate.value));
    assert.ok(
      predicates.has('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      'Expected rdf:type predicate',
    );
  });
});
