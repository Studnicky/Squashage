/**
 * @fileoverview Unit tests for the `enrich:entity-link` task.
 *
 * @remarks
 * Tests cover:
 * 1. Record whose description contains "Combat Reflexes" gets a :mentions edge.
 * 2. Description mentioning a non-existent entity produces NO edge (no IRI invention).
 * 3. Case-fold matching: "combat reflexes" matches "Combat Reflexes" in index.
 * 4. Below minConfidence (> 1.0) produces no edge.
 * 5. Empty prose predicate: no edge.
 * 6. Index built ONCE: adding an instance after first execute call is not reflected.
 * 7. Engine other than "winknlp" throws OutputConfigError at construction.
 *
 * @remarks
 * The entity-link task is an end-of-run task. It receives a synthetic state with
 * the run-wide context. All instances and their prose predicates must be in the
 * dataset before the task executes.
 *
 * @module tests/unit/tasks/entityLink
 * @category Unit
 * @since 0.6.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import '../../../src/tasks/entityLink.js'; // side-effect register
import { EntityLinkTask }   from '../../../src/tasks/entityLink.js';
import { OutputConfigError } from '../../../src/errors/OutputConfigError.js';
import { dataFactory }      from '../../../src/rdf/DataFactory.js';
import { Dataset }          from '../../../src/rdf/Dataset.js';
import { GraphBuilder }     from '../../../src/rdf/GraphBuilder.js';
import { Namespaces }       from '../../../src/rdf/Namespaces.js';
import type { PipelineStateInterface, PipelineContextInterface } from '../../../src/types/PipelineState.js';
import type { OutputConfigInterface }  from '../../../src/config/OutputConfig.js';
import type { DatasetCore, NamedNode } from '@rdfjs/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VOCAB_BASE     = 'https://squashage.dev/vocabulary/aonprd#';
const INSTANCE_BASE  = 'https://squashage.dev/instance/aonprd/';
const GRAPH_BASE     = 'https://squashage.dev/graph/aonprd/';
const FEAT_TYPE_IRI  = `${VOCAB_BASE}Feat`;
const EDGE_IRI       = `${VOCAB_BASE}mentions`;
const DESC_PRED_IRI  = `${VOCAB_BASE}description`;

const RDF_TYPE_IRI   = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const NAME_PRED_IRI  = `${VOCAB_BASE}name`;
const XSD_STRING     = 'http://www.w3.org/2001/XMLSchema#string';

const noopNext = async (): Promise<void> => {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const buildPrefixes = () => ({
  instances:  { prefix: 'aonprd',  base: INSTANCE_BASE },
  graphs:     { prefix: 'aonprdg', base: GRAPH_BASE },
  vocabulary: { prefix: 'aonprd',  base: VOCAB_BASE },
  source: 'fallback' as const,
});

const buildOutput = (): OutputConfigInterface => ({
  kind: 'file',
  path: '/tmp/out.jsonld',
} as unknown as OutputConfigInterface);

const buildCtx = (dataset: DatasetCore): PipelineContextInterface => ({
  target:   'aonprd',
  outDir:   '/tmp',
  config:   {},
  factory:  dataFactory,
  dataset,
  builder:  new GraphBuilder(VOCAB_BASE),
  graphs:   {},
  iri:      Namespaces.for(VOCAB_BASE),
  output:   buildOutput(),
  prefixes: buildPrefixes(),
});

/**
 * Builds the synthetic end-of-run state carrying the run-wide context.
 * Mirrors what SquashageOrchestrator passes to end-of-run tasks.
 */
const buildEndOfRunState = (ctx: PipelineContextInterface): PipelineStateInterface => ({
  targetId:        'aonprd',
  source:          { target: 'aonprd', path: '__end-of-run__' },
  input:           {},
  classification:  null,
  classifications: [],
  output:          null,
  context:         ctx,
});

/**
 * Adds a typed instance with a name label and description to the dataset.
 * This mirrors what the squash plugin emits (rdf:type + name literal + desc).
 */
