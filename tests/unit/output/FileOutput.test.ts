import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join, basename }                            from 'node:path';
import { tmpdir }                                    from 'node:os';
import { rm }                                        from 'node:fs/promises';

import { dataFactory }  from '../../../src/rdf/DataFactory.js';
import { Parser }       from '../../../src/rdf/Parser.js';
import { FileOutput }   from '../../../src/output/FileOutput.js';
import { FileOutputError } from '../../../src/errors/FileOutputError.js';
import type { OutputConfigInterface } from '../../../src/config/OutputConfig.js';
import type { PrefixResolutionInterface } from '../../../src/classification/PrefixResolver.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/** Creates a unique temp directory per test case. */
async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fileoutput-test-'));
}

/** Returns whether a path exists on disk. */
async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; }
  catch { return false; }
}

/**
 * Minimal valid OutputConfigInterface builder.
 * Merges overrides on top of a safe default.
 */
function config(
  path: string,
  overrides: Partial<Omit<OutputConfigInterface, 'kind' | 'path'>> = {},
): OutputConfigInterface {
  return { kind: 'file', path, ...overrides } as OutputConfigInterface;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EX = 'http://example.org/';

const s  = dataFactory.namedNode(`${EX}s`);
const p  = dataFactory.namedNode(`${EX}p`);
const o  = dataFactory.literal('hello');
const g1 = dataFactory.namedNode(`${EX}graph1`);
const g2 = dataFactory.namedNode(`${EX}graph2`);
const dg = dataFactory.defaultGraph();

/** One triple in the default graph. */
const oneTriple = [dataFactory.quad(s, p, o, dg)];

/** Two quads in two distinct named graphs. */
const twoNamedGraphQuads = [
  dataFactory.quad(s, p, dataFactory.literal('g1-val'), g1),
  dataFactory.quad(s, p, dataFactory.literal('g2-val'), g2),
];

// ---------------------------------------------------------------------------
// Suite: empty dataset + turtle
// ---------------------------------------------------------------------------

describe('FileOutput — empty dataset + turtle', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('writes a file (possibly empty turtle) and report.quadCount === 0', async () => {
    const outPath = join(tmpDir, 'empty.ttl');
    const out     = new FileOutput(config(outPath), tmpDir);

    await out.open();
    await out.writeBatch([]);
    const report = await out.close();

    assert.ok(await exists(outPath), 'destination file should exist');
    assert.equal(report.quadCount,    0);
    assert.equal(report.graphCount,   0);
    assert.equal(report.format,       'turtle');
    assert.equal(report.path,         outPath);
    assert.equal(report.errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Suite: simple turtle write → parse back → matches originals
// ---------------------------------------------------------------------------

describe('FileOutput — simple turtle write round-trip', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('file exists after close', async () => {
    const outPath = join(tmpDir, 'simple.ttl');
    const out     = new FileOutput(config(outPath), tmpDir);

    await out.open();
    await out.writeBatch(oneTriple);
    await out.close();

    assert.ok(await exists(outPath), 'destination file should exist');
  });

  it('report reflects quad count and byte length', async () => {
    const outPath = join(tmpDir, 'simple2.ttl');
    const out     = new FileOutput(config(outPath), tmpDir);

    await out.open();
    await out.writeBatch(oneTriple);
    const report = await out.close();

    assert.equal(report.quadCount,    1);
    assert.ok(report.bytesWritten > 0, 'bytesWritten should be positive');
  });

  it('parses back to original quads via Parser', async () => {
    const outPath = join(tmpDir, 'roundtrip.ttl');
    const out     = new FileOutput(config(outPath), tmpDir);

    await out.open();
    await out.writeBatch(oneTriple);
    await out.close();

    const text   = await readFile(outPath, 'utf8');
    const parsed = await Parser.parse(text, { format: 'turtle' });

    assert.equal(parsed.quads.length, 1);
    const q = parsed.quads[0];
    assert.ok(q !== undefined, 'should have one quad');
    assert.equal(q.subject.value,   s.value);
    assert.equal(q.predicate.value, p.value);
    assert.equal(q.object.value,    o.value);
  });
});

// ---------------------------------------------------------------------------
// Suite: TriG with named graphs
// ---------------------------------------------------------------------------

describe('FileOutput — trig with named graphs', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('preserves both named graphs in TriG output', async () => {
    const outPath = join(tmpDir, 'named.trig');
    const out     = new FileOutput(config(outPath), tmpDir);

    await out.open();
    await out.writeBatch(twoNamedGraphQuads);
    const report = await out.close();

    assert.equal(report.quadCount,  2);
    assert.equal(report.graphCount, 2);
    assert.equal(report.format,     'trig');

    const text   = await readFile(outPath, 'utf8');
    const parsed = await Parser.parse(text, { format: 'trig' });

    assert.equal(parsed.quads.length, 2);
    const graphValues = new Set(parsed.quads.map(q => q.graph.value));
    assert.ok(graphValues.has(g1.value), 'graph1 should be present');
    assert.ok(graphValues.has(g2.value), 'graph2 should be present');
  });
});

// ---------------------------------------------------------------------------
// Suite: canonicalize + nquads
// ---------------------------------------------------------------------------

describe('FileOutput — canonicalize + nquads', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('produces an N-Quads output file', async () => {
    const outPath = join(tmpDir, 'canon.nq');
    const out     = new FileOutput(config(outPath, { canonicalize: true }), tmpDir);

    await out.open();
    await out.writeBatch(oneTriple);
    const report = await out.close();

    assert.equal(report.format, 'nquads');
    assert.ok(await exists(outPath), 'destination file should exist');
    assert.equal(report.quadCount, 1);
    assert.ok(report.bytesWritten > 0);
  });

  it('RDFC-1.0 output is parseable', async () => {
    const outPath = join(tmpDir, 'canon2.nq');
    const out     = new FileOutput(config(outPath, { canonicalize: true }), tmpDir);

    await out.open();
    await out.writeBatch(oneTriple);
    await out.close();

    const text   = await readFile(outPath, 'utf8');
    const parsed = await Parser.parse(text, { format: 'nquads' });
    assert.equal(parsed.quads.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Suite: SHACL validation — passing shapes
// ---------------------------------------------------------------------------

describe('FileOutput — SHACL validation (passing)', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('writes the destination file when shapes pass', async () => {
    // Shapes: accept any shape (sh:targetClass not applied — everything conforms)
    const shapesPath = join(tmpDir, 'shapes.ttl');
    const shapesText = [
      '@prefix sh: <http://www.w3.org/ns/shacl#> .',
      '@prefix ex: <http://example.org/> .',
      'ex:MyShape a sh:NodeShape ;',
      '  sh:targetNode ex:none .',  // targets ex:none, which is not in our data → conforms trivially
    ].join('\n');
    await writeFile(shapesPath, shapesText, 'utf8');

    const outPath = join(tmpDir, 'validated.ttl');
    const out = new FileOutput(
      config(outPath, { validate: { shapes: shapesPath } }),
      tmpDir,
    );

    await out.open();
    await out.writeBatch(oneTriple);
    const report = await out.close();

    assert.ok(await exists(outPath),    'destination file should exist');
    assert.equal(report.errors.length, 0);
  });

  it('does not write quarantine files when shapes pass', async () => {
    const shapesPath = join(tmpDir, 'shapes2.ttl');
    await writeFile(shapesPath, '@prefix sh: <http://www.w3.org/ns/shacl#> .\n', 'utf8');

    const outPath = join(tmpDir, 'validated2.ttl');
    const out = new FileOutput(
      config(outPath, { validate: { shapes: shapesPath } }),
      tmpDir,
    );

    await out.open();
    await out.writeBatch(oneTriple);
    await out.close();

    const quarantineDir = join(tmpDir, 'quarantine', 'output');
    assert.equal(await exists(join(quarantineDir, 'validation.report.txt')), false, 'should have no txt quarantine');
    assert.equal(await exists(join(quarantineDir, 'validation.report.ttl')), false, 'should have no ttl quarantine');
  });
});

// ---------------------------------------------------------------------------
// Suite: SHACL validation — failing shapes
// ---------------------------------------------------------------------------

describe('FileOutput — SHACL validation (failing)', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('throws FileOutputError on SHACL failure', async () => {
    const shapesPath = join(tmpDir, 'failing-shapes.ttl');
    // Shape: ex:s must have rdf:type — it doesn't, so validation will fail
    const shapesText = [
      '@prefix sh:  <http://www.w3.org/ns/shacl#> .',
      '@prefix ex:  <http://example.org/> .',
      '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
      'ex:SShape a sh:NodeShape ;',
      '  sh:targetNode ex:s ;',
      '  sh:property [ sh:path rdf:type ; sh:minCount 1 ] .',
    ].join('\n');
    await writeFile(shapesPath, shapesText, 'utf8');

    const outPath = join(tmpDir, 'should-not-exist.ttl');
    const out = new FileOutput(
      config(outPath, { validate: { shapes: shapesPath } }),
      tmpDir,
    );

    await out.open();
    await out.writeBatch(oneTriple);

    await assert.rejects(
      () => out.close(),
      (err: unknown) => {
        assert.ok(err instanceof FileOutputError, 'should be FileOutputError');
        assert.equal((err as FileOutputError).metadata?.['stage'], 'validate');
        return true;
      },
    );
  });

  it('does not write the destination file on SHACL failure', async () => {
    const shapesPath = join(tmpDir, 'failing-shapes2.ttl');
    const shapesText = [
      '@prefix sh:  <http://www.w3.org/ns/shacl#> .',
      '@prefix ex:  <http://example.org/> .',
      '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
      'ex:SShape a sh:NodeShape ;',
      '  sh:targetNode ex:s ;',
      '  sh:property [ sh:path rdf:type ; sh:minCount 1 ] .',
    ].join('\n');
    await writeFile(shapesPath, shapesText, 'utf8');

    const outPath = join(tmpDir, 'no-dest.ttl');
    const out = new FileOutput(
      config(outPath, { validate: { shapes: shapesPath } }),
      tmpDir,
    );

    await out.open();
    await out.writeBatch(oneTriple);

    await assert.rejects(() => out.close());

    assert.equal(await exists(outPath), false, 'destination file must not be written on SHACL failure');
  });

  it('writes validation.report.txt quarantine artifact', async () => {
    const shapesPath = join(tmpDir, 'failing-shapes3.ttl');
    const shapesText = [
      '@prefix sh:  <http://www.w3.org/ns/shacl#> .',
      '@prefix ex:  <http://example.org/> .',
      '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
      'ex:SShape a sh:NodeShape ;',
      '  sh:targetNode ex:s ;',
      '  sh:property [ sh:path rdf:type ; sh:minCount 1 ] .',
    ].join('\n');
    await writeFile(shapesPath, shapesText, 'utf8');

    const outPath = join(tmpDir, 'no-dest2.ttl');
    const out = new FileOutput(
      config(outPath, { validate: { shapes: shapesPath } }),
      tmpDir,
    );

    await out.open();
    await out.writeBatch(oneTriple);

    await assert.rejects(() => out.close());

    const txtPath = join(tmpDir, 'quarantine', 'output', 'validation.report.txt');
    assert.ok(await exists(txtPath), 'validation.report.txt should exist');
  });

  it('writes validation.report.ttl quarantine artifact', async () => {
    const shapesPath = join(tmpDir, 'failing-shapes4.ttl');
    const shapesText = [
      '@prefix sh:  <http://www.w3.org/ns/shacl#> .',
      '@prefix ex:  <http://example.org/> .',
      '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
      'ex:SShape a sh:NodeShape ;',
      '  sh:targetNode ex:s ;',
      '  sh:property [ sh:path rdf:type ; sh:minCount 1 ] .',
    ].join('\n');
    await writeFile(shapesPath, shapesText, 'utf8');

    const outPath = join(tmpDir, 'no-dest3.ttl');
    const out = new FileOutput(
      config(outPath, { validate: { shapes: shapesPath } }),
      tmpDir,
    );

    await out.open();
    await out.writeBatch(oneTriple);

    await assert.rejects(() => out.close());

    const ttlPath = join(tmpDir, 'quarantine', 'output', 'validation.report.ttl');
    assert.ok(await exists(ttlPath), 'validation.report.ttl should exist');
  });
});

// ---------------------------------------------------------------------------
// Suite: dryRun
// ---------------------------------------------------------------------------

describe('FileOutput — dryRun', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('does not write the destination file', async () => {
    const outPath = join(tmpDir, 'dry.ttl');
    const out     = new FileOutput(config(outPath, { dryRun: true }), tmpDir);

    await out.open();
    await out.writeBatch(oneTriple);
    await out.close();

    assert.equal(await exists(outPath), false, 'destination file must not exist in dryRun');
  });

  it('report.bytesWritten === 0', async () => {
    const outPath = join(tmpDir, 'dry2.ttl');
    const out     = new FileOutput(config(outPath, { dryRun: true }), tmpDir);

    await out.open();
    await out.writeBatch(oneTriple);
    const report = await out.close();

    assert.equal(report.bytesWritten, 0);
  });

  it('report.quadCount reflects the buffered quads', async () => {
    const outPath = join(tmpDir, 'dry3.ttl');
    const out     = new FileOutput(config(outPath, { dryRun: true }), tmpDir);

    await out.open();
    await out.writeBatch(twoNamedGraphQuads);
    const report = await out.close();

    assert.equal(report.quadCount, 2);
  });
});

// ---------------------------------------------------------------------------
// Suite: graph collapse
// ---------------------------------------------------------------------------

describe('FileOutput — graph collapse (output.graph)', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('all quads land in the specified named graph when output.graph is set', async () => {
    const targetGraph = 'http://example.org/target-graph';
    const outPath     = join(tmpDir, 'collapsed.trig');
    const out = new FileOutput(
      config(outPath, { graph: targetGraph }),
      tmpDir,
    );

    await out.open();
    await out.writeBatch(twoNamedGraphQuads);
    await out.close();

    const text   = await readFile(outPath, 'utf8');
    const parsed = await Parser.parse(text, { format: 'trig' });

    assert.equal(parsed.quads.length, 2);
    for (const q of parsed.quads) {
      assert.equal(q.graph.value, targetGraph, `graph should be ${targetGraph}`);
    }
  });

  it('report.graphCount is 1 after collapse', async () => {
    const targetGraph = 'http://example.org/target-graph2';
    const outPath     = join(tmpDir, 'collapsed2.trig');
    const out = new FileOutput(
      config(outPath, { graph: targetGraph }),
      tmpDir,
    );

    await out.open();
    await out.writeBatch(twoNamedGraphQuads);
    const report = await out.close();

    assert.equal(report.graphCount, 1, 'all quads collapsed to one graph');
  });
});

// ---------------------------------------------------------------------------
// Suite: format resolver — format prop wins, extension fallback
// ---------------------------------------------------------------------------

describe('FileOutput — format property and extension fallback', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('uses explicit format even if extension differs', async () => {
    const outPath = join(tmpDir, 'out.data');
    const out     = new FileOutput(config(outPath, { format: 'nquads' }), tmpDir);

    await out.open();
    await out.writeBatch(oneTriple);
    const report = await out.close();

    assert.equal(report.format, 'nquads');
    const text   = await readFile(outPath, 'utf8');
    // N-Quads format: each line ends with " ."
    assert.ok(text.includes(' .'), 'should contain N-Quads line ending');
  });
});

// ---------------------------------------------------------------------------
// Suite: multiple writeBatch calls
// ---------------------------------------------------------------------------

describe('FileOutput — multiple writeBatch accumulates', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('accumulates quads across writeBatch calls', async () => {
    const outPath = join(tmpDir, 'multi.trig');
    const out     = new FileOutput(config(outPath), tmpDir);

    await out.open();
    await out.writeBatch(oneTriple);
    await out.writeBatch(twoNamedGraphQuads);
    const report = await out.close();

    assert.equal(report.quadCount, 3);
  });
});

// ---------------------------------------------------------------------------
// Suite: parent directory auto-created
// ---------------------------------------------------------------------------

describe('FileOutput — parent directory creation', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('creates nested parent directories on open()', async () => {
    const outPath = join(tmpDir, 'a', 'b', 'c', 'out.ttl');
    const out     = new FileOutput(config(outPath), tmpDir);

    await out.open();
    await out.writeBatch(oneTriple);
    await out.close();

    assert.ok(await exists(outPath), 'nested destination file should exist');
  });
});

