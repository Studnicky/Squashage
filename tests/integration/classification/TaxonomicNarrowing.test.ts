/**
 * @fileoverview Integration test: TaxonomicNarrowingClassifier in the pipeline.
 *
 * @remarks
 * Exercises a full pipeline run with `classify:taxonomic-narrowing` enabled and
 * a small OWL TBox declaring `Weapon subClassOf Equipment`. The test provides
 * a record that receives both a `Weapon` proposal and an `Equipment` proposal
 * from the schema classifier, then verifies:
 *
 * - The narrowing classifier drops `Equipment` and keeps `Weapon`.
 * - The `__narrowing_applied__` sentinel is present in proposals before conflict.
 * - ConflictResolver resolves `Weapon` as the final type (not quarantine).
 * - The run's recordCount matches the number of input files.
 *
 * The TBox is written to a temp file in Turtle format and configured via
 * `classification.taxonomicNarrowing.tboxFrom`.
 *
 * @module tests/integration/classification/TaxonomicNarrowing
 * @category Integration
 * @since 0.5.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, rm, mkdir, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join }   from 'node:path';

import { SquashageOrchestrator } from '../../../src/orchestrators/SquashageOrchestrator.js';
import { TaskRegistry }          from '../../../src/registry/TaskRegistry.js';
import type { SquashageConfigInterface } from '../../../src/config/SquashageConfig.js';
import type { NextFnInterface, TaskFnInterface } from '../../../src/types/Pipeline.js';
import type {
  PipelineStateInterface,
  ClassificationProposalInterface,
} from '../../../src/types/PipelineState.js';

// ---------------------------------------------------------------------------
// Inline schemas
// ---------------------------------------------------------------------------

/**
 * Weapon schema: requires 'name' and 'damage'.
 * Used by classify:schema to emit a 'Weapon' proposal.
 */
const WEAPON_SCHEMA = {
  '$id':     'https://squashage.dev/schemas/narrowing-test/weapon',
  title:     'Weapon',
  '$schema': 'http://json-schema.org/draft-07/schema#',
  type:      'object',
  additionalProperties: true,
  required:  ['name', 'damage'],
  properties: {
    name:   { type: 'string' },
    damage: { type: 'string' },
  },
};

/**
 * Equipment schema: requires only 'name'.
 * Because Weapon also has 'name', any Weapon record will also match Equipment.
 * This creates the supertype collision the narrowing classifier resolves.
 */
const EQUIPMENT_SCHEMA = {
  '$id':     'https://squashage.dev/schemas/narrowing-test/equipment',
  title:     'Equipment',
  '$schema': 'http://json-schema.org/draft-07/schema#',
  type:      'object',
  additionalProperties: true,
  required:  ['name'],
  properties: {
    name: { type: 'string' },
  },
};

// ---------------------------------------------------------------------------
// OWL TBox (Turtle)
// ---------------------------------------------------------------------------

/**
 * Minimal OWL TBox declaring Weapon subClassOf Equipment.
 * Written to disk at test setup; referenced by the config's tboxFrom path.
 */
const WEAPON_TBOX_TURTLE = `
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix :    <https://squashage.dev/schemas/narrowing-test/> .

:Weapon owl:subClassOf :Equipment .
`.trim();

// ---------------------------------------------------------------------------
// Captured state store
// ---------------------------------------------------------------------------

/** Captures proposals and classification types from each record processed. */
const captured: {
  /** Proposals captured BEFORE taxonomic narrowing (after classify:schema). */
  proposalsPreNarrowing:  ReadonlyArray<ClassificationProposalInterface>[];
  /** Proposals captured AFTER taxonomic narrowing (after classify:taxonomic-narrowing). */
  proposalsPostNarrowing: ReadonlyArray<ClassificationProposalInterface>[];
  /** Final classification types captured by the post-conflict fixture. */
  classificationTypes:    (string | null)[];
} = {
  proposalsPreNarrowing:  [],
  proposalsPostNarrowing: [],
  classificationTypes:    [],
};

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

