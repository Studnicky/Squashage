/**
 * @fileoverview Unit tests for `Serializer.openStream` — the streaming
 * write path that avoids accumulating the full N-Quads document in memory.
 *
 * Covers:
 * - openStream + writeQuads + close round-trips correctly (read back, assert
 *   quad set equal to input).
 * - Multiple write calls append quads correctly (file contains all batches).
 * - Empty write call is a no-op.
 * - Concurrent write calls from multiple async callers are serialized.
 * - JSON-LD format throws OutputConfigError (not supported for streaming).
 * - close() flushes the stream before the file is readable.
 *
 * All tests write to a real temp directory so that stream mechanics are
 * verified end-to-end.
 */

import { describe, it, before, after } from 'node:test';
import assert                           from 'node:assert/strict';
import { mkdtemp }                      from 'node:fs/promises';
import { join }                         from 'node:path';
import { tmpdir }                       from 'node:os';
import { rm, stat }                     from 'node:fs/promises';

import { dataFactory }       from '../../../src/rdf/DataFactory.js';
import { Serializer }        from '../../../src/rdf/Serializer.js';
import { Parser }            from '../../../src/rdf/Parser.js';
import { OutputConfigError } from '../../../src/errors/OutputConfigError.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const s  = dataFactory.namedNode('http://example.org/s');
const p  = dataFactory.namedNode('http://example.org/p');
const g  = dataFactory.namedNode('http://example.org/graph');

function makeQuad(objectValue: string) {
  return dataFactory.quad(s, p, dataFactory.literal(objectValue), g);
}

const quad1 = makeQuad('first');
const quad2 = makeQuad('second');
const quad3 = makeQuad('third');

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch { return false; }
}

// ---------------------------------------------------------------------------
// Suite: basic round-trip
// ---------------------------------------------------------------------------

describe('Serializer.openStream — N-Quads round-trip', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'serializer-stream-')); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('write + close then read-back recovers the original quads', async () => {
    const outPath = join(tmpDir, 'out.nq');
    const writer = await Serializer.openStream(outPath, 'nquads');

    await writer.write([quad1, quad2]);
    await writer.close();

    const content   = await import('node:fs/promises').then((m) => m.readFile(outPath, 'utf8'));
    const { quads } = await Parser.parse(content, { format: 'nquads' });

    assert.equal(quads.length, 2, 'must recover exactly 2 quads');
    const objectValues = quads.map((q) => q.object.value).sort();
    assert.deepEqual(objectValues, ['first', 'second'].sort(), 'object literals must match');
  });

  it('creates parent directories when they do not exist', async () => {
    const nested = join(tmpDir, 'deeply', 'nested', 'sub', 'out.nq');
    const writer = await Serializer.openStream(nested, 'nquads');
    await writer.write([quad1]);
    await writer.close();

    assert.ok(await fileExists(nested), 'file must exist after write + close');
  });
});

// ---------------------------------------------------------------------------
// Suite: multiple write calls
// ---------------------------------------------------------------------------

describe('Serializer.openStream — multiple write calls', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'serializer-multi-')); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('three sequential write calls produce all quads in the output file', async () => {
    const outPath = join(tmpDir, 'out.nq');
    const writer  = await Serializer.openStream(outPath, 'nquads');

    await writer.write([quad1]);
    await writer.write([quad2]);
    await writer.write([quad3]);
    await writer.close();

    const content   = await import('node:fs/promises').then((m) => m.readFile(outPath, 'utf8'));
    const { quads } = await Parser.parse(content, { format: 'nquads' });

    assert.equal(quads.length, 3, 'all three quads must appear in output');
    const objectValues = quads.map((q) => q.object.value).sort();
    assert.deepEqual(objectValues, ['first', 'second', 'third'].sort());
  });

  it('empty write call does not break subsequent writes', async () => {
    const outPath = join(tmpDir, 'empty-write.nq');
    const writer  = await Serializer.openStream(outPath, 'nquads');

    await writer.write([]);        // no-op
    await writer.write([quad1]);
    await writer.write([]);        // no-op
    await writer.close();

    const content   = await import('node:fs/promises').then((m) => m.readFile(outPath, 'utf8'));
    const { quads } = await Parser.parse(content, { format: 'nquads' });

    assert.equal(quads.length, 1, 'only the non-empty write should contribute quads');
    assert.equal(quads[0]?.object.value, 'first');
  });
});

