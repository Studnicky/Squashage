/**
 * @fileoverview Integration test: sidecar provenance reification (Phase 6).
 *
 * @remarks
 * Runs a full pipeline over the aonprd fixture with `output.provenance.enabled`
 * set to `true`, then asserts:
 * - A separate provenance named graph exists in the output dataset.
 * - The provenance graph contains exactly N `prov:Activity` triples, where
 *   N equals the number of successfully classified records (recordCount minus
 *   quarantined records).
 * - The provenance graph is absent (default-disabled) in a standard run without
 *   provenance config.
 * - `runStartTime` is frozen: all provenance quads in a single run carry the
 *   same `prov:atTime` timestamp.
 *
 * Pipeline: json:read -> classify:* -> aonprd:squash -> output:provenance -> rdfjs:finalize
 *
 * The aonprd fixture has 14 input records (recordCount 14), of which:
 *   - 1 is malformed JSON (quarantined in projection/)
 *   - 1 is a conflict tie (quarantined in conflicts/)
 *   - 1 is classless unknown (quarantined in unknown/)
 *   - 11 are successfully classified and emitted
 *
 * After the conflict and unknown records are quarantined their classification
 * is null; `output:provenance` still emits a prov:Activity for every record
 * that reaches the task, meaning records that are NOT quarantined before the
 * task fires. The 1 malformed record never reaches the task (quarantined by
 * json:read). The conflict and unknown records ARE quarantined by classify:conflict
 * but still flow through the pipeline, reaching output:provenance with
 * state.classification === null.
 *
 * So total prov:Activity quads = recordCount - quarantined-by-json:read
 *                                = 14 - 1 (malformed) = 13
 *
 * @module tests/integration/provenance/Provenance
 * @category Integration
 * @since 0.5.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, rm, mkdir, copyFile, readFile, writeFile,
} from 'node:fs/promises';
import { tmpdir }            from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath }     from 'node:url';

import { SquashageOrchestrator } from '../../../src/orchestrators/SquashageOrchestrator.js';
import { SquashageConfig }       from '../../../src/config/SquashageConfig.js';
import { Parser }                from '../../../src/rdf/Parser.js';
import { registerAonprdPlugin }  from '../../e2e/aonprd/plugin.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const AONPRD_FIXTURE = resolve(__dirname, '../../e2e/aonprd');

const PROV_ACTIVITY = 'http://www.w3.org/ns/prov#Activity';
const RDF_TYPE      = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PROV_AT_TIME  = 'http://www.w3.org/ns/prov#atTime';

const INPUT_FILES = [
  'feat-power-attack.json',
  'feat-toughness.json',
  'feat-quick-draw.json',
  'spell-fireball.json',
  'spell-heal.json',
  'monster-goblin-warrior.json',
  'monster-ancient-dragon.json',
  'action-stride.json',
  'equipment-longsword.json',
  'equipment-healing-potion.json',
  'unknown-classless.json',
  'tie-feat-spell.json',
  'malformed.jsonl',
] as const;

const SCHEMA_FILES = [
  'feat.schema.json', 'spell.schema.json', 'monster.schema.json',
  'action.schema.json', 'equipment.schema.json',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupTmpFixture(root: string, provenance?: Record<string, unknown>): Promise<{
  inputDir: string; outDir: string; configPath: string; outputPath: string;
}> {
  const inputDir   = join(root, 'input');
  const outDir     = join(root, 'graphs');
  const schemasDir = join(root, 'schemas');
  const outputPath = join(root, 'out', 'aonprd.trig');

  await mkdir(inputDir,          { recursive: true });
  await mkdir(outDir,            { recursive: true });
  await mkdir(schemasDir,        { recursive: true });
  await mkdir(join(root, 'out'), { recursive: true });

  for (const f of INPUT_FILES) {
    await copyFile(join(AONPRD_FIXTURE, 'input', f),   join(inputDir, f));
  }
  for (const f of SCHEMA_FILES) {
    await copyFile(join(AONPRD_FIXTURE, 'schemas', f), join(schemasDir, f));
  }

  const rawBase = JSON.parse(
    await readFile(join(AONPRD_FIXTURE, 'squashage.config.json'), 'utf8'),
  ) as Record<string, unknown>;

  const targets = rawBase['targets'] as Record<string, Record<string, unknown>>;
  const target  = targets['aonprd']!;

  // Switch output to TriG (supports named graphs)
  const out: Record<string, unknown> = { kind: 'file', path: outputPath, mode: 'dataset' };
  if (provenance !== undefined) {
    out['provenance'] = provenance;
  }
  target['output'] = out;
  target['input']  = inputDir;

  // Inject output:provenance into the pipeline before rdfjs:finalize.
  const pipeline = target['pipeline'] as string[];
  if (provenance !== undefined) {
    const finalizeIdx = pipeline.indexOf('rdfjs:finalize');
    const insertAt    = finalizeIdx >= 0 ? finalizeIdx : pipeline.length;
    pipeline.splice(insertAt, 0, 'output:provenance');
  }

  // Resolve schema paths relative to tmp root.
  const classification = target['classification'] as Record<string, unknown>;
  const schemas = classification['schemas'] as Array<Record<string, unknown>>;
  for (const s of schemas) {
    const rel = s['schemaPath'] as string;
    s['schemaPath'] = join(schemasDir, rel.replace('./', '').replace('schemas/', ''));
  }
  const ontology = target['ontology'] as Record<string, unknown>;
  const jtSchemas = ontology['schemas'] as Array<Record<string, unknown>>;
  for (const s of jtSchemas) {
    const rel = s['schemaPath'] as string;
    s['schemaPath'] = join(schemasDir, rel.replace('./', '').replace('schemas/', ''));
  }

  const configPath = join(root, 'squashage.config.json');
  await writeFile(configPath, JSON.stringify(rawBase, null, 2), 'utf8');

  return { inputDir, outDir, configPath, outputPath };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

before(() => { registerAonprdPlugin(); });

let rootDir = '';
before(async ()  => { rootDir = await mkdtemp(join(tmpdir(), 'sq-int-prov-')); });
after(async ()   => { await rm(rootDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('provenance integration — aonprd fixture with output.provenance.enabled', () => {
  it('pipeline with provenance enabled produces a provenance named graph', async () => {
    const tmp   = await mkdtemp(join(tmpdir(), 'sq-int-prov-enabled-'));
    const paths = await setupTmpFixture(tmp, {
      enabled: true,
      graph:   'provenance',
      include: ['classifier', 'confidence', 'reasons', 'timestamp'],
    });

    const config = SquashageConfig.loadFromFile(paths.configPath);
    const result = await SquashageOrchestrator.run(config, 'aonprd', {
      outDir:        paths.outDir,
      configPath:    paths.configPath,
      inputOverride: paths.inputDir,
    });

    assert.equal(result.recordCount, 14, `recordCount must be 14; got ${result.recordCount.toString()}`);

    const text  = await readFile(paths.outputPath, 'utf8');
    const { quads } = await Parser.parse(text, { format: 'trig' });

    // Find all quads in any named graph where the object is prov:Activity.
    const activityQuads = quads.filter(
      q => q.predicate.value === RDF_TYPE && q.object.value === PROV_ACTIVITY,
    );

    // 14 records, minus 1 malformed (quarantined by json:read before the task fires).
    // The conflict tie and unknown records still reach output:provenance with classification=null,
    // so they also get prov:Activity quads.
    const expectedActivities = 13;
    assert.equal(activityQuads.length, expectedActivities,
      `Expected ${expectedActivities.toString()} prov:Activity quads; got ${activityQuads.length.toString()}`);
  });

  it('provenance graph IRI is a separate named graph distinct from data graphs', async () => {
    const tmp   = await mkdtemp(join(tmpdir(), 'sq-int-prov-graph-'));
    const paths = await setupTmpFixture(tmp, {
      enabled: true,
      graph:   'provenance-graph',
    });

    const config = SquashageConfig.loadFromFile(paths.configPath);
    await SquashageOrchestrator.run(config, 'aonprd', {
      outDir:        paths.outDir,
      configPath:    paths.configPath,
      inputOverride: paths.inputDir,
    });

    const text  = await readFile(paths.outputPath, 'utf8');
    const { quads } = await Parser.parse(text, { format: 'trig' });

    const provGraphIris = new Set(
      quads
        .filter(q => q.predicate.value === RDF_TYPE && q.object.value === PROV_ACTIVITY)
        .map(q => q.graph.value),
    );

    assert.equal(provGraphIris.size, 1,
      `All provenance quads must share one graph IRI; got ${[...provGraphIris].join(', ')}`);

    const provGraphIri = [...provGraphIris][0]!;
    assert.ok(provGraphIri.includes('provenance-graph'),
      `Provenance graph IRI must include 'provenance-graph'; got ${provGraphIri}`);
  });

  it('standard run without provenance config produces no prov:Activity quads', async () => {
    const tmp   = await mkdtemp(join(tmpdir(), 'sq-int-prov-disabled-'));
    const paths = await setupTmpFixture(tmp); // no provenance config

    const config = SquashageConfig.loadFromFile(paths.configPath);
    await SquashageOrchestrator.run(config, 'aonprd', {
      outDir:        paths.outDir,
      configPath:    paths.configPath,
      inputOverride: paths.inputDir,
    });

    const text  = await readFile(paths.outputPath, 'utf8');
    const { quads } = await Parser.parse(text, { format: 'trig' });

    const activityQuads = quads.filter(
      q => q.predicate.value === RDF_TYPE && q.object.value === PROV_ACTIVITY,
    );

    assert.equal(activityQuads.length, 0,
      `No prov:Activity quads should be emitted in a standard run; got ${activityQuads.length.toString()}`);
  });

  it('runStartTime is frozen: all prov:atTime values in a single run are identical', async () => {
    const tmp   = await mkdtemp(join(tmpdir(), 'sq-int-prov-ts-'));
    const paths = await setupTmpFixture(tmp, {
      enabled: true,
      include: ['timestamp'],
    });

    const config = SquashageConfig.loadFromFile(paths.configPath);
    await SquashageOrchestrator.run(config, 'aonprd', {
      outDir:        paths.outDir,
      configPath:    paths.configPath,
      inputOverride: paths.inputDir,
    });

    const text  = await readFile(paths.outputPath, 'utf8');
    const { quads } = await Parser.parse(text, { format: 'trig' });

    const timestampValues = new Set(
      quads
        .filter(q => q.predicate.value === PROV_AT_TIME)
        .map(q => q.object.value),
    );

    assert.ok(timestampValues.size > 0, 'At least one prov:atTime quad must be present');
    assert.equal(timestampValues.size, 1,
      `All prov:atTime values must be identical (frozen runStartTime); got ${[...timestampValues].join(', ')}`);
  });
});
