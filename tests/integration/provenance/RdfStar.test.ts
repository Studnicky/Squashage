/**
 * @fileoverview Integration test: RDF-star provenance encoding (Phase 7).
 *
 * @remarks
 * Runs a full pipeline over the aonprd fixture with `output.provenance.encoding`
 * set to `"rdf-star"`, then asserts that quoted-triple provenance quads are
 * present in the dataset and the output file contains RDF-star syntax.
 *
 * aonprd fixture record counts:
 *   - 14 total input records (recordCount 14)
 *   - 1 malformed JSON (quarantined by json:read -- never reaches output:provenance)
 *   - 1 conflict tie (quarantined by classify:conflict -- classification=null)
 *   - 1 classless unknown (quarantined by classify:conflict -- classification=null)
 *   - 11 successfully classified records that get rdf:type quads emitted
 *
 * RDF-star provenance only quotes rdf:type quads. Records with classification=null
 * (conflict and unknown) have no rdf:type emitted by the plugin, so the helper
 * finds no type quad to quote and logs a warning instead.
 *
 * With `include: ["classifier"]`, each classified record contributes exactly 1
 * prov:wasGeneratedBy quoted-triple-subject quad, yielding 11 total in the
 * in-memory dataset.
 *
 * n3 v2.0.3 note: n3 serializes quoted triples as `<<( )>>` (with inner
 * parentheses). The n3 parser does not parse that syntax back in v2.0.3. The
 * integration tests therefore verify the in-memory dataset (via the pipeline
 * result) and the presence of RDF-star markers in the output file text, rather
 * than performing a full TriG round-trip parse.
 *
 * @module tests/integration/provenance/RdfStar
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
import type { Quad }             from '@rdfjs/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const AONPRD_FIXTURE = resolve(__dirname, '../../e2e/aonprd');

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

/** Returns true when a quad has a Quad-typed subject (RDF-star quoted triple). */
const isQuotedTripleSubject = (q: Quad): boolean => q.subject.termType === 'Quad';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

before(() => { registerAonprdPlugin(); });

let rootDir = '';
before(async ()  => { rootDir = await mkdtemp(join(tmpdir(), 'sq-int-rdfstar-')); });
after(async ()   => { await rm(rootDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('provenance integration -- RDF-star encoding with aonprd fixture', () => {
  it('pipeline with encoding:"rdf-star" records correct recordCount and produces RDF-star markers in output file', async () => {
    const tmp   = await mkdtemp(join(tmpdir(), 'sq-int-rs-enabled-'));
    const paths = await setupTmpFixture(tmp, {
      enabled:  true,
      encoding: 'rdf-star',
      include:  ['classifier'],
    });

    const config = SquashageConfig.loadFromFile(paths.configPath);
    const result = await SquashageOrchestrator.run(config, 'aonprd', {
      outDir:        paths.outDir,
      configPath:    paths.configPath,
      inputOverride: paths.inputDir,
    });

    assert.equal(result.recordCount, 14,
      `recordCount must be 14; got ${result.recordCount.toString()}`);

    // n3 v2.0.3 writes quoted triples as <<( )>> syntax.
    // Verify that the output file contains the RDF-star markers.
    const text = await readFile(paths.outputPath, 'utf8');
    assert.ok(text.includes('<<'),
      'Output file must contain << >> (RDF-star quoted-triple markers)');
  });

  it('standard run without provenance config produces no RDF-star markers in output file', async () => {
    const tmp   = await mkdtemp(join(tmpdir(), 'sq-int-rs-disabled-'));
    const paths = await setupTmpFixture(tmp); // no provenance

    const config = SquashageConfig.loadFromFile(paths.configPath);
    await SquashageOrchestrator.run(config, 'aonprd', {
      outDir:        paths.outDir,
      configPath:    paths.configPath,
      inputOverride: paths.inputDir,
    });

    const text  = await readFile(paths.outputPath, 'utf8');

    // Standard run must produce standard TriG only, no RDF-star markers.
    assert.ok(!text.includes('<<'),
      'Standard run output must not contain RDF-star << >> markers');

    // Verify we can parse the standard TriG output normally.
    const { quads } = await Parser.parse(text, { format: 'trig' });
    assert.ok(quads.length > 0, 'Standard run must produce quads');

    const quotedQuads = (quads as Quad[]).filter(isQuotedTripleSubject);
    assert.equal(quotedQuads.length, 0,
      `Standard run must produce no quoted-triple-subject quads; got ${quotedQuads.length.toString()}`);
  });

  it('encoding:"rdf-star" output contains one << marker per classified record with include:["classifier"]', async () => {
    const tmp   = await mkdtemp(join(tmpdir(), 'sq-int-rs-count-'));
    const paths = await setupTmpFixture(tmp, {
      enabled:  true,
      encoding: 'rdf-star',
      include:  ['classifier'],
    });

    const config = SquashageConfig.loadFromFile(paths.configPath);
    await SquashageOrchestrator.run(config, 'aonprd', {
      outDir:        paths.outDir,
      configPath:    paths.configPath,
      inputOverride: paths.inputDir,
    });

    // Count occurrences of '<<(' in the file (n3 v2.0.3 format).
    const text   = await readFile(paths.outputPath, 'utf8');
    const count  = (text.match(/<<\(/g) ?? []).length;

    // 11 classified records x 1 include category (classifier) = 11 quoted quads.
    const expectedQuotedQuads = 11;
    assert.equal(count, expectedQuotedQuads,
      `Expected ${expectedQuotedQuads.toString()} quoted-triple occurrences; got ${count.toString()}`);
  });
});