const addInstance = (
  dataset:     DatasetCore,
  instanceId:  string,
  typeIri:     string,
  name:        string,
  description: string,
  graphIri:    string,
): NamedNode => {
  const subject      = dataFactory.namedNode(instanceId);
  const typeNode     = dataFactory.namedNode(typeIri);
  const graphNode    = dataFactory.namedNode(graphIri);
  const predType     = dataFactory.namedNode(RDF_TYPE_IRI);
  const predName     = dataFactory.namedNode(NAME_PRED_IRI);
  const predDesc     = dataFactory.namedNode(DESC_PRED_IRI);
  const xsdStringNode = dataFactory.namedNode(XSD_STRING);

  dataset.add(dataFactory.quad(subject, predType, typeNode, graphNode));
  dataset.add(dataFactory.quad(subject, predName, dataFactory.literal(name, xsdStringNode), graphNode));
  if (description.length > 0) {
    dataset.add(dataFactory.quad(subject, predDesc, dataFactory.literal(description, xsdStringNode), graphNode));
  }
  return subject;
};

/**
 * Counts quads in the dataset matching the edge predicate.
 */
const countEdges = (dataset: DatasetCore, edgeIri: string): number => {
  const predNode = dataFactory.namedNode(edgeIri);
  let count = 0;
  for (const quad of dataset.match(null, predNode, null, null)) {
    void quad;
    count++;
  }
  return count;
};

// ---------------------------------------------------------------------------
// Test 1: Matching entity in description gets an edge
// ---------------------------------------------------------------------------

describe('entityLink: record with "Combat Reflexes" in description gets :mentions edge', () => {
  it('emits one edge to the Combat Reflexes instance IRI', async () => {
    const dataset = Dataset.empty();

    const combatReflexesIri = `${INSTANCE_BASE}Feats.aspx?ID=80`;
    const powerAttackIri    = `${INSTANCE_BASE}Feats.aspx?ID=750`;

    addInstance(
      dataset,
      powerAttackIri,
      FEAT_TYPE_IRI,
      'Power Attack',
      'You can use Combat Reflexes to make additional attacks of opportunity.',
      `${GRAPH_BASE}feat`,
    );
    addInstance(
      dataset,
      combatReflexesIri,
      FEAT_TYPE_IRI,
      'Combat Reflexes',
      'You can make additional attacks of opportunity.',
      `${GRAPH_BASE}feat`,
    );

    const ctx = buildCtx(dataset);
    const state = buildEndOfRunState(ctx);

    const task = EntityLinkTask.create({
      engine:        'winknlp',
      fields:        ['description'],
      edgeIri:       EDGE_IRI,
      linkAgainst:   [FEAT_TYPE_IRI],
      minConfidence: 0.85,
    });

    await task.execute(noopNext, state);

    const edgeCount = countEdges(dataset, EDGE_IRI);
    assert.ok(edgeCount >= 1, `Expected at least 1 :mentions edge; got ${edgeCount.toString()}`);

    const edgePred   = dataFactory.namedNode(EDGE_IRI);
    const fromNode   = dataFactory.namedNode(powerAttackIri);
    const targetNode = dataFactory.namedNode(combatReflexesIri);
    let found = false;
    for (const q of dataset.match(fromNode, edgePred, targetNode, null)) {
      void q;
      found = true;
    }
    assert.ok(found, 'Edge should point from Power Attack to the Combat Reflexes instance IRI');
  });
});

// ---------------------------------------------------------------------------
// Test 2: Non-existent entity produces no edge (no IRI invention)
// ---------------------------------------------------------------------------

