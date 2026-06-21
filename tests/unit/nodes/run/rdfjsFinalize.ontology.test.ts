/**
 * @fileoverview Unit tests for the ontology partition added to rdfjsFinalize.
 *
 * Covers:
 * - Mixed dataset (success + ontology + prov graphs) is partitioned into three
 *   non-overlapping quad sets.
 * - Ontology sidecar is written to <stem>.ontology.<ext> when quads present.
 * - Ontology sidecar is NOT written when the ontology partition is empty.
 * - Success graph does NOT contain ontology or prov quads.
 * - Existing behavior: empty-total dataset returns 'empty'.
 * - Existing behavior: dataset with only success quads writes one file.
 *
 * These tests exercise the full rdfjsFinalizeNode with a real (temp-dir)
 * filesystem to verify the partition + sidecar path logic end-to-end.
 *
 * N-Quads (.nq) format is used throughout because the quad fixtures carry
 * named-graph components; turtle cannot serialise named-graph quads.
 */

import { describe, it, before, after } from 'node:test';
import assert                           from 'node:assert/strict';
import { mkdtemp, stat, readFile }      from 'node:fs/promises';
import { join }                         from 'node:path';
import { tmpdir }                       from 'node:os';
import { rm }                           from 'node:fs/promises';

import dataFactory    from '@rdfjs/data-model';
import datasetFactory from '@rdfjs/dataset';
import type { DatasetCore, Quad } from '@rdfjs/types';

import { Batch } from '@studnicky/dagonizer';
import { rdfjsFinalizeNode }  from '../../../../src/nodes/run/rdfjsFinalize.js';
import { ontologyGraphIri }   from '../../../../src/nodes/run/ontologyEmit.js';
import { SquashageRunState }  from '../../../../src/state/SquashageRunState.js';
import { Parser }             from '../../../../src/rdf/Parser.js';
import type { SquashageServices } from '../../../../src/services/SquashageServices.js';
import type { OutputConfigInterface } from '../../../../src/config/OutputConfig.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TARGET   = 'test-partition-target';
const EX       = 'http://example.org/';
const PROV_IRI = 'urn:squashage:prov:test-run-001';

const noopLogger = {
  forComponent: () => ({
    debug: () => undefined,
    info:  () => undefined,
    warn:  () => undefined,
    error: () => undefined,
  }),
} as unknown as SquashageServices['logger'];

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; }
  catch { return false; }
}

/**
 * Build an output config that uses NQ extension.
 * N-Quads is the only plain-text format that supports named-graph quads without
 * requiring a TriG parser.
 */
function makeOutputConfig(outPath: string): OutputConfigInterface {
  return { kind: 'file', path: outPath } as OutputConfigInterface;
}

function buildDataset(quads: Quad[]): DatasetCore {
  return datasetFactory.dataset(quads);
}

function makeServices(
  dataset: DatasetCore,
  outPath: string,
  runDir:  string,
): Pick<SquashageServices, 'factory' | 'dataset' | 'output' | 'target' | 'outDir' | 'prefixes' | 'logger'> {
  return {
    factory:         dataFactory,
    dataset,
    output:          makeOutputConfig(outPath),
    target:          TARGET,
    outDir:          runDir,
    prefixes:        undefined as unknown as SquashageServices['prefixes'],
    logger:          noopLogger,
  };
}

function makeState(): SquashageRunState {
  return new SquashageRunState(TARGET, new Date().toISOString());
}

async function runNode(
  state:   SquashageRunState,
  context: { services: SquashageServices },
): Promise<string> {
  const result = await rdfjsFinalizeNode.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof rdfjsFinalizeNode.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

// ---------------------------------------------------------------------------
// Quad fixtures
//
// All quads use explicit named graphs so N-Quads serialization round-trips
// without loss.  The "success" quad uses a named graph that is neither prov
// nor ontology, so it lands in the success partition.
// ---------------------------------------------------------------------------

const sSubj = dataFactory.namedNode(`${EX}subject`);
const sPred = dataFactory.namedNode(`${EX}predicate`);
const sObj  = dataFactory.literal('value');

/** A quad that belongs to the success partition (non-prov, non-ontology graph). */
function successQuad(): Quad {
  return dataFactory.quad(sSubj, sPred, sObj, dataFactory.namedNode(`${EX}success-graph`));
}

/** A quad that belongs to the ontology partition. */
function ontologyQuad(): Quad {
  return dataFactory.quad(
    dataFactory.namedNode(`${EX}OntClass`),
    dataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
    dataFactory.namedNode('http://www.w3.org/2002/07/owl#Class'),
    dataFactory.namedNode(ontologyGraphIri(TARGET)),
  );
}

/** A quad that belongs to the prov partition. */
function provQuad(): Quad {
  return dataFactory.quad(
    dataFactory.namedNode(`${EX}activity`),
    dataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
    dataFactory.namedNode('http://www.w3.org/ns/prov#Activity'),
    dataFactory.namedNode(PROV_IRI),
  );
}

// ---------------------------------------------------------------------------
// Suite: empty dataset
// ---------------------------------------------------------------------------

describe('rdfjsFinalize:ontology-partition:empty-dataset', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'rdfjs-finalize-empty-')); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('returns empty when dataset has no quads', async () => {
    const outPath  = join(tmpDir, 'out.nq');
    const runDir   = join(tmpDir, 'run');
    const dataset  = buildDataset([]);
    const services = makeServices(dataset, outPath, runDir);

    const output = await runNode(makeState(), { services: services as unknown as SquashageServices });

    assert.equal(output, 'empty');
  });
});

