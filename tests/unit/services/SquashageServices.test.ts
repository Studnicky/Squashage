import test from 'node:test';
import assert from 'node:assert/strict';

import { SquashageServices } from '../../../src/services/SquashageServices.js';
import type { TargetConfigInterface } from '../../../src/config/SquashageConfig.js';
import type { OutputConfigInterface } from '../../../src/config/OutputConfig.js';
import { JsonTologyOntology } from '../../../src/ontology/JsonTologyOntology.js';

const baseTarget: TargetConfigInterface = {
  input:    { basePath: './input/aonprd', format: 'json' },
  output:   { kind: 'file', path: './graphs/aonprd.jsonld' } as OutputConfigInterface,
  graphs:   { default: 'https://squashage.dev/graph/aonprd/default' },
  ontology: { baseIri: 'https://aonprd.example.org/' },
  concurrency: 1,
};

const baseOptions = {
  target:       'aonprd',
  targetConfig: baseTarget,
  output:       baseTarget.output,
  outDir:       './graphs',
  schemasBase:  process.cwd(),
  sampleSource: undefined,
  runStartTime: '2026-05-18T00:00:00Z',
} as const;

test('happy path', async (t) => {
  await t.test('builds every required slot', async () => {
    const services = await SquashageServices.forTarget(baseOptions);
    assert.ok(services.logger, 'logger');
    assert.ok(services.ajv,    'ajv');
    assert.ok(services.factory, 'factory');
    assert.ok(services.dataset, 'dataset');
    assert.ok(services.builder, 'builder');
    assert.ok(services.prefixes, 'prefixes');
    assert.ok(services.iri, 'iri');
    assert.ok(services.graphs, 'graphs');
    assert.ok(services.quarantine, 'quarantine');
    assert.equal(services.target, 'aonprd');
    assert.equal(services.runStartTime, '2026-05-18T00:00:00Z');
    assert.equal(services.outDir, './graphs');
    assert.equal(services.ontology, null);
  });

  await t.test('mints NamedNode graph IRIs from string config entries', async () => {
    const services = await SquashageServices.forTarget(baseOptions);
    const def = services.graphs['default'];
    assert.ok(def);
    assert.equal(def.value, 'https://squashage.dev/graph/aonprd/default');
    assert.equal(def.termType, 'NamedNode');
  });

  await t.test('ajv is configured with strict + allErrors + addFormats', async () => {
    const services = await SquashageServices.forTarget(baseOptions);
    const validate = services.ajv.compile({
      type:   'object',
      properties: { date: { type: 'string', format: 'date' } },
      required: ['date'],
    });
    assert.equal(validate({ date: '2026-05-18' }), true);
    assert.equal(validate({ date: 'not-a-date' }), false);
  });
});

test('edge cases', async (t) => {
  await t.test('ontology slot is null when targetConfig.ontology.engine is missing', async () => {
    const services = await SquashageServices.forTarget(baseOptions);
    assert.equal(services.ontology, null);
  });

  await t.test('ontology slot is null when engine is set but no schemas are listed', async () => {
    const target: TargetConfigInterface = {
      ...baseTarget,
      ontology: { baseIri: 'https://x.example.org/', engine: 'json-tology', baseIRI: 'https://x.example.org/', schemas: [] },
    };
    const services = await SquashageServices.forTarget({ ...baseOptions, targetConfig: target });
    assert.equal(services.ontology, null);
  });

  await t.test('empty graphs config produces an empty graphs map', async () => {
    const target: TargetConfigInterface = { ...baseTarget, graphs: {} };
    const services = await SquashageServices.forTarget({ ...baseOptions, targetConfig: target });
    assert.deepEqual(Object.keys(services.graphs), []);
  });
});

test('unhappy path', async (t) => {
  await t.test('prefixResolver falls back to synthetic namespace when target slug sanitizes empty', async () => {
    // PrefixResolver throws OutputConfigError if the slug is empty; an
    // exotic-only target name like "%%%" sanitizes to ''. Assert the throw.
    await assert.rejects(
      SquashageServices.forTarget({ ...baseOptions, target: '%%%' }),
      /target/i,
    );
  });
});

// Used to keep the import live in case JsonTologyOntology export tree-shakes.
void JsonTologyOntology;

// ---------------------------------------------------------------------------
// Core schema auto-load tests (P19d)
// ---------------------------------------------------------------------------

const CORE_BASE_IRI = 'https://squashage.test/vocab/';

/**
 * A target config that enables the json-tology engine and points at the
 * minimal test fixture schema.  `schemasBase` is the project root so that
 * the relative `schemaPath` resolves correctly.
 */
const jsonTologyTarget: TargetConfigInterface = {
  ...baseTarget,
  ontology: {
    baseIri:  CORE_BASE_IRI,
    engine:   'json-tology',
    baseIRI:  CORE_BASE_IRI,
    schemas: [
      { schemaPath: 'tests/fixtures/schemas/TestEntry.schema.json' },
    ],
  },
};

const jsonTologyOptions = {
  ...baseOptions,
  targetConfig: jsonTologyTarget,
  schemasBase:  process.cwd(),
};

test('core schema auto-load (P19d)', async (t) => {
  await t.test('ontology is non-null when engine is json-tology with a schema', async () => {
    const services = await SquashageServices.forTarget(jsonTologyOptions);
    assert.notEqual(services.ontology, null, 'ontology must be non-null when json-tology engine is configured');
  });

  await t.test('classMap contains all 10 core class names', async () => {
    const services = await SquashageServices.forTarget(jsonTologyOptions);
    const map = services.ontology!.classMap();

    const coreClassNames = [
      'Thing', 'NamedThing', 'Identified', 'Provenance',
      'DocumentSegment', 'ContentEntry', 'Vocabulary',
      'Reference', 'Mechanic', 'Container',
    ] as const;

    for (const name of coreClassNames) {
      assert.ok(name in map, `classMap must contain core class "${name}"`);
    }
  });

  await t.test('classMap contains the per-target TestEntry class', async () => {
    const services = await SquashageServices.forTarget(jsonTologyOptions);
    const map = services.ontology!.classMap();
    assert.ok('TestEntry' in map, 'classMap must contain per-target class "TestEntry"');
  });

  await t.test('ontology is null when targetConfig has no ontology block', async () => {
    const services = await SquashageServices.forTarget(baseOptions);
    assert.equal(services.ontology, null);
  });

  await t.test('ancestorIris("ContentEntry") returns NamedThing, Thing in BFS order', async () => {
    const services = await SquashageServices.forTarget(jsonTologyOptions);
    const ancestors = services.ontology!.ancestorIris('ContentEntry');

    // Extract just the class name from each IRI.
    // Class IRIs use path-form (<base>/<ClassName>) — no '#' — so slice after '/'.
    const names = ancestors.map((iri) => iri.slice(iri.lastIndexOf('/') + 1));

    assert.deepEqual(names, ['NamedThing', 'Thing'],
      `Expected BFS order [NamedThing, Thing]; got [${names.join(', ')}]`);
  });
});