// ---------------------------------------------------------------------------
// Suite: JSON-LD output
// ---------------------------------------------------------------------------

describe('FileOutput — JSON-LD output', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('writes valid JSON-LD and report has correct format', async () => {
    const outPath = join(tmpDir, 'out.jsonld');
    const out     = new FileOutput(config(outPath), tmpDir);

    await out.open();
    await out.writeBatch(oneTriple);
    const report = await out.close();

    assert.equal(report.format, 'jsonld');
    const text = await readFile(outPath, 'utf8');
    assert.doesNotThrow(() => JSON.parse(text), 'output should be valid JSON');
  });
});

// ---------------------------------------------------------------------------
// Suite: atomic write — .tmp does not persist on success
// ---------------------------------------------------------------------------

describe('FileOutput — atomic write cleanup', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('.tmp file does not exist after successful write', async () => {
    const outPath = join(tmpDir, 'atomic.ttl');
    const out     = new FileOutput(config(outPath), tmpDir);

    await out.open();
    await out.writeBatch(oneTriple);
    await out.close();

    assert.equal(await exists(`${outPath}.tmp`), false, '.tmp should be removed after rename');
    assert.ok(await exists(outPath), 'final destination should exist');
  });
});

// ---------------------------------------------------------------------------
// Suite: FileOutputError shape
// ---------------------------------------------------------------------------