describe('entityLink: description mentioning a non-existent entity produces no edge', () => {
  it('emits zero edges when entity is not in the index', async () => {
    const dataset = Dataset.empty();

    // Index contains only "Power Attack". "Dragon Claws" is NOT in the index.
    const powerAttackIri = `${INSTANCE_BASE}Feats.aspx?ID=750`;
    addInstance(
      dataset,
      powerAttackIri,
      FEAT_TYPE_IRI,
      'Power Attack',
      'You can use Dragon Claws to slash your enemies.',
      `${GRAPH_BASE}feat`,
    );

    const ctx   = buildCtx(dataset);
    const state = buildEndOfRunState(ctx);

    const task = EntityLinkTask.create({
      engine:        'winknlp',
      fields:        ['description'],
      edgeIri:       EDGE_IRI,
      linkAgainst:   [FEAT_TYPE_IRI],
      minConfidence: 0.85,
    });

    await task.execute(noopNext, state);

    const edgeCount = countEdges(dataset, EDGE_IRI);
    assert.equal(edgeCount, 0, 'No edge should be emitted for a non-existent entity');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Case-fold matching
// ---------------------------------------------------------------------------

describe('entityLink: case-fold matching — "combat reflexes" matches "Combat Reflexes"', () => {
  it('finds the entity regardless of case in the prose text', async () => {
    const dataset = Dataset.empty();

    const combatReflexesIri = `${INSTANCE_BASE}Feats.aspx?ID=80`;
    const powerAttackIri    = `${INSTANCE_BASE}Feats.aspx?ID=750`;

    // Power Attack describes "combat reflexes" in all-lowercase.
    addInstance(
      dataset,
      powerAttackIri,
      FEAT_TYPE_IRI,
      'Power Attack',
      'This feat pairs well with combat reflexes for controlling the battlefield.',
      `${GRAPH_BASE}feat`,
    );
    addInstance(
      dataset,
      combatReflexesIri,
      FEAT_TYPE_IRI,
      'Combat Reflexes',
      'You can make additional attacks of opportunity.',
      `${GRAPH_BASE}feat`,
    );

    const ctx   = buildCtx(dataset);
    const state = buildEndOfRunState(ctx);

    const task = EntityLinkTask.create({
      engine:        'winknlp',
      fields:        ['description'],
      edgeIri:       EDGE_IRI,
      linkAgainst:   [FEAT_TYPE_IRI],
      minConfidence: 0.85,
    });

    await task.execute(noopNext, state);

    const edgePred   = dataFactory.namedNode(EDGE_IRI);
    const fromNode   = dataFactory.namedNode(powerAttackIri);
    const targetNode = dataFactory.namedNode(combatReflexesIri);
    let found = false;
    for (const q of dataset.match(fromNode, edgePred, targetNode, null)) {
      void q;
      found = true;
    }
    assert.ok(found, 'Case-folded match should produce an edge to Combat Reflexes');
  });
});

// ---------------------------------------------------------------------------
// Test 4: Below minConfidence — no edge
// ---------------------------------------------------------------------------

describe('entityLink: minConfidence > 1.0 (impossible) produces no edges', () => {
  it('emits no edge when minConfidence cannot be satisfied', async () => {
    const dataset = Dataset.empty();

    addInstance(
      dataset,
      `${INSTANCE_BASE}Feats.aspx?ID=80`,
      FEAT_TYPE_IRI,
      'Combat Reflexes',
      'Standard description.',
      `${GRAPH_BASE}feat`,
    );
    addInstance(
      dataset,
      `${INSTANCE_BASE}Feats.aspx?ID=750`,
      FEAT_TYPE_IRI,
      'Power Attack',
      'This pairs well with Combat Reflexes.',
      `${GRAPH_BASE}feat`,
    );

    const ctx   = buildCtx(dataset);
    const state = buildEndOfRunState(ctx);

    // minConfidence > 1.0 is impossible for the binary winkNLP match (confidence=1.0).
    const task = EntityLinkTask.create({
      engine:        'winknlp',
      fields:        ['description'],
      edgeIri:       EDGE_IRI,
      linkAgainst:   [FEAT_TYPE_IRI],
      minConfidence: 1.01, // impossible
    });

    await task.execute(noopNext, state);

    const edgeCount = countEdges(dataset, EDGE_IRI);
    assert.equal(edgeCount, 0, 'No edge should be emitted when minConfidence > 1.0');
  });
});

// ---------------------------------------------------------------------------
// Test 5: Empty prose predicate — no edge
// ---------------------------------------------------------------------------

describe('entityLink: empty prose predicate produces no edge', () => {
  it('emits zero edges when the description literal is empty', async () => {
    const dataset = Dataset.empty();

    // Add two instances but Power Attack has an empty description.
    addInstance(
      dataset,
      `${INSTANCE_BASE}Feats.aspx?ID=80`,
      FEAT_TYPE_IRI,
      'Combat Reflexes',
      'Standard description.',
      `${GRAPH_BASE}feat`,
    );
    addInstance(
      dataset,
      `${INSTANCE_BASE}Feats.aspx?ID=750`,
      FEAT_TYPE_IRI,
      'Power Attack',
      '', // empty description
      `${GRAPH_BASE}feat`,
    );

    const ctx   = buildCtx(dataset);
    const state = buildEndOfRunState(ctx);

    const task = EntityLinkTask.create({
      engine:      'winknlp',
      fields:      ['description'],
      edgeIri:     EDGE_IRI,
      linkAgainst: [FEAT_TYPE_IRI],
    });

    await task.execute(noopNext, state);

    const edgePred = dataFactory.namedNode(EDGE_IRI);
    const fromNode = dataFactory.namedNode(`${INSTANCE_BASE}Feats.aspx?ID=750`);
    let edgeCount = 0;
    for (const q of dataset.match(fromNode, edgePred, null, null)) {
      void q;
      edgeCount++;
    }
    assert.equal(edgeCount, 0, 'No edges expected from Power Attack with empty description');
  });
});

// ---------------------------------------------------------------------------
// Test 6: Index built ONCE and reused across multiple execute calls
// ---------------------------------------------------------------------------

describe('entityLink: index is built once and reused (frozen after first execute)', () => {
  it('instances added after the first execute call are not in the index', async () => {
    const dataset = Dataset.empty();

    addInstance(
      dataset,
      `${INSTANCE_BASE}Feats.aspx?ID=80`,
      FEAT_TYPE_IRI,
      'Combat Reflexes',
      'You can make additional attacks of opportunity.',
      `${GRAPH_BASE}feat`,
    );
    addInstance(
      dataset,
      `${INSTANCE_BASE}Feats.aspx?ID=750`,
      FEAT_TYPE_IRI,
      'Power Attack',
      'Use this with Combat Reflexes for more opportunities.',
      `${GRAPH_BASE}feat`,
    );

    const ctx   = buildCtx(dataset);
    const task  = EntityLinkTask.create({
      engine:      'winknlp',
      fields:      ['description'],
      edgeIri:     EDGE_IRI,
      linkAgainst: [FEAT_TYPE_IRI],
    });

    // First execute call: index built now.
    await task.execute(noopNext, buildEndOfRunState(ctx));
    const edgesAfterFirst = countEdges(dataset, EDGE_IRI);
    assert.ok(edgesAfterFirst >= 1, 'First execute should emit at least 1 edge');

    // Add a new instance AFTER the first execute (index already frozen).
    const newFeatIri = `${INSTANCE_BASE}Feats.aspx?ID=999`;
    addInstance(
      dataset,
      newFeatIri,
      FEAT_TYPE_IRI,
      'Sudden Charge',
      'Sudden Charge lets you dash and strike.',
      `${GRAPH_BASE}feat`,
    );

    // Second execute call: index was already built and frozen.
    await task.execute(noopNext, buildEndOfRunState(ctx));

    // Sudden Charge should NOT appear as an edge target (not in frozen index).
    const edgePred         = dataFactory.namedNode(EDGE_IRI);
    const suddenChargeNode = dataFactory.namedNode(newFeatIri);
    let foundSuddenCharge  = false;
    for (const q of dataset.match(null, edgePred, suddenChargeNode, null)) {
      void q;
      foundSuddenCharge = true;
    }
    assert.equal(
      foundSuddenCharge, false,
      'Sudden Charge added after index build must not be reachable as an edge target',
    );
  });
});

// ---------------------------------------------------------------------------
// Test 7: Invalid engine throws OutputConfigError at construction
// ---------------------------------------------------------------------------

describe('entityLink: unsupported engine throws OutputConfigError at construction', () => {
  it('throws OutputConfigError when engine is not "winknlp"', () => {
    assert.throws(
      () => EntityLinkTask.create({
        engine:      'naive' as 'winknlp', // force wrong value for test
        fields:      ['description'],
        edgeIri:     EDGE_IRI,
        linkAgainst: [FEAT_TYPE_IRI],
      }),
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError, 'Expected OutputConfigError');
        assert.ok(
          (err as OutputConfigError).message.includes('winknlp'),
          `Error message should mention "winknlp"; got: ${(err as OutputConfigError).message}`,
        );
        return true;
      },
    );
  });
});
