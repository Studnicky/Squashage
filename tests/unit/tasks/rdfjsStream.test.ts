/**
 * @fileoverview Unit tests for the rdfjs:stream built-in task.
 *
 * @category Tasks
 * @since 0.7.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../../../src/tasks/rdfjsStream.js';
import { TaskRegistry }    from '../../../src/registry/TaskRegistry.js';
import { StreamWriter, buildDatasetProxy } from '../../../src/tasks/rdfjsStream.js';
import { dataFactory }     from '../../../src/rdf/DataFactory.js';
import { Dataset }         from '../../../src/rdf/Dataset.js';
import { GraphBuilder }    from '../../../src/rdf/GraphBuilder.js';
import { Namespaces }      from '../../../src/rdf/Namespaces.js';
import type { PipelineStateInterface, PipelineContextInterface } from '../../../src/types/PipelineState.js';
import type { OutputConfigInterface } from '../../../src/config/OutputConfig.js';
import type { Quad } from '@rdfjs/types';

const streamTask = TaskRegistry.get('rdfjs:stream');

let workDir: string;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'squashage-rdfjsStream-'));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const noopNext = async (): Promise<void> => {};

const makeQuad = (s: string, p: string, o: string, g?: string): Quad =>
  dataFactory.quad(
    dataFactory.namedNode(s),
    dataFactory.namedNode(p),
    dataFactory.namedNode(o),
    g !== undefined ? dataFactory.namedNode(g) : dataFactory.defaultGraph(),
  );

const buildCtx = (
  outDir: string,
  target: string,
  output: OutputConfigInterface,
): PipelineContextInterface => ({
  target,
  outDir,
  config:  {},
  factory: dataFactory,
  dataset: Dataset.empty(),
  builder: new GraphBuilder('https://example.org/'),
  graphs:  {},
  iri:     Namespaces.for('https://example.org/'),
  output,
  prefixes: {
    instances:  { prefix: 'ex', base: 'https://example.org/' },
    graphs:     { prefix: 'g',  base: 'https://graphs.example.org/' },
    vocabulary: { prefix: 'v',  base: 'https://vocab.example.org/' },
    source:     'fallback',
  },
});

const buildStreamingState = (
  outDir:  string,
  target:  string,
  output:  OutputConfigInterface,
  writer?: StreamWriter,
): PipelineStateInterface => {
  const ctx = buildCtx(outDir, target, output);
  if (writer !== undefined) {
    (ctx as unknown as Record<string, unknown>)['__streamWriter'] = writer;
  }
  return {
    targetId:        target,
    source:          { target, path: 'test' },
    input:           {},
    classification:  null,
    classifications: [],
    output:          null,
    context:         ctx,
  };
};

describe('rdfjs:stream', () => {
  it('streaming writer emits one line per quad in arrival order (ntriples)', async () => {
    const dir     = join(workDir, 'emit-order');
    const outPath = join(dir, 'out.nt');
    const writer  = new StreamWriter(outPath, 'ntriples');
    await writer.open();

    const q1 = makeQuad('http://s1', 'http://p', 'http://o1');
    const q2 = makeQuad('http://s2', 'http://p', 'http://o2');
    await writer.writeQuad(q1);
    await writer.writeQuad(q2);
    const report = await writer.close();

    const text  = await readFile(outPath, 'utf8');
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0]!.includes('<http://s1>'));
    assert.ok(lines[1]!.includes('<http://s2>'));
    assert.equal(report.quadCount, 2);
    assert.ok(report.bytesWritten > 0);
  });

  it('header is empty for ntriples format', () => {
    const header = StreamWriter.buildHeader('ntriples', { ex: 'http://example.org/' });
    assert.equal(header, '');
  });

  it('header emits @prefix lines for turtle format', () => {
    const prefixes = { ex: 'http://example.org/', owl: 'http://www.w3.org/2002/07/owl#' };
    const header   = StreamWriter.buildHeader('turtle', prefixes);
    assert.ok(header.includes('@prefix ex: <http://example.org/> .'));
    assert.ok(header.includes('@prefix owl: <http://www.w3.org/2002/07/owl#> .'));
    assert.ok(header.endsWith('\n\n'));
  });

  it('closes cleanly -- file is flushed and fd released', async () => {
    const dir     = join(workDir, 'close-clean');
    const outPath = join(dir, 'out.nq');
    const writer  = new StreamWriter(outPath, 'nquads');
    await writer.open();
    await writer.writeQuad(makeQuad('http://s', 'http://p', 'http://o', 'http://g'));
    const report = await writer.close();

    await access(outPath);
    assert.equal(report.format, 'nquads');
    assert.equal(report.quadCount, 1);
    assert.ok(report.durationMs >= 0);
  });

  it('streaming + canonicalize => OutputConfigError at task invocation', async () => {
    const dir     = join(workDir, 'stream-canon');
    const outPath = join(dir, 'out.nt');
    const output  = {
      kind:         'file',
      path:         outPath,
      format:       'ntriples',
      encoding:     'stream',
      canonicalize: true,
    } as unknown as OutputConfigInterface;

    const state = buildStreamingState(dir, 'canon-target', output);
    await assert.rejects(
      () => streamTask(noopNext, state),
      (err: Error) => err.message.includes('canonicalization'),
    );
  });

  it('streaming + jsonld => OutputConfigError at task invocation', async () => {
    const dir     = join(workDir, 'stream-jsonld');
    const outPath = join(dir, 'out.jsonld');
    const output  = {
      kind:     'file',
      path:     outPath,
      format:   'jsonld',
      encoding: 'stream',
    } as unknown as OutputConfigInterface;

    const state = buildStreamingState(dir, 'jsonld-target', output);
    await assert.rejects(
      () => streamTask(noopNext, state),
      (err: Error) => err.message.includes('JSON-LD'),
    );
  });

  it('dropInMemory:true empties the in-memory dataset -- size stays bounded', async () => {
    const dir     = join(workDir, 'drop-mem');
    const outPath = join(dir, 'out.nt');
    const writer  = new StreamWriter(outPath, 'ntriples');
    await writer.open();

    const inner = Dataset.empty();
    const proxy = buildDatasetProxy(inner, writer, true);

    for (let i = 0; i < 5; i++) {
      proxy.add(makeQuad(`http://s${i}`, 'http://p', 'http://o'));
    }

    await new Promise<void>(r => setTimeout(r, 50));

    assert.equal(inner.size, 0, 'inner dataset must stay empty with dropInMemory=true');
    assert.equal(writer.quadCount, 5, 'writer must have counted all 5 quads');

    await writer.close();
  });
});