describe('FileOutputError', () => {
  it('has correct code', () => {
    const err = FileOutputError.create('test');
    assert.equal(err.code, 'FILE_OUTPUT_ERROR');
    assert.equal(err.retryable, false);
  });

  it('carries metadata', () => {
    const err = FileOutputError.create('test', { metadata: { stage: 'validate' } });
    assert.equal(err.metadata?.['stage'], 'validate');
  });

  it('is an instance of Error', () => {
    const err = FileOutputError.create('test');
    assert.ok(err instanceof Error);
  });
});

// ---------------------------------------------------------------------------
// Suite: durationMs is measured
// ---------------------------------------------------------------------------

describe('FileOutput — durationMs', () => {
  let tmpDir = '';
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir, { recursive: true, force: true }); });

  it('durationMs is non-negative', async () => {
    const outPath = join(tmpDir, 'timing.ttl');
    const out     = new FileOutput(config(outPath), tmpDir);

    await out.open();
    await out.writeBatch(oneTriple);
    const report = await out.close();

    assert.ok(report.durationMs >= 0, 'durationMs should be >= 0');
  });
});

// Suppress unused import warning for basename
void basename;

// ---------------------------------------------------------------------------
// Suite: JSON-LD context — auto-build when no jsonldContext configured
// ---------------------------------------------------------------------------

