/**
 * @fileoverview Unit tests for the streaming write path in rdfjsFinalize.
 *
 * Covers:
 * - Streaming path: when services.recordWriter is set, the node closes the
 *   writer, writes ontology + prov sidecars, and returns 'written'.
 * - Batched path (backward-compat): when services.recordWriter is null,
 *   existing dataset accumulation behavior unchanged.
 * - Empty record set with streaming writer open: stream opens and closes
 *   cleanly; node returns 'written' (stream was open so something was
 *   expected), or 'empty' if nothing was streamed and dataset is empty.
 * - Empty record set with no writer and empty dataset: returns 'empty'.
 *
 * Tests use a real temp directory so that stream open/close mechanics are
 * exercised end-to-end.
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
import { Serializer }         from '../../../../src/rdf/Serializer.js';
import { Parser }             from '../../../../src/rdf/Parser.js';
import type { RecordWriterInterface } from '../../../../src/rdf/Serializer.js';
import type { SquashageServices }     from '../../../../src/services/SquashageServices.js';
import type { OutputConfigInterface } from '../../../../src/config/OutputConfig.js';
import type { RecordSummary }         from '../../../../src/state/schemas/RecordSummary.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TARGET   = 'test-streaming-target';
const EX       = 'http://example.org/';
const PROV_IRI = 'urn:squashage:prov:test-stream-run';

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

function makeOutputConfig(outPath: string): OutputConfigInterface {
  return { kind: 'file', path: outPath } as OutputConfigInterface;
}

function buildDataset(quads: Quad[]): DatasetCore {
  return datasetFactory.dataset(quads);
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

/** A success quad with an explicit named graph. */
function successQuad(): Quad {
  return dataFactory.quad(
    dataFactory.namedNode(`${EX}subject`),
    dataFactory.namedNode(`${EX}predicate`),
    dataFactory.literal('value'),
    dataFactory.namedNode(`${EX}graph`),
  );
}

type TestServices = Pick<
  SquashageServices,
  | 'factory' | 'dataset' | 'output' | 'target' | 'outDir'
  | 'prefixes' | 'logger' | 'recordSummaries' | 'recordWriter' | 'recordWriterReady'
>;

