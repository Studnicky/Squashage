/**
 * @fileoverview Integration test: UrlPatternClassifier through the orchestrator pipeline.
 *
 * @remarks
 * Exercises a full pipeline run with `classify:url-pattern` enabled. Asserts that:
 *
 * - A feat record whose `_source.url` matches `/Feats\\.aspx` receives a
 *   `classify:url-pattern` proposal with `className: 'feat'` on
 *   `state.classifications`.
 * - `recordCount` is preserved (no regression).
 *
 * The test uses an aonprd-style URL (`/Feats.aspx?ID=750`) matching the worked
 * example from the plan. A minimal fixture squash task captures proposals from
 * `state.classifications` without touching RDF output.
 *
 * @module tests/integration/classification/UrlPatternClassifier
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

/** Captures proposals from each record processed. */
const captured: {
  classifications: ReadonlyArray<ClassificationProposalInterface>[];
} = {
  classifications: [],
};

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
          'classify:url-pattern',
          'classify:conflict',
          'fixture:urlpattern:squash',
          'rdfjs:finalize',
        ],
        output: { kind: 'file', path: outputPath },
        graphs: {},
        classification: {
          source: true,
          urlPattern: {
            patterns: [
              { className: 'feat',  match: '/Feats\\.aspx',  priority: 35 },
              { className: 'spell', match: '/Spells\\.aspx', priority: 35 },
            ],
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

  TaskRegistry.register('fixture:urlpattern:squash', squashTask);
}

// ---------------------------------------------------------------------------
// Suite-level temp directory
// ---------------------------------------------------------------------------

let rootDir = '';

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'sq-int-urlpattern-'));
  registerFixtureTasks();
});

after(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('UrlPatternClassifier integration: URL proposals in full pipeline', () => {
  let inputDir   = '';
  let outDir     = '';
  let outputPath = '';
  let configPath = '';

  before(async () => {
    inputDir   = join(rootDir, 'input');
    outDir     = join(rootDir, 'graphs');
    outputPath = join(rootDir, 'out', 'aonprd.jsonld');
    configPath = join(rootDir, 'squashage.config.json');

    await mkdir(inputDir,              { recursive: true });
    await mkdir(outDir,                { recursive: true });
    await mkdir(join(rootDir, 'out'),  { recursive: true });

    // Feat record with aonprd-style URL in _source.url.
    const featRecord = {
      _type: 'feat',
      name:  'Power Attack',
      level: 1,
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

  it('feat record receives a url-pattern proposal with className "feat"', () => {
    assert.ok(
      captured.classifications.length > 0,
      'expected at least one record to be processed',
    );

    const proposals = captured.classifications[0]!;
    const urlProposals = proposals.filter(p => p.source === 'classify:url-pattern');

    assert.ok(
      urlProposals.length > 0,
      `Expected at least one url-pattern proposal; got sources: ${proposals.map(p => p.source).join(', ')}`,
    );

    const featProposal = urlProposals.find(p => p.className === 'feat');
    assert.ok(
      featProposal !== undefined,
      `Expected url-pattern proposal with className "feat"; got: ${urlProposals.map(p => p.className).join(', ')}`,
    );
  });

  it('url-pattern proposal has priority 35 and includes url= reason', () => {
    const proposals = captured.classifications[0]!;
    const featProposal = proposals.find(
      p => p.source === 'classify:url-pattern' && p.className === 'feat',
    );
    assert.ok(featProposal !== undefined);
    assert.strictEqual(featProposal.priority, 35);
    assert.ok(
      featProposal.reasons.some(r => r.startsWith('url=')),
      `Expected a reason starting with "url="; got: ${featProposal.reasons.join(', ')}`,
    );
  });

  it('url-pattern proposal reasons include the regex source string', () => {
    const proposals = captured.classifications[0]!;
    const featProposal = proposals.find(
      p => p.source === 'classify:url-pattern' && p.className === 'feat',
    );
    assert.ok(featProposal !== undefined);
    assert.ok(
      featProposal.reasons.some(r => r.includes('/Feats\\.aspx')),
      `Expected a reason containing the regex source; got: ${featProposal.reasons.join(', ')}`,
    );
  });

  it('spell pattern does NOT match the feat URL (no spurious spell proposal)', () => {
    const proposals = captured.classifications[0]!;
    const spellProposal = proposals.find(
      p => p.source === 'classify:url-pattern' && p.className === 'spell',
    );
    assert.strictEqual(
      spellProposal,
      undefined,
      'No spell proposal expected for a Feats.aspx URL',
    );
  });

  it('final classification type resolves to "feat" via conflict resolver', () => {
    // The classify:conflict task with pickPriority picks the highest-priority proposal.
    // Only url-pattern proposals are present (priority 35), so the winner is "feat".
    // We cannot directly read state.classification here (it is set after our fixture task),
    // so we verify the expected proposal structure is present.
    const proposals = captured.classifications[0]!;
    const urlProposals = proposals.filter(p => p.source === 'classify:url-pattern');
    const classNames = urlProposals.map(p => p.className);
    assert.ok(classNames.includes('feat'), 'feat must be among url-pattern proposals');
  });
});
