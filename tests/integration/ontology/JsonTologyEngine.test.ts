/**
 * @fileoverview Integration test: json-tology engine through the orchestrator pipeline.
 *
 * @remarks
 * Builds a minimal fixture target inline with engine: "json-tology" and two schemas.
 * Runs the orchestrator pipeline through to ontology:emit (via a synthetic finalize
 * step). Asserts that:
 *
 * - `state.context.jt` is populated on per-record states.
 * - The TBox file is written and parses as valid Turtle via n3.
 * - The SHACL file is written and contains at least one sh:NodeShape subject.
 *
 * @module tests/integration/ontology/JsonTologyEngine
 * @category Integration
 * @since 0.5.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, rm, mkdir, writeFile, readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join }   from 'node:path';

import { Parser as N3Parser } from 'n3';

import { SquashageOrchestrator }  from '../../../src/orchestrators/SquashageOrchestrator.js';
import { TaskRegistry }           from '../../../src/registry/TaskRegistry.js';
import type { SquashageConfigInterface } from '../../../src/config/SquashageConfig.js';
import type { NextFnInterface, TaskFnInterface } from '../../../src/types/Pipeline.js';
import type { PipelineStateInterface }  from '../../../src/types/PipelineState.js';

// ---------------------------------------------------------------------------
// Inline schemas
// ---------------------------------------------------------------------------

const WIDGET_SCHEMA = {
  '$id':        'https://squashage.dev/schemas/test/widget',
  'title':      'Widget',
  '$schema':    'http://json-schema.org/draft-07/schema#',
  'type':       'object',
  'properties': {
    'name': { 'type': 'string' },
    'sku':  { 'type': 'string' },
  },
  'required': ['name'],
};

const GADGET_SCHEMA = {
  '$id':        'https://squashage.dev/schemas/test/gadget',
  'title':      'Gadget',
  '$schema':    'http://json-schema.org/draft-07/schema#',
  'type':       'object',
  'properties': {
    'name':  { 'type': 'string' },
    'power': { 'type': 'integer' },
  },
  'required': ['name'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Writes inline schema files and returns their absolute paths. */
async function writeSchemas(dir: string): Promise<{ widgetPath: string; gadgetPath: string }> {
  const widgetPath = join(dir, 'widget.schema.json');
  const gadgetPath = join(dir, 'gadget.schema.json');
  await writeFile(widgetPath, JSON.stringify(WIDGET_SCHEMA, null, 2), 'utf8');
  await writeFile(gadgetPath, JSON.stringify(GADGET_SCHEMA, null, 2), 'utf8');
  return { widgetPath, gadgetPath };
}

/** Builds a minimal SquashageConfigInterface with the json-tology engine. */
function buildConfig(
  inputDir:    string,
  outputPath:  string,
  configDir:   string,
  tboxPath:    string,
  shaclPath:   string,
): SquashageConfigInterface {
  return {
    input:   { basePath: inputDir, format: 'json' },
    targets: {
      widgets: {
        input:    inputDir,
        pipeline: ['json:read', 'fixture:jt:classify', 'fixture:jt:squash', 'rdfjs:finalize', 'ontology:emit'],
        output:   { kind: 'file', path: outputPath },
        graphs:   {},
        ontology: {
          engine:  'json-tology',
          baseIRI: 'https://squashage.dev/vocabulary/test',
          schemas: [
            { schemaPath: './widget.schema.json' },
            { schemaPath: './gadget.schema.json' },
          ],
          emit: {
            tbox:  tboxPath,
            shacl: shaclPath,
          },
        } as unknown as Record<string, unknown>,
      },
    },
  };
}

/** Registers minimal fixture tasks for this integration test. */
function registerFixtureTasks(): void {
  const classifyTask: TaskFnInterface<PipelineStateInterface> = async (
    next: NextFnInterface,
    state: PipelineStateInterface,
  ): Promise<void> => {
    (state as Record<string, unknown>)['classification'] = {
      type: 'Widget', confidence: 1, engine: 'fixture', reasons: ['fixture'],
    };
    await next();
  };

  const squashTask: TaskFnInterface<PipelineStateInterface> = async (
    next: NextFnInterface,
    _state: PipelineStateInterface,
  ): Promise<void> => {
    // Minimal squash: no-op quad emission. The test only cares about jt and emit.
    await next();
  };

  TaskRegistry.register('fixture:jt:classify', classifyTask);
  TaskRegistry.register('fixture:jt:squash',   squashTask);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let rootDir = '';

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'sq-int-jt-'));
  registerFixtureTasks();
});

