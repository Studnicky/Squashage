/**
 * @fileoverview Integration test: PropertyFingerprintClassifier through the orchestrator pipeline.
 *
 * @remarks
 * Exercises a full pipeline run with `classify:property-fingerprint` enabled.
 * Uses fingerprints derived from the aonprd test corpus feat records. Asserts that:
 *
 * - A feat record gets a `classify:property-fingerprint` proposal with
 *   `className: 'feat'` on `state.classifications`.
 * - `recordCount` is preserved (no regression).
 *
 * The fingerprint for `feat` is derived from the union of aonprd corpus feat
 * record keys: `_source, _type, action_cost, description_text, level, name,
 * prerequisites, rarity, traits, url`. A minimal fixture squash task captures
 * proposals from `state.classifications` without touching RDF output.
 *
 * @module tests/integration/classification/PropertyFingerprintClassifier
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
import type { PipelineStateInterface, ClassificationProposalInterface } from '../../../src/types/PipelineState.js';

// ---------------------------------------------------------------------------
// Captured state store
// ---------------------------------------------------------------------------

const captured: {
  classifications: ReadonlyArray<ClassificationProposalInterface>[];
} = {
  classifications: [],
};

// ---------------------------------------------------------------------------
// Fingerprint derived from aonprd feat corpus
// Keys present in all three feat records: _source, _type, action_cost,
// description_text, level, name, prerequisites, rarity, traits, url
// ---------------------------------------------------------------------------

const FEAT_FINGERPRINT_KEYS = [
  '_source',
  '_type',
  'action_cost',
  'description_text',
  'level',
  'name',
  'prerequisites',
  'rarity',
  'traits',
  'url',
];

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

function buildConfig(
  inputDir:        string,
  outputPath:      string,
  fingerprintsPath: string,
): SquashageConfigInterface {
  return {
    input: { basePath: inputDir, format: 'json' },
    targets: {
      aonprd: {
        input:    inputDir,
        pipeline: [
          'json:read',
          'classify:source',
          'classify:property-fingerprint',
          'classify:conflict',
          'fixture:pfc:squash',
          'rdfjs:finalize',
        ],
        output: { kind: 'file', path: outputPath },
        graphs: {},
        classification: {
          source: true,
          propertyFingerprint: {
            fingerprintsFrom: fingerprintsPath,
            minMatchScore:    0.80,
            priority:         32,
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
// Fixture task registration
// ---------------------------------------------------------------------------

let fixtureRegistered = false;

function registerFixtureTasks(): void {
  if (fixtureRegistered) return;
  fixtureRegistered = true;

  const squashTask: TaskFnInterface<PipelineStateInterface> = async (
    next: NextFnInterface,
    state: PipelineStateInterface,
  ): Promise<void> => {
    captured.classifications.push(state.classifications);
    await next();
  };

  TaskRegistry.register('fixture:pfc:squash', squashTask);
}

// ---------------------------------------------------------------------------
// Suite-level temp directory
// ---------------------------------------------------------------------------

let rootDir = '';

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'sq-int-pfc-'));
  registerFixtureTasks();
});

after(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('PropertyFingerprintClassifier integration: fingerprint proposals in full pipeline', () => {
  let inputDir          = '';
  let outDir            = '';
  let outputPath        = '';
  let configPath        = '';
  let fingerprintsPath  = '';

  before(async () => {
    inputDir         = join(rootDir, 'input');
    outDir           = join(rootDir, 'graphs');
    outputPath       = join(rootDir, 'out', 'aonprd.jsonld');
    configPath       = join(rootDir, 'squashage.config.json');
    fingerprintsPath = join(rootDir, 'fingerprints.json');

    await mkdir(inputDir,              { recursive: true });
    await mkdir(outDir,                { recursive: true });
    await mkdir(join(rootDir, 'out'),  { recursive: true });

    // Write fingerprints derived from the aonprd corpus feat records.
    await writeFile(
      fingerprintsPath,
      JSON.stringify({
        feat: { keys: FEAT_FINGERPRINT_KEYS, weight: 0.95 },
      }, null, 2),
      'utf-8',
    );

    // Feat record with all the expected keys from the aonprd corpus.
    const featRecord = {
      _type:            'feat',
      url:              'https://2e.aonprd.com/Feats.aspx?ID=750',
      name:             'Power Attack',
      level:            1,
      rarity:           'common',
      traits:           ['flourish'],
      action_cost:      'two-actions',
      prerequisites:    null,
      description_text: 'You unleash a particularly powerful attack.',
      _source: {
        target: 'aonprd',
        path:   'feat-power-attack.json',
        url:    'https://2e.aonprd.com/Feats.aspx?ID=750',
        plugin: 'aonprd:parse',
      },
    };

    await writeFile(
      join(inputDir, 'feat-power-attack.json'),
      JSON.stringify(featRecord),
      'utf-8',
    );

    const cfg = buildConfig(inputDir, outputPath, fingerprintsPath);
    await writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

    // Reset captures before the run.
    captured.classifications.length = 0;

    await SquashageOrchestrator.run(cfg, 'aonprd', {
      outDir,
      configPath,
      inputOverride: inputDir,
    });
  });

  it('run processes exactly 1 record', async () => {
    const cfg = buildConfig(inputDir, outputPath, fingerprintsPath);
    const result = await SquashageOrchestrator.run(cfg, 'aonprd', {
      outDir,
      configPath,
      inputOverride: inputDir,
    });
    assert.strictEqual(result.recordCount, 1, 'expected exactly 1 record');
  });

  it('feat record receives a property-fingerprint proposal with className "feat"', () => {
    assert.ok(
      captured.classifications.length > 0,
      'expected at least one record to be processed',
    );

    const proposals = captured.classifications[0]!;
    const fpProposals = proposals.filter(p => p.source === 'classify:property-fingerprint');

    assert.ok(
      fpProposals.length > 0,
      `Expected at least one property-fingerprint proposal; got sources: ${proposals.map(p => p.source).join(', ')}`,
    );

    const featProposal = fpProposals.find(p => p.className === 'feat');
    assert.ok(
      featProposal !== undefined,
      `Expected property-fingerprint proposal with className "feat"; got: ${fpProposals.map(p => p.className).join(', ')}`,
    );
  });

  it('feat fingerprint proposal has priority 32 and score reason', () => {
    const proposals = captured.classifications[0]!;
    const featProposal = proposals.find(
      p => p.source === 'classify:property-fingerprint' && p.className === 'feat',
    );
    assert.ok(featProposal !== undefined);
    assert.strictEqual(featProposal.priority, 32);
    assert.ok(
      featProposal.reasons.some(r => r.startsWith('fingerprint.score=')),
      `Expected a reason starting with "fingerprint.score="; got: ${featProposal.reasons.join(', ')}`,
    );
    assert.ok(
      featProposal.reasons.some(r => r.startsWith('fingerprint.shared=')),
      `Expected a reason starting with "fingerprint.shared="; got: ${featProposal.reasons.join(', ')}`,
    );
  });

  it('feat fingerprint proposal confidence is at or above minMatchScore (0.80)', () => {
    const proposals = captured.classifications[0]!;
    const featProposal = proposals.find(
      p => p.source === 'classify:property-fingerprint' && p.className === 'feat',
    );
    assert.ok(featProposal !== undefined);
    assert.ok(
      featProposal.confidence >= 0.80,
      `Expected confidence >= 0.80; got ${featProposal.confidence}`,
    );
  });
});
