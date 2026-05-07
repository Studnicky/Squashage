/**
 * @fileoverview Unit tests for the `rdfjs:finalize` built-in task.
 *
 * @remarks
 * Covers the orchestrator-driven finalize lifecycle: empty dataset, default-graph
 * round-trip via Parser, named-graph + nquads, named-graph + turtle without
 * `output.graph` (must throw), named-graph + turtle with `output.graph` collapse,
 * SHACL validation pass + fail paths, and `output.report.json` persistence.
 *
 * @category Tasks
 * @since 2.1.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../../../src/tasks/rdfjsFinalize.js'; // side-effect register
import { TaskRegistry } from '../../../src/registry/TaskRegistry.js';
import { dataFactory } from '../../../src/rdf/DataFactory.js';
import { Dataset } from '../../../src/rdf/Dataset.js';
import { GraphBuilder } from '../../../src/rdf/GraphBuilder.js';
import { Namespaces } from '../../../src/rdf/Namespaces.js';
import { Parser } from '../../../src/rdf/Parser.js';
import { OutputConfigError } from '../../../src/errors/OutputConfigError.js';
import { FileOutputError } from '../../../src/errors/FileOutputError.js';
import type { PipelineStateInterface, PipelineContextInterface } from '../../../src/types/PipelineState.js';
import type { OutputConfigInterface } from '../../../src/config/OutputConfig.js';
import type { Quad } from '@rdfjs/types';

const finalizeTask = TaskRegistry.get('rdfjs:finalize');

let workDir: string;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'squashage-rdfjsFinalize-'));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const buildState = (
  outDir:  string,
  target:  string,
  output:  OutputConfigInterface,
  quads:   ReadonlyArray<Quad>,
): PipelineStateInterface => {
  const ctx: PipelineContextInterface = {
    target,
    outDir,
    config:  {},
    factory: dataFactory,
    dataset: Dataset.from([...quads]),
    builder: new GraphBuilder('https://example.org/'),
    graphs:  {},
    iri:     Namespaces.for('https://example.org/'),
    output,
  };
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

const noopNext = async (): Promise<void> => {};

describe('rdfjs:finalize', () => {
  it('writes an empty file when the dataset has no quads', async () => {
    const dir = join(workDir, 'empty');
    const outPath = join(dir, 'out.ttl');
    const state = buildState(dir, 'empty-target', { kind: 'file', path: outPath }, []);
    await finalizeTask(noopNext, state);

    await access(outPath); // exists
    const text = await readFile(outPath, 'utf8');
    assert.equal(text.trim(), '');
    const reportText = await readFile(join(dir, 'empty-target', 'output.report.json'), 'utf8');
    const report = JSON.parse(reportText) as { quadCount: number; format: string };
    assert.equal(report.quadCount, 0);
    assert.equal(report.format, 'turtle');
  });

  it('round-trips a default-graph turtle write via Parser', async () => {
    const dir = join(workDir, 'turtle-rt');
    const outPath = join(dir, 'out.ttl');
    const q = dataFactory.quad(
      dataFactory.namedNode('http://example.org/s'),
      dataFactory.namedNode('http://example.org/p'),
      dataFactory.literal('o'),
    );
    const state = buildState(dir, 'rt-target', { kind: 'file', path: outPath }, [q]);
    await finalizeTask(noopNext, state);

    const text = await readFile(outPath, 'utf8');
    const { quads } = await Parser.parse(text, { format: 'turtle' });
    assert.equal(quads.length, 1);
    assert.equal(quads[0]?.subject.value, 'http://example.org/s');
  });

  it('preserves named graphs when format is nquads', async () => {
    const dir = join(workDir, 'nquads');
    const outPath = join(dir, 'out.nq');
    const q = dataFactory.quad(
      dataFactory.namedNode('http://example.org/s'),
      dataFactory.namedNode('http://example.org/p'),
      dataFactory.literal('o'),
      dataFactory.namedNode('http://example.org/g'),
    );
    const state = buildState(dir, 'nq-target', { kind: 'file', path: outPath }, [q]);
    await finalizeTask(noopNext, state);

    const text = await readFile(outPath, 'utf8');
    const { quads } = await Parser.parse(text, { format: 'nquads' });
    assert.equal(quads.length, 1);
    assert.equal(quads[0]?.graph.value, 'http://example.org/g');
  });

  it('throws OutputConfigError when named-graph quads target turtle without output.graph', async () => {
    const dir = join(workDir, 'graphfail');
    const outPath = join(dir, 'out.ttl');
    const q = dataFactory.quad(
      dataFactory.namedNode('http://example.org/s'),
      dataFactory.namedNode('http://example.org/p'),
      dataFactory.literal('o'),
      dataFactory.namedNode('http://example.org/g'),
    );
    const state = buildState(dir, 'gf-target', { kind: 'file', path: outPath }, [q]);
    await assert.rejects(
      () => finalizeTask(noopNext, state),
      (err: unknown) => err instanceof OutputConfigError,
    );
  });

  it('collapses named-graph quads to a single graph when output.graph is set', async () => {
    const dir = join(workDir, 'collapse');
    const outPath = join(dir, 'out.nq');
    const collapseGraph = 'http://example.org/collapse';
    const q1 = dataFactory.quad(
      dataFactory.namedNode('http://example.org/s'),
      dataFactory.namedNode('http://example.org/p'),
      dataFactory.literal('1'),
      dataFactory.namedNode('http://example.org/g1'),
    );
    const q2 = dataFactory.quad(
      dataFactory.namedNode('http://example.org/s'),
      dataFactory.namedNode('http://example.org/p'),
      dataFactory.literal('2'),
      dataFactory.namedNode('http://example.org/g2'),
    );
    const state = buildState(dir, 'col-target',
      { kind: 'file', path: outPath, graph: collapseGraph }, [q1, q2]);
    await finalizeTask(noopNext, state);

    const text = await readFile(outPath, 'utf8');
    const { quads } = await Parser.parse(text, { format: 'nquads' });
    assert.equal(quads.length, 2);
    for (const q of quads) {
      assert.equal(q.graph.value, collapseGraph);
    }
  });

  it('throws ExternalSchemaError when state.context is undefined', async () => {
    const state = {
      targetId:        'no-ctx',
      source:          { target: 'no-ctx', path: 'x' },
      input:           {},
      classification:  null,
      classifications: [],
      output:          null,
    } as PipelineStateInterface;
    await assert.rejects(() => finalizeTask(noopNext, state));
  });

  it('persists output.report.json with quadCount and format', async () => {
    const dir = join(workDir, 'reportshape');
    const outPath = join(dir, 'out.ttl');
    const q = dataFactory.quad(
      dataFactory.namedNode('http://example.org/s'),
      dataFactory.namedNode('http://example.org/p'),
      dataFactory.literal('o'),
    );
    const state = buildState(dir, 'rs-target', { kind: 'file', path: outPath }, [q]);
    await finalizeTask(noopNext, state);

    const text = await readFile(join(dir, 'rs-target', 'output.report.json'), 'utf8');
    const report = JSON.parse(text) as { quadCount: number; format: string; bytesWritten: number; durationMs: number };
    assert.equal(report.quadCount, 1);
    assert.equal(report.format, 'turtle');
    assert.ok(report.bytesWritten > 0);
    assert.ok(report.durationMs >= 0);
  });

  it('SHACL pre-write validation: failing shapes quarantine + throw FileOutputError', async () => {
    const dir = join(workDir, 'shaclfail');
    const outPath = join(dir, 'out.ttl');
    const shapesPath = join(dir, 'shapes.ttl');
    await mkdir(dir, { recursive: true });
    await writeFile(shapesPath, [
      '@prefix sh: <http://www.w3.org/ns/shacl#> .',
      '@prefix ex: <http://example.org/> .',
      'ex:PersonShape a sh:NodeShape ; sh:targetClass ex:Person ; sh:property [ sh:path ex:name ; sh:minCount 1 ] .',
    ].join('\n'), 'utf8');

    const sub  = dataFactory.namedNode('http://example.org/alice');
    const type = dataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const Person = dataFactory.namedNode('http://example.org/Person');
    const q = dataFactory.quad(sub, type, Person);
    // No ex:name → violates sh:minCount 1.

    const state = buildState(dir, 'sf-target',
      { kind: 'file', path: outPath, validate: { shapes: shapesPath } }, [q]);

    await assert.rejects(
      () => finalizeTask(noopNext, state),
      (err: unknown) => err instanceof FileOutputError,
    );

    // Destination file must NOT exist; quarantine artifacts must.
    await assert.rejects(() => access(outPath));
    await access(join(dir, 'sf-target', 'quarantine', 'output', 'validation.report.txt'));
    await access(join(dir, 'sf-target', 'quarantine', 'output', 'validation.report.ttl'));
  });
});