function buildConfig(
  inputDir:    string,
  outputPath:  string,
  tboxPath:    string,
  weaponSchemaPath: string,
  equipmentSchemaPath: string,
): SquashageConfigInterface {
  return {
    input: { basePath: inputDir, format: 'json' },
    targets: {
      narrowing: {
        input:    inputDir,
        pipeline: [
          'json:read',
          'classify:schema',
          'fixture:narrowing:pre',       // capture proposals BEFORE narrowing
          'classify:taxonomic-narrowing',
          'fixture:narrowing:post',      // capture proposals AFTER narrowing
          'classify:conflict',
          'fixture:narrowing:squash',    // capture final classification type
          'rdfjs:finalize',
        ],
        output: { kind: 'file', path: outputPath },
        graphs: {},
        classification: {
          schemas: [
            { className: 'Weapon',    priority: 30, schemaPath: weaponSchemaPath },
            { className: 'Equipment', priority: 30, schemaPath: equipmentSchemaPath },
          ],
          taxonomicNarrowing: {
            tboxFrom: tboxPath,
            enabled:  true,
          },
          conflict: {
            onConflict: 'pickPriority',
            onUnknown:  'quarantine',
            evidence:   true,
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture squash task registration
// ---------------------------------------------------------------------------

let fixtureRegistered = false;

function registerFixtureTasks(): void {
  if (fixtureRegistered) return;
  fixtureRegistered = true;

  const preTask: TaskFnInterface<PipelineStateInterface> = async (
    next: NextFnInterface,
    state: PipelineStateInterface,
  ): Promise<void> => {
    captured.proposalsPreNarrowing.push([...state.classifications]);
    await next();
  };

  const postTask: TaskFnInterface<PipelineStateInterface> = async (
    next: NextFnInterface,
    state: PipelineStateInterface,
  ): Promise<void> => {
    captured.proposalsPostNarrowing.push([...state.classifications]);
    await next();
  };

  const squashTask: TaskFnInterface<PipelineStateInterface> = async (
    next: NextFnInterface,
    state: PipelineStateInterface,
  ): Promise<void> => {
    captured.classificationTypes.push(state.classification?.type ?? null);
    await next();
  };

  TaskRegistry.register('fixture:narrowing:pre',    preTask);
  TaskRegistry.register('fixture:narrowing:post',   postTask);
  TaskRegistry.register('fixture:narrowing:squash', squashTask);
}

// ---------------------------------------------------------------------------
// Suite-level temp directory
// ---------------------------------------------------------------------------

let rootDir  = '';
let tboxPath = '';
let weaponSchemaPath    = '';
let equipmentSchemaPath = '';

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'sq-int-narrowing-'));

  const configDir = join(rootDir, 'config');
  await mkdir(configDir, { recursive: true });

  tboxPath             = join(configDir, 'weapon.tbox.ttl');
  weaponSchemaPath     = join(configDir, 'weapon.schema.json');
  equipmentSchemaPath  = join(configDir, 'equipment.schema.json');

  await writeFile(tboxPath,            WEAPON_TBOX_TURTLE,              'utf8');
  await writeFile(weaponSchemaPath,    JSON.stringify(WEAPON_SCHEMA),   'utf8');
  await writeFile(equipmentSchemaPath, JSON.stringify(EQUIPMENT_SCHEMA),'utf8');

  registerFixtureTasks();
});

after(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('TaxonomicNarrowingClassifier integration: narrowing in full pipeline', () => {
  let inputDir   = '';
  let outDir     = '';
  let outputPath = '';

  before(async () => {
    inputDir   = join(rootDir, 'input');
    outDir     = join(rootDir, 'graphs');
    outputPath = join(rootDir, 'out', 'narrowing.jsonld');

    await mkdir(inputDir,             { recursive: true });
    await mkdir(outDir,               { recursive: true });
    await mkdir(join(rootDir, 'out'), { recursive: true });

    // A record that satisfies BOTH Weapon (has name + damage) and Equipment (has name).
    const weaponRecord = {
      _source: { target: 'narrowing', plugin: 'test:parse' },
      name:    'Whip',
      damage:  '1d4',
    };

    await writeFile(join(inputDir, 'whip.json'), JSON.stringify(weaponRecord), 'utf8');

    const cfg = buildConfig(
      inputDir, outputPath, tboxPath, weaponSchemaPath, equipmentSchemaPath,
    );

    // Reset captures before the run.
    captured.proposalsPreNarrowing.length  = 0;
    captured.proposalsPostNarrowing.length = 0;
    captured.classificationTypes.length    = 0;

    await SquashageOrchestrator.run(cfg, 'narrowing', {
      outDir,
      inputOverride: inputDir,
    });
  });

  it('run processes exactly 1 record', async () => {
    const cfg = buildConfig(
      inputDir, outputPath, tboxPath, weaponSchemaPath, equipmentSchemaPath,
    );
    const result = await SquashageOrchestrator.run(cfg, 'narrowing', {
      outDir,
      inputOverride: inputDir,
    });
    assert.strictEqual(result.recordCount, 1, 'expected exactly 1 record');
  });

  it('schema classifier proposes both Weapon and Equipment for the whip record', () => {
    assert.ok(captured.proposalsPreNarrowing.length > 0, 'expected at least one pre-narrowing capture');
    const proposals = captured.proposalsPreNarrowing[0]!;

    const schemaProposals = proposals.filter(p => p.source === 'classify:schema');
    const classNames = schemaProposals.map(p => p.className).sort();
    assert.ok(
      classNames.includes('Weapon') && classNames.includes('Equipment'),
      `Expected both Weapon and Equipment from classify:schema; got: ${classNames.join(', ')}`,
    );
  });

  it('taxonomic narrowing drops Equipment and keeps Weapon', () => {
    assert.ok(captured.proposalsPostNarrowing.length > 0, 'expected at least one post-narrowing capture');
    const proposals = captured.proposalsPostNarrowing[0]!;

    // The narrowing sentinel must be present.
    const sentinel = proposals.find(p => p.className === '__narrowing_applied__');
    assert.ok(sentinel !== undefined, '__narrowing_applied__ sentinel must be present after narrowing');

    // Equipment must be absent from real proposals.
    const realProposals = proposals.filter(p => !p.className.startsWith('__'));
    const classNames    = realProposals.map(p => p.className);
    assert.ok(
      classNames.includes('Weapon'),
      `Expected Weapon to survive narrowing; got: ${classNames.join(', ')}`,
    );
    assert.ok(
      !classNames.includes('Equipment'),
      `Equipment must be dropped by narrowing; got: ${classNames.join(', ')}`,
    );
  });

  it('ConflictResolver resolves Weapon as the final classification type', () => {
    assert.ok(captured.classificationTypes.length > 0, 'expected at least one classification type');
    const resolvedType = captured.classificationTypes[0];
    assert.strictEqual(
      resolvedType,
      'Weapon',
      `Expected final type "Weapon"; got "${String(resolvedType)}"`,
    );
  });
});
