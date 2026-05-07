/**
 * @fileoverview Integration test: WinknlpEntitiesClassifier through the
 * orchestrator pipeline.
 *
 * @remarks
 * Exercises a full pipeline run with `classify:winknlp-entities` enabled.
 * Uses an aonprd-style fixture record whose `description` field contains the
 * phrase "This feat costs two actions". Configures a pattern
 * `"feat-action-cost"` with patterns `["two actions", "cost [NUM] action"]`
 * mapping to `className: "feat"`. Asserts:
 *
 * - The record receives a `classify:winknlp-entities` proposal with
 *   `className: "feat"` on `state.classifications`.
 * - `recordCount` is 1 (no regression).
 *
 * @module tests/integration/classification/WinknlpEntitiesClassifier
 * @category Integration
 * @since 0.6.0
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
} = { classifications: [] };

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

function buildConfig(
  inputDir:   string,
  outputPath: string,
): SquashageConfigInterface {
  return {
    input: { basePath: inputDir, format: 'json' },
    targets: {
      aonprd: {
        input:    inputDir,
        pipeline: [
          'json:read',
          'classify:source',
          'classify:winknlp-entities',
          'classify:conflict',
          'fixture:winknlp:squash',
          'rdfjs:finalize',
        ],
        output: { kind: 'file', path: outputPath },
        graphs: {},
        classification: {
          source: true,
          winknlpEntities: {
            patterns: [
              {
                name:      'feat-action-cost',
                patterns:  ['two actions', 'costs two'],
                className: 'feat',
                priority:  28,
              },
            ],
            fields: ['description'],
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

  TaskRegistry.register('fixture:winknlp:squash', squashTask);
}

// ---------------------------------------------------------------------------
// Suite-level temp directory
// ---------------------------------------------------------------------------

let rootDir = '';

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'sq-int-winknlp-'));
  registerFixtureTasks();
});

after(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('WinknlpEntitiesClassifier integration: prose-pattern proposals in full pipeline', () => {
  let inputDir   = '';
  let outDir     = '';
  let outputPath = '';
  let configPath = '';

  before(async () => {
    inputDir   = join(rootDir, 'input');
    outDir     = join(rootDir, 'graphs');
    outputPath = join(rootDir, 'out', 'aonprd.jsonld');
    configPath = join(rootDir, 'squashage.config.json');

    await mkdir(inputDir,             { recursive: true });
    await mkdir(outDir,               { recursive: true });
    await mkdir(join(rootDir, 'out'), { recursive: true });

    // Feat record whose description contains the trigger phrase.
    const featRecord = {
      _type:       'feat',
      name:        'Power Attack',
      level:       1,
      description: 'This feat costs two actions to activate.',
      _source: {
        target: 'aonprd',
        plugin: 'aonprd:parse',
        url:    'https://2e.aonprd.com/Feats.aspx?ID=750',
      },
    };

    await writeFile(join(inputDir, 'feat-power-attack.json'), JSON.stringify(featRecord), 'utf8');

    const cfg = buildConfig(inputDir, outputPath);
    await writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    // Reset captures before the run.
    captured.classifications.length = 0;

    await SquashageOrchestrator.run(cfg, 'aonprd', {
      outDir,
      configPath,
      inputOverride: inputDir,
    });
  });

  it('run processes exactly 1 record', async () => {
    const cfg = buildConfig(inputDir, outputPath);
    const result = await SquashageOrchestrator.run(cfg, 'aonprd', {
      outDir,
      configPath,
      inputOverride: inputDir,
    });
    assert.strictEqual(result.recordCount, 1, 'expected exactly 1 record');
  });

  it('feat record receives a winknlp-entities proposal with className "feat"', () => {
    assert.ok(
      captured.classifications.length > 0,
      'expected at least one record to be captured',
    );

    const proposals = captured.classifications[0]!;
    const winknlpProposals = proposals.filter(p => p.source === 'classify:winknlp-entities');

    assert.ok(
      winknlpProposals.length > 0,
      `Expected at least one winknlp-entities proposal; got sources: ${proposals.map(p => p.source).join(', ')}`,
    );

    const featProposal = winknlpProposals.find(p => p.className === 'feat');
    assert.ok(
      featProposal !== undefined,
      `Expected winknlp-entities proposal with className "feat"; got: ${winknlpProposals.map(p => p.className).join(', ')}`,
    );
  });

  it('feat proposal has priority 28 and carries expected reason strings', () => {
    const proposals = captured.classifications[0]!;
    const featProposal = proposals.find(
      p => p.source === 'classify:winknlp-entities' && p.className === 'feat',
    );
    assert.ok(featProposal !== undefined);
    assert.strictEqual(featProposal.priority, 28);
    assert.ok(
      featProposal.reasons.some(r => r === 'winknlp:pattern=feat-action-cost'),
      `Expected reason "winknlp:pattern=feat-action-cost"; got: ${featProposal.reasons.join(', ')}`,
    );
    assert.ok(
      featProposal.reasons.some(r => r.startsWith('winknlp:matched=')),
      `Expected a "winknlp:matched=..." reason; got: ${featProposal.reasons.join(', ')}`,
    );
    assert.ok(
      featProposal.reasons.some(r => r === 'winknlp:field=description'),
      `Expected reason "winknlp:field=description"; got: ${featProposal.reasons.join(', ')}`,
    );
  });
});