function makeServices(
  dataset:      DatasetCore,
  outPath:      string,
  runDir:       string,
  recordWriter: RecordWriterInterface | null = null,
): TestServices {
  return {
    factory:          dataFactory,
    dataset,
    output:           makeOutputConfig(outPath),
    target:           TARGET,
    outDir:           runDir,
    prefixes:         undefined as unknown as SquashageServices['prefixes'],
    logger:           noopLogger,
    recordSummaries:  [],
    recordWriter,
    recordWriterReady: null,
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
// Suite: streaming path — writer was opened by ontologyProjection
// ---------------------------------------------------------------------------

describe('rdfjsFinalize:streaming:writer-open', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'rdfjs-stream-')); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('closes the open writer and writes prov sidecar; returns written', async () => {
    const outPath = join(tmpDir, 'out.nq');
    const runDir  = join(tmpDir, 'run');

    // Pre-open a writer that has already written some success quads.
    const writer = await Serializer.openStream(outPath, 'nquads');
    await writer.write([successQuad()]);

    // Dataset only holds prov quads (success quads went to stream).
    const dataset  = buildDataset([provQuad()]);
    const services = makeServices(dataset, outPath, runDir, writer);
    // recordSummaries has one squashed record so streaming path short-circuits
    // the 'empty' guard.
    (services.recordSummaries as SquashageServices['recordSummaries']).push({
      outcome: 'squashed', recordPath: 'test.json', recordLine: 0,
    } as unknown as RecordSummary);

    const output = await runNode(makeState(), { services: services as unknown as SquashageServices });

    assert.equal(output, 'written');

    // Prov sidecar must have been written.
    const provPath = join(tmpDir, 'out.prov.nq');
    assert.ok(await exists(provPath), 'prov sidecar must exist');
  });

  it('per-record success quads written pre-close are readable from output file', async () => {
    const outPath = join(tmpDir, 'out2.nq');
    const runDir  = join(tmpDir, 'run2');

    const sq = successQuad();
    const writer = await Serializer.openStream(outPath, 'nquads');
    await writer.write([sq]);

    const dataset  = buildDataset([]);
    const services = makeServices(dataset, outPath, runDir, writer);
    (services.recordSummaries as SquashageServices['recordSummaries']).push({
      outcome: 'squashed', recordPath: 'test.json', recordLine: 0,
    } as unknown as RecordSummary);

    await runNode(makeState(), { services: services as unknown as SquashageServices });

    // The file should exist and contain the quad written before finalize.
    const content   = await readFile(outPath, 'utf8');
    const { quads } = await Parser.parse(content, { format: 'nquads' });
    assert.ok(quads.length >= 1, 'output file must contain at least the pre-written quad');

    const subjectValues = quads.map((q) => q.subject.value);
    assert.ok(subjectValues.includes(sq.subject.value), 'original subject IRI must appear in output');
  });

  it('ontology sidecar is written when ontology quads are in dataset', async () => {
    const outPath = join(tmpDir, 'out3.nq');
    const runDir  = join(tmpDir, 'run3');

    const writer  = await Serializer.openStream(outPath, 'nquads');
    await writer.write([successQuad()]);

    const dataset  = buildDataset([ontologyQuad()]);
    const services = makeServices(dataset, outPath, runDir, writer);
    (services.recordSummaries as SquashageServices['recordSummaries']).push({
      outcome: 'squashed', recordPath: 'test.json', recordLine: 0,
    } as unknown as RecordSummary);

    await runNode(makeState(), { services: services as unknown as SquashageServices });

    const ontologyPath = join(tmpDir, 'out3.ontology.nq');
    assert.ok(await exists(ontologyPath), 'ontology sidecar must exist');
  });
});

// ---------------------------------------------------------------------------
// Suite: streaming path — empty record set
// ---------------------------------------------------------------------------

describe('rdfjsFinalize:streaming:empty-stream', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'rdfjs-stream-empty-')); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('writer opened but nothing written + empty dataset → closes cleanly, returns empty', async () => {
    const outPath = join(tmpDir, 'out.nq');
    const runDir  = join(tmpDir, 'run');

    // Writer was opened (file exists) but no quads were written and no successes.
    const writer  = await Serializer.openStream(outPath, 'nquads');
    const dataset  = buildDataset([]);
    const services = makeServices(dataset, outPath, runDir, writer);
    // recordSummaries is empty — 0 streamed records.

    const output = await runNode(makeState(), { services: services as unknown as SquashageServices });

    // No quads at all → empty
    assert.equal(output, 'empty');
  });
});

// ---------------------------------------------------------------------------
// Suite: batched path (backward-compat) — no writer set
// ---------------------------------------------------------------------------

describe('rdfjsFinalize:streaming:batched-no-writer', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'rdfjs-batched-')); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('without writer, success quads from dataset are written to file', async () => {
    const outPath = join(tmpDir, 'out.nq');
    const runDir  = join(tmpDir, 'run');
    const dataset  = buildDataset([successQuad()]);
    // No recordWriter → batched path.
    const services = makeServices(dataset, outPath, runDir, null);

    const output = await runNode(makeState(), { services: services as unknown as SquashageServices });

    assert.equal(output, 'written');
    assert.ok(await exists(outPath), 'output file must exist in batched path');
  });

  it('without writer and empty dataset, returns empty', async () => {
    const outPath  = join(tmpDir, 'out2.nq');
    const runDir   = join(tmpDir, 'run2');
    const dataset  = buildDataset([]);
    const services = makeServices(dataset, outPath, runDir, null);

    const output = await runNode(makeState(), { services: services as unknown as SquashageServices });

    assert.equal(output, 'empty');
  });
});