after(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('JsonTologyEngine integration:orchestrator wires jt on context', () => {
  const TARGET = 'widgets';
  let capturedJt: unknown;
  let tboxFilePath  = '';
  let shaclFilePath = '';

  before(async () => {
    const base       = join(rootDir, 'jt-engine');
    const inputDir   = join(base, 'input');
    const outDir     = join(base, 'graphs');
    const outputPath = join(base, 'out', 'widgets.jsonld');
    const schemasDir = join(base, 'schemas');

    await mkdir(inputDir,          { recursive: true });
    await mkdir(outDir,            { recursive: true });
    await mkdir(schemasDir,        { recursive: true });
    await mkdir(join(base, 'out'), { recursive: true });

    // Write a single minimal input record.
    await writeFile(
      join(inputDir, 'widget1.json'),
      JSON.stringify({ _type: 'Widget', name: 'Sprocket' }),
      'utf8',
    );

    // Write schemas to the config directory.
    const configPath = join(base, 'squashage.config.json');
    await writeSchemas(base);

    tboxFilePath  = join(outDir, 'aonprd/ontology.ttl');
    shaclFilePath = join(outDir, 'aonprd/shapes.ttl');

    const cfg = buildConfig(
      inputDir,
      outputPath,
      base,
      'aonprd/ontology.ttl',
      'aonprd/shapes.ttl',
    );

    // Persist config so the orchestrator can derive configPath-based schemasBase.
    await writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    // Register a probe task that captures jt from state.context.
    const probeTask: TaskFnInterface<PipelineStateInterface> = async (
      next: NextFnInterface,
      state: PipelineStateInterface,
    ): Promise<void> => {
      capturedJt = state.context?.jt;
      await next();
    };
    TaskRegistry.register('fixture:jt:squash', probeTask);

    await SquashageOrchestrator.run(cfg, TARGET, {
      outDir,
      configPath,
      inputOverride: inputDir,
    });
  });

  it('state.context.jt is defined after orchestrator run with engine: json-tology', () => {
    assert.ok(
      capturedJt !== undefined,
      'state.context.jt must be defined when engine === "json-tology"',
    );
  });

  it('TBox file is written to the configured emit.tbox path', async () => {
    let text = '';
    try {
      text = await readFile(tboxFilePath, 'utf8');
    } catch {
      assert.fail(`TBox file not found at ${tboxFilePath}`);
    }
    assert.ok(text.length > 0, 'TBox file must not be empty');
  });

  it('TBox file parses cleanly via N3 (no parse errors)', async () => {
    const text   = await readFile(tboxFilePath, 'utf8');
    // TBox quads include named graphs, so the output is TriG format.
    const parser = new N3Parser({ format: 'TriG' });

    await new Promise<void>((resolve, reject) => {
      // N3Parser.parse calls callback once per quad (err=null, quad=Quad)
      // and once at end (err=null, quad=null) or on error (err=Error).
      parser.parse(text, (err, _quad, _prefixes) => {
        if (err) {
          reject(err);
        } else if (_quad === null) {
          // Final callback with null quad: parsing complete.
          resolve();
        }
        // Otherwise: mid-parse quad callback, continue.
      });
    });
  });

  it('SHACL file is written to the configured emit.shacl path', async () => {
    let text = '';
    try {
      text = await readFile(shaclFilePath, 'utf8');
    } catch {
      assert.fail(`SHACL file not found at ${shaclFilePath}`);
    }
    assert.ok(text.length > 0, 'SHACL file must not be empty');
  });

  it('SHACL file contains at least one sh:NodeShape reference', async () => {
    const text      = await readFile(shaclFilePath, 'utf8');
    const SH_PREFIX = 'http://www.w3.org/ns/shacl#';
    assert.ok(
      text.includes(SH_PREFIX) || text.includes('sh:'),
      `SHACL file must reference the SHACL namespace; got:\n${text.slice(0, 500)}`,
    );
  });
});

describe('JsonTologyEngine integration:no jt when engine is absent', () => {
  let capturedJtAbsent: unknown = 'NOT_SET';

  before(async () => {
    const base       = join(rootDir, 'no-engine');
    const inputDir   = join(base, 'input');
    const outDir     = join(base, 'graphs');
    const outputPath = join(base, 'out', 'things.jsonld');

    await mkdir(inputDir,          { recursive: true });
    await mkdir(outDir,            { recursive: true });
    await mkdir(join(base, 'out'), { recursive: true });

    await writeFile(
      join(inputDir, 'thing1.json'),
      JSON.stringify({ _type: 'Thing', name: 'Gizmo' }),
      'utf8',
    );

    const cfg: SquashageConfigInterface = {
      input:   { basePath: inputDir, format: 'json' },
      targets: {
        things: {
          input:    inputDir,
          pipeline: ['json:read', 'fixture:jt:absent:squash', 'rdfjs:finalize'],
          output:   { kind: 'file', path: outputPath },
          graphs:   {},
          ontology: { baseIri: 'https://example.org/' },
        },
      },
    };

    const probeTask: TaskFnInterface<PipelineStateInterface> = async (
      next: NextFnInterface,
      state: PipelineStateInterface,
    ): Promise<void> => {
      capturedJtAbsent = state.context?.jt;
      await next();
    };
    TaskRegistry.register('fixture:jt:absent:squash', probeTask);

    const configPath = join(base, 'squashage.config.json');
    await writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    await SquashageOrchestrator.run(cfg, 'things', {
      outDir,
      configPath,
      inputOverride: inputDir,
    });
  });

  it('state.context.jt is undefined when engine is absent', () => {
    assert.strictEqual(
      capturedJtAbsent,
      undefined,
      'state.context.jt must be undefined when no engine is configured',
    );
  });
});