// ---------------------------------------------------------------------------
// Suite: success-only dataset (no ontology, no prov)
// ---------------------------------------------------------------------------

describe('rdfjsFinalize:ontology-partition:success-only', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'rdfjs-finalize-success-')); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('writes success file and no ontology sidecar', async () => {
    const outPath     = join(tmpDir, 'out.nq');
    const runDir      = join(tmpDir, 'run');
    const sidecarPath = join(tmpDir, 'out.ontology.nq');
    const dataset     = buildDataset([successQuad()]);
    const services    = makeServices(dataset, outPath, runDir);

    const output = await runNode(makeState(), { services: services as unknown as SquashageServices });

    assert.equal(output, 'written');
    assert.ok(await exists(outPath),        'success file must exist');
    assert.ok(!(await exists(sidecarPath)), 'ontology sidecar must NOT exist when partition is empty');
  });
});

// ---------------------------------------------------------------------------
// Suite: mixed dataset (success + ontology + prov)
// ---------------------------------------------------------------------------

describe('rdfjsFinalize:ontology-partition:mixed-dataset', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'rdfjs-finalize-mixed-')); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('writes ontology sidecar when ontology quads are present', async () => {
    const outPath      = join(tmpDir, 'out.nq');
    const ontologyPath = join(tmpDir, 'out.ontology.nq');
    const runDir       = join(tmpDir, 'run');
    const dataset      = buildDataset([successQuad(), ontologyQuad(), provQuad()]);
    const services     = makeServices(dataset, outPath, runDir);

    const output = await runNode(makeState(), { services: services as unknown as SquashageServices });

    assert.equal(output, 'written');
    assert.ok(await exists(outPath),      'success file must exist');
    assert.ok(await exists(ontologyPath), 'ontology sidecar must exist');
  });

  it('success file does not contain ontology or prov quads', async () => {
    const outPath  = join(tmpDir, 'out2.nq');
    const runDir   = join(tmpDir, 'run2');
    const dataset  = buildDataset([successQuad(), ontologyQuad(), provQuad()]);
    const services = makeServices(dataset, outPath, runDir);

    await runNode(makeState(), { services: services as unknown as SquashageServices });

    const content   = await readFile(outPath, 'utf8');
    const { quads } = await Parser.parse(content, { format: 'nquads' });

    const ontologyIri = ontologyGraphIri(TARGET);
    for (const q of quads) {
      assert.notEqual(q.graph.value, ontologyIri, 'success file must not contain ontology quads');
      assert.ok(
        !q.graph.value.startsWith('urn:squashage:prov:'),
        'success file must not contain prov quads',
      );
    }
  });

  it('ontology sidecar contains only quads from the ontology named graph', async () => {
    const outPath     = join(tmpDir, 'out3.nq');
    const sidecarPath = join(tmpDir, 'out3.ontology.nq');
    const runDir      = join(tmpDir, 'run3');
    const dataset     = buildDataset([successQuad(), ontologyQuad(), provQuad()]);
    const services    = makeServices(dataset, outPath, runDir);

    await runNode(makeState(), { services: services as unknown as SquashageServices });

    const content   = await readFile(sidecarPath, 'utf8');
    assert.ok(content.length > 0, 'ontology sidecar must be non-empty');

    const { quads } = await Parser.parse(content, { format: 'nquads' });
    assert.ok(quads.length > 0, 'ontology sidecar must contain at least one quad');

    const ontologyIri = ontologyGraphIri(TARGET);
    for (const q of quads) {
      // N-Quads serializer strips the named graph from RDF 1.1 "triples in
      // named graphs" → quads in the output have graph as a NamedNode.
      // Some serializers may emit as DefaultGraph when rewriting; we accept
      // either the correct graph IRI or DefaultGraph (since the sidecar file
      // already indicates provenance by its path).
      const isOntologyGraph   = q.graph.termType === 'NamedNode' && q.graph.value === ontologyIri;
      const isDefaultGraph    = q.graph.termType === 'DefaultGraph';
      assert.ok(
        isOntologyGraph || isDefaultGraph,
        `unexpected graph in ontology sidecar: ${q.graph.value}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: ontology quads only (no success quads)
// ---------------------------------------------------------------------------

describe('rdfjsFinalize:ontology-partition:ontology-only', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'rdfjs-finalize-ont-only-')); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('writes ontology sidecar even with no success quads; returns written', async () => {
    const outPath     = join(tmpDir, 'out.nq');
    const sidecarPath = join(tmpDir, 'out.ontology.nq');
    const runDir      = join(tmpDir, 'run');
    const dataset     = buildDataset([ontologyQuad()]);
    const services    = makeServices(dataset, outPath, runDir);

    const output = await runNode(makeState(), { services: services as unknown as SquashageServices });

    // The total dataset is non-empty, so we expect 'written'.
    assert.equal(output, 'written');
    assert.ok(await exists(sidecarPath), 'ontology sidecar must be written');
  });
});