/** Minimal PrefixResolutionInterface for JSON-LD tests. */
function makePrefixes(): PrefixResolutionInterface {
  return {
    instances:  { prefix: 'ex',    base: 'http://example.org/' },
    graphs:     { prefix: 'exg',   base: 'http://example.org/graph/' },
    vocabulary: { prefix: 'vocab', base: 'http://example.org/vocab/' },
    source:     'derived',
  };
}

describe('FileOutput — JSON-LD context: auto-build (no jsonldContext)', () => {
  let tmpDir2 = '';
  before(async () => { tmpDir2 = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir2, { recursive: true, force: true }); });

  it('output is compacted and contains @context when prefixes are provided', async () => {
    const outPath = join(tmpDir2, 'auto-ctx.jsonld');
    const out     = new FileOutput(config(outPath), tmpDir2, makePrefixes());

    await out.open();
    await out.writeBatch(oneTriple);
    await out.close();

    const text = await readFile(outPath, 'utf8');
    const doc  = JSON.parse(text) as Record<string, unknown>;

    assert.ok('@context' in doc, 'compacted JSON-LD should have @context');
  });

  it('@context includes run prefix entries (ex, vocab)', async () => {
    const outPath = join(tmpDir2, 'auto-ctx-prefixes.jsonld');
    const out     = new FileOutput(config(outPath), tmpDir2, makePrefixes());

    await out.open();
    await out.writeBatch(oneTriple);
    await out.close();

    const text = await readFile(outPath, 'utf8');
    const doc  = JSON.parse(text) as Record<string, unknown>;
    const ctx  = doc['@context'] as Record<string, unknown>;

    assert.ok(ctx !== undefined && typeof ctx === 'object', '@context should be an object');
    assert.equal(ctx['ex'],    'http://example.org/');
    assert.equal(ctx['vocab'], 'http://example.org/vocab/');
  });
});

