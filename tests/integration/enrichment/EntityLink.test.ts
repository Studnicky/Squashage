/**
 * @fileoverview Integration test: winkNLP entity-link enrichment (Phase 9).
 *
 * @remarks
 * Runs a full pipeline over a minimal fixture with `enrichment.entityLink`
 * enabled. The fixture has 3 records:
 *
 *   - feat-power-attack: description mentions "Combat Reflexes"
 *   - feat-combat-reflexes: description mentions "Power Attack"
 *   - feat-toughness: description does not mention other feats
 *
 * After the pipeline runs, the dataset should contain exactly 2 `aonprd:mentions`
 * edges (one from Power Attack to Combat Reflexes, one from Combat Reflexes
 * to Power Attack). Toughness emits no edges.
 *
 * Pipeline:
 *   json:read
 *   -> classify:source
 *   -> classify:structural
 *   -> classify:conflict   (single proposer, still needed for unknown handling)
 *   -> aonprd:squash
 *   -> enrich:entity-link
 *   -> rdfjs:finalize
 *
 * @module tests/integration/enrichment/EntityLink
 * @category Integration
 * @since 0.6.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, rm, mkdir, writeFile, readFile,
} from 'node:fs/promises';
import { tmpdir }                from 'node:os';
import { join, dirname }         from 'node:path';
import { fileURLToPath }         from 'node:url';

import { SquashageOrchestrator } from '../../../src/orchestrators/SquashageOrchestrator.js';
import { SquashageConfig }       from '../../../src/config/SquashageConfig.js';
import { Parser }                from '../../../src/rdf/Parser.js';
import { TaskRegistry }          from '../../../src/registry/TaskRegistry.js';
import type { NextFnInterface }  from '../../../src/types/Pipeline.js';
import type { PipelineStateInterface } from '../../../src/types/PipelineState.js';
import type { DataFactory, NamedNode, Quad } from '@rdfjs/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const VOCAB_BASE    = 'https://squashage.dev/vocabulary/aonprd#';
const INSTANCE_BASE = 'https://squashage.dev/instance/aonprd/';
const GRAPH_BASE    = 'https://squashage.dev/graph/aonprd/';
const FEAT_TYPE_IRI = `${VOCAB_BASE}Feat`;
const EDGE_IRI      = `${VOCAB_BASE}mentions`;
const RDF_TYPE_IRI  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_STRING    = 'http://www.w3.org/2001/XMLSchema#string';

const TARGET = 'aonprd';

// ---------------------------------------------------------------------------
// Fixture records
// ---------------------------------------------------------------------------

const POWER_ATTACK_URL         = 'https://2e.aonprd.com/Feats.aspx?ID=750';
const COMBAT_REFLEXES_URL      = 'https://2e.aonprd.com/Feats.aspx?ID=80';
const TOUGHNESS_URL            = 'https://2e.aonprd.com/Feats.aspx?ID=848';

const POWER_ATTACK_RECORD = JSON.stringify({
  _type: 'feat',
  url: POWER_ATTACK_URL,
  name: 'Power Attack',
  level: 1,
  rarity: 'common',
  traits: ['flourish'],
  action_cost: 'two-actions',
  description: 'You unleash a particularly powerful attack. Combine this with Combat Reflexes to guard and strike.',
  _source: { target: 'aonprd', path: 'feat-power-attack.json', url: POWER_ATTACK_URL, plugin: 'aonprd:parse' },
});

const COMBAT_REFLEXES_RECORD = JSON.stringify({
  _type: 'feat',
  url: COMBAT_REFLEXES_URL,
  name: 'Combat Reflexes',
  level: 1,
  rarity: 'common',
  traits: [],
  action_cost: null,
  description: 'You can make additional attacks of opportunity. Works especially well after Power Attack.',
  _source: { target: 'aonprd', path: 'feat-combat-reflexes.json', url: COMBAT_REFLEXES_URL, plugin: 'aonprd:parse' },
});

const TOUGHNESS_RECORD = JSON.stringify({
  _type: 'feat',
  url: TOUGHNESS_URL,
  name: 'Toughness',
  level: 1,
  rarity: 'common',
  traits: [],
  action_cost: null,
  description: 'You can withstand more punishment than most before succumbing.',
  _source: { target: 'aonprd', path: 'feat-toughness.json', url: TOUGHNESS_URL, plugin: 'aonprd:parse' },
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const buildConfig = (inputDir: string, outputPath: string) => ({
  input: {
    basePath: inputDir,
    format: 'json',
  },
  targets: {
    [TARGET]: {
      input: inputDir,
      concurrency: 1,
      pipeline: [
        'json:read',
        'classify:source',
        'classify:structural',
        'classify:conflict',
        'aonprd:squash',
        'enrich:entity-link',
        'rdfjs:finalize',
      ],
      classification: {
        source: true,
        structural: [
          {
            className: 'feat',
            priority: 10,
            predicate: { path: '/_type', equals: 'feat' },
            reasons: ['_type=feat (structural)'],
          },
        ],
        conflict: {
          onConflict: 'quarantine',
          onUnknown: 'quarantine',
          evidence: true,
        },
      },
      enrichment: {
        entityLink: {
          engine: 'winknlp',
          fields: ['description'],
          edgeIri: `${VOCAB_BASE}mentions`,
          linkAgainst: [FEAT_TYPE_IRI],
          minConfidence: 0.85,
        },
      },
      output: {
        kind: 'file',
        path: outputPath,
        mode: 'dataset',
        canonicalize: false,
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

const RDF_TYPE_NODE_IRI = RDF_TYPE_IRI;

function registerFeatPlugin(): void {
  TaskRegistry.register('aonprd:squash', async (
    next: NextFnInterface,
    state: PipelineStateInterface,
  ): Promise<void> => {
    const ctx = state.context;
    const cls = state.classification;

    if (ctx !== undefined && cls !== null && cls.type === 'feat') {
      const { factory, dataset, prefixes } = ctx;
      const vocabBase    = prefixes.vocabulary.base;
      const instanceBase = prefixes.instances.base;
      const graphBase    = prefixes.graphs.base;

      const input = state.input;
      const urlRaw = (() => {
        const src = input['_source'] as Record<string, unknown> | undefined;
        return typeof src?.['url'] === 'string' ? src['url'] : '';
      })();

      let urlTail = '';
      try {
        const parsed = new URL(urlRaw);
        urlTail = (parsed.pathname + parsed.search).replace(/^\//, '');
      } catch {
        urlTail = String(input['name'] ?? 'unknown').toLowerCase().replace(/\s+/g, '-');
      }

      const subject   = factory.namedNode(`${instanceBase}${urlTail}`);
      const typeNode  = factory.namedNode(`${vocabBase}Feat`);
      const graphNode = factory.namedNode(`${graphBase}feat`);
      const predType  = factory.namedNode(RDF_TYPE_NODE_IRI);
      const predName  = factory.namedNode(`${vocabBase}name`);

      dataset.add(factory.quad(subject, predType, typeNode, graphNode));

      if (typeof input['name'] === 'string') {
        dataset.add(factory.quad(
          subject,
          predName,
          factory.literal(input['name'] as string, factory.namedNode('http://www.w3.org/2001/XMLSchema#string')),
          graphNode,
        ));
      }

      // Emit description as a literal predicate so enrich:entity-link can read it.
      const descPred = factory.namedNode(`${vocabBase}description`);
      if (typeof input['description'] === 'string' && (input['description'] as string).length > 0) {
        dataset.add(factory.quad(
          subject,
          descPred,
          factory.literal(input['description'] as string, factory.namedNode('http://www.w3.org/2001/XMLSchema#string')),
          graphNode,
        ));
      }
    }

    await next();
  });
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

before(() => { registerFeatPlugin(); });

let rootDir = '';
before(async () => { rootDir = await mkdtemp(join(tmpdir(), 'sq-int-entitylink-')); });
after(async () => { await rm(rootDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

describe('EntityLink integration — aonprd-style fixture with cross-mentions', () => {
  let outputPath = '';
  let outDir = '';
  let configPath = '';
  let resultQuads: Quad[] = [];

  before(async () => {
    const inputDir = join(rootDir, 'input');
    outDir         = join(rootDir, 'graphs');
    outputPath     = join(rootDir, 'out', 'aonprd.nq');

    await mkdir(inputDir,           { recursive: true });
    await mkdir(outDir,             { recursive: true });
    await mkdir(join(rootDir, 'out'), { recursive: true });

    // Write fixture records.
    await writeFile(join(inputDir, 'feat-power-attack.json'),    POWER_ATTACK_RECORD,    'utf8');
    await writeFile(join(inputDir, 'feat-combat-reflexes.json'), COMBAT_REFLEXES_RECORD, 'utf8');
    await writeFile(join(inputDir, 'feat-toughness.json'),       TOUGHNESS_RECORD,       'utf8');

    // Write config (NQ format for easy line-counting).
    const rawConfig = buildConfig(inputDir, outputPath);
    // Override output format to nquads for parse simplicity.
    (rawConfig.targets[TARGET]!.output as Record<string, unknown>)['format'] = 'nquads';
    (rawConfig.targets[TARGET]!.output as Record<string, unknown>)['path'] = outputPath;
    (rawConfig.targets[TARGET]!.output as Record<string, unknown>)['canonicalize'] = false;

    configPath = join(rootDir, 'squashage.config.json');
    await writeFile(configPath, JSON.stringify(rawConfig, null, 2), 'utf8');

    const config = SquashageConfig.loadFromFile(configPath);
    const result = await SquashageOrchestrator.run(config, TARGET, {
      outDir,
      configPath,
    });

    assert.equal(result.recordCount, 3, `Expected 3 records; got ${result.recordCount.toString()}`);

    // Parse the output NQ file.
    const nqText = await readFile(outputPath, 'utf8');
    const { quads } = await Parser.parse(nqText, { format: 'application/n-quads' });
    resultQuads = quads;
  });

  it('output file is non-empty', () => {
    assert.ok(resultQuads.length > 0, 'Output must contain quads');
  });

  it('dataset contains at least 2 enrich:entity-link edges (ground truth)', () => {
    const edgePred = EDGE_IRI;
    const edges = resultQuads.filter(q => q.predicate.value === edgePred);
    assert.ok(
      edges.length >= 2,
      `Expected at least 2 ${EDGE_IRI} edges; got ${edges.length.toString()}.\nEdges found:\n${edges.map(q => `  ${q.subject.value} -> ${q.object.value}`).join('\n')}`,
    );
  });

  it('Power Attack has a :mentions edge to Combat Reflexes', () => {
    const edgePred      = EDGE_IRI;
    const powerAttackId = `${INSTANCE_BASE}Feats.aspx?ID=750`;
    const combatRefId   = `${INSTANCE_BASE}Feats.aspx?ID=80`;

    const found = resultQuads.some(
      q => q.predicate.value === edgePred
        && q.subject.value   === powerAttackId
        && q.object.value    === combatRefId,
    );

    assert.ok(
      found,
      `Expected Power Attack (${powerAttackId}) to have :mentions edge to Combat Reflexes (${combatRefId})`,
    );
  });

  it('Combat Reflexes has a :mentions edge to Power Attack', () => {
    const edgePred      = EDGE_IRI;
    const powerAttackId = `${INSTANCE_BASE}Feats.aspx?ID=750`;
    const combatRefId   = `${INSTANCE_BASE}Feats.aspx?ID=80`;

    const found = resultQuads.some(
      q => q.predicate.value === edgePred
        && q.subject.value   === combatRefId
        && q.object.value    === powerAttackId,
    );

    assert.ok(
      found,
      `Expected Combat Reflexes (${combatRefId}) to have :mentions edge to Power Attack (${powerAttackId})`,
    );
  });

  it('Toughness (no cross-mentions) emits zero :mentions edges', () => {
    const edgePred    = EDGE_IRI;
    const toughnessId = `${INSTANCE_BASE}Feats.aspx?ID=848`;

    const edges = resultQuads.filter(
      q => q.predicate.value === edgePred && q.subject.value === toughnessId,
    );

    assert.equal(
      edges.length, 0,
      `Toughness should emit 0 :mentions edges; got ${edges.length.toString()}`,
    );
  });

  it('no new IRIs are invented: all edge targets exist as typed instances in dataset', () => {
    const edgePred = EDGE_IRI;
    const typePred = RDF_TYPE_IRI;

    // Collect all typed instance IRIs.
    const typedInstances = new Set(
      resultQuads
        .filter(q => q.predicate.value === typePred && q.subject.termType === 'NamedNode')
        .map(q => q.subject.value),
    );

    // All edge targets must be in the typed instance set.
    const edgeTargets = resultQuads
      .filter(q => q.predicate.value === edgePred)
      .map(q => q.object.value);

    for (const targetIri of edgeTargets) {
      assert.ok(
        typedInstances.has(targetIri),
        `Edge target IRI ${targetIri} is not a typed instance — new IRI was invented`,
      );
    }
  });
});