// ---------------------------------------------------------------------------
// Suite: concurrent writes
// ---------------------------------------------------------------------------

describe('Serializer.openStream — concurrent writes', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'serializer-concurrent-')); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('concurrent write Promises resolve without interleaved corruption', async () => {
    const outPath = join(tmpDir, 'concurrent.nq');
    const writer  = await Serializer.openStream(outPath, 'nquads');

    // Fire writes concurrently — the back-pressure mechanism ensures ordering.
    await Promise.all([
      writer.write([quad1]),
      writer.write([quad2]),
      writer.write([quad3]),
    ]);
    await writer.close();

    const content   = await import('node:fs/promises').then((m) => m.readFile(outPath, 'utf8'));
    const { quads } = await Parser.parse(content, { format: 'nquads' });

    // All 3 quads must be present; order may differ.
    assert.equal(quads.length, 3, 'all concurrent quads must appear in output');
  });
});

// ---------------------------------------------------------------------------
// Suite: JSON-LD format rejection
// ---------------------------------------------------------------------------

describe('Serializer.openStream — JSON-LD format', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'serializer-jsonld-')); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('throws OutputConfigError when format is jsonld', async () => {
    const outPath = join(tmpDir, 'out.jsonld');
    await assert.rejects(
      // Force JSON-LD past TypeScript cast to test the runtime guard.
      Serializer.openStream(outPath, 'jsonld' as Exclude<'jsonld', 'jsonld'>),
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError, 'must throw OutputConfigError for jsonld format');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Suite: Turtle format streaming
// ---------------------------------------------------------------------------

describe('Serializer.openStream — Turtle format', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'serializer-ttl-')); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('writes valid Turtle when format is turtle', async () => {
    const tripleQuad = dataFactory.quad(s, p, dataFactory.literal('hello'), dataFactory.defaultGraph());
    const outPath    = join(tmpDir, 'out.ttl');
    const writer     = await Serializer.openStream(outPath, 'turtle');

    await writer.write([tripleQuad]);
    await writer.close();

    const content   = await import('node:fs/promises').then((m) => m.readFile(outPath, 'utf8'));
    const { quads } = await Parser.parse(content, { format: 'turtle' });

    assert.ok(quads.length >= 1, 'Turtle output must contain at least one quad/triple');
    assert.equal(quads[0]?.object.value, 'hello');
  });
});

// ---------------------------------------------------------------------------
// Suite: TriG format streaming
// ---------------------------------------------------------------------------

describe('Serializer.openStream — TriG format', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'serializer-trig-')); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('writes valid TriG with named-graph quads', async () => {
    const quad = dataFactory.quad(s, p, dataFactory.literal('trig-val'), g);
    const outPath = join(tmpDir, 'out.trig');
    const writer  = await Serializer.openStream(outPath, 'trig');

    await writer.write([quad]);
    await writer.close();

    const content   = await import('node:fs/promises').then((m) => m.readFile(outPath, 'utf8'));
    const { quads } = await Parser.parse(content, { format: 'trig' });

    assert.ok(quads.length >= 1, 'TriG output must contain at least one quad');
    assert.equal(quads[0]?.object.value, 'trig-val');
    assert.ok(
      quads.some((q) => q.graph.termType === 'NamedNode' && q.graph.value === g.value),
      'named graph must be preserved in TriG output',
    );
  });
});