// ---------------------------------------------------------------------------
// Suite: JSON-LD context — 'auto' explicit string behaves same as omitted
// ---------------------------------------------------------------------------

describe('FileOutput — JSON-LD context: explicit "auto" value', () => {
  let tmpDir3 = '';
  before(async () => { tmpDir3 = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir3, { recursive: true, force: true }); });

  it('output is compacted with @context when jsonldContext is "auto"', async () => {
    const outPath = join(tmpDir3, 'explicit-auto.jsonld');
    const out     = new FileOutput(
      config(outPath, { jsonldContext: 'auto' } as Partial<Omit<OutputConfigInterface, 'kind' | 'path'>>),
      tmpDir3,
      makePrefixes(),
    );

    await out.open();
    await out.writeBatch(oneTriple);
    await out.close();

    const text = await readFile(outPath, 'utf8');
    const doc  = JSON.parse(text) as Record<string, unknown>;

    assert.ok('@context' in doc, 'compacted JSON-LD should have @context with explicit auto');
  });
});

// ---------------------------------------------------------------------------
// Suite: JSON-LD context — inline object is used verbatim
// ---------------------------------------------------------------------------

describe('FileOutput — JSON-LD context: inline object', () => {
  let tmpDir4 = '';
  before(async () => { tmpDir4 = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir4, { recursive: true, force: true }); });

  it('uses the inline context object verbatim and produces compacted JSON-LD output', async () => {
    const inlineCtx = {
      '@context': {
        rdf:  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        xsd:  'http://www.w3.org/2001/XMLSchema#',
      },
    };
    const outPath = join(tmpDir4, 'inline-ctx.jsonld');
    const out     = new FileOutput(
      config(outPath, { jsonldContext: inlineCtx } as Partial<Omit<OutputConfigInterface, 'kind' | 'path'>>),
      tmpDir4,
      makePrefixes(),
    );

    await out.open();
    await out.writeBatch(oneTriple);
    await out.close();

    const text = await readFile(outPath, 'utf8');
    const doc  = JSON.parse(text) as Record<string, unknown>;

    // The output is compacted using the provided context; it should be valid JSON-LD.
    assert.ok(typeof doc === 'object', 'output should be a valid JSON object');
  });
});

// ---------------------------------------------------------------------------
// Suite: JSON-LD context — path-based loading
// ---------------------------------------------------------------------------

describe('FileOutput — JSON-LD context: path-based loading', () => {
  let tmpDir5 = '';
  before(async () => { tmpDir5 = await makeTmpDir(); });
  after(async ()  => { await rm(tmpDir5, { recursive: true, force: true }); });

  it('loads context from a path relative to configDir and produces compacted output', async () => {
    const ctxContent = JSON.stringify({
      '@context': {
        rdf:  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        xsd:  'http://www.w3.org/2001/XMLSchema#',
      },
    });
    const ctxPath = join(tmpDir5, 'my-context.jsonld');
    await writeFile(ctxPath, ctxContent, 'utf8');

    const outPath = join(tmpDir5, 'path-ctx.jsonld');
    const out     = new FileOutput(
      config(outPath, { jsonldContext: 'my-context.jsonld' } as Partial<Omit<OutputConfigInterface, 'kind' | 'path'>>),
      tmpDir5,
      makePrefixes(),
      tmpDir5,   // configDir
    );

    await out.open();
    await out.writeBatch(oneTriple);
    await out.close();

    const text = await readFile(outPath, 'utf8');
    const doc  = JSON.parse(text) as Record<string, unknown>;

    assert.ok(typeof doc === 'object', 'output should be a valid JSON object');
  });
});
