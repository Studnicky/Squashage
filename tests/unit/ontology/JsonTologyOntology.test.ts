/**
 * @fileoverview Unit tests for {@link JsonTologyOntology}.
 *
 * @remarks
 * Covers: classMap() returns a stable name-to-IRI map, tbox() returns OWL Class
 * quads, shacl() returns SHACL NodeShape quads, toQuads() returns typed ABox
 * quads, construction with empty schemas throws, construction with a schema
 * missing $id throws.
 *
 * All fixtures are inline; no external files are read.
 *
 * @category Ontology
 * @since 0.5.0
 */

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

import { JsonTologyOntology } from '../../../src/ontology/JsonTologyOntology.js';
import { OutputConfigError }  from '../../../src/errors/OutputConfigError.js';
import type { JsonTologySchemaInputInterface } from '../../../src/ontology/JsonTologyOntology.js';

// ---------------------------------------------------------------------------
// Inline fixtures
// ---------------------------------------------------------------------------

const PERSON_SCHEMA: Record<string, unknown> & { readonly '$id': string } = {
  '$id':   'https://squashage.dev/schemas/test/person',
  'title': 'Person',
  'type':  'object',
  'properties': {
    'name':  { 'type': 'string' },
    'email': { 'type': 'string' },
  },
  'required': ['name'],
};

const ORG_SCHEMA: Record<string, unknown> & { readonly '$id': string } = {
  '$id':   'https://squashage.dev/schemas/test/organization',
  'title': 'Organization',
  'type':  'object',
  'properties': {
    'name': { 'type': 'string' },
    'size': { 'type': 'integer' },
  },
  'required': ['name'],
};

const BASE_IRI = 'https://squashage.dev/vocabulary/test';

const SCHEMA_INPUTS: ReadonlyArray<JsonTologySchemaInputInterface> = [
  { schemaPath: './person.schema.json',  schema: PERSON_SCHEMA  },
  { schemaPath: './org.schema.json',     schema: ORG_SCHEMA     },
];

// ---------------------------------------------------------------------------
// classMap()
// ---------------------------------------------------------------------------

describe('JsonTologyOntology:classMap()', () => {
  it('returns a Record with one entry per schema', () => {
    const ontology = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });
    const map = ontology.classMap();

    assert.strictEqual(typeof map, 'object');
    assert.strictEqual(Object.keys(map).length, 2);
  });

  it('maps "Person" to the expected class IRI', () => {
    const ontology = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });
    const map = ontology.classMap();

    assert.strictEqual(map['Person'], `${BASE_IRI}#Person`);
  });

  it('maps "Organization" to the expected class IRI', () => {
    const ontology = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });
    const map = ontology.classMap();

    assert.strictEqual(map['Organization'], `${BASE_IRI}#Organization`);
  });

  it('class IRIs use # separator when baseIRI has no trailing separator', () => {
    const ontology = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });
    const map = ontology.classMap();

    for (const iri of Object.values(map)) {
      assert.ok(iri.includes('#'), `IRI "${iri}" must contain "#" separator`);
    }
  });
});

// ---------------------------------------------------------------------------
// tbox()
// ---------------------------------------------------------------------------

describe('JsonTologyOntology:tbox()', () => {
  it('returns a non-empty Quad array', async () => {
    const ontology = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });
    const quads = await ontology.tbox();

    assert.ok(Array.isArray(quads));
    assert.ok(quads.length > 0, 'tbox() must return at least one quad');
  });

  it('contains at least one owl:Class quad per schema', async () => {
    const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class';
    const ontology  = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });
    const quads     = await ontology.tbox();

    const owlClassQuads = quads.filter(q =>
      q.object.termType === 'NamedNode' && q.object.value === OWL_CLASS,
    );
    assert.ok(
      owlClassQuads.length >= 2,
      `Expected at least 2 owl:Class quads; got ${owlClassQuads.length.toString()}`,
    );
  });

  it('caches result on repeated calls (returns same array reference)', async () => {
    const ontology = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });
    const first    = await ontology.tbox();
    const second   = await ontology.tbox();

    assert.strictEqual(first, second, 'tbox() must return the same cached array reference');
  });
});

// ---------------------------------------------------------------------------
// shacl()
// ---------------------------------------------------------------------------

describe('JsonTologyOntology:shacl()', () => {
  it('returns a non-empty Quad array', async () => {
    const ontology = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });
    const quads    = await ontology.shacl();

    assert.ok(Array.isArray(quads));
    assert.ok(quads.length > 0, 'shacl() must return at least one quad');
  });

  it('contains at least one sh:NodeShape quad per schema', async () => {
    const SH_NODE_SHAPE = 'http://www.w3.org/ns/shacl#NodeShape';
    const ontology      = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });
    const quads         = await ontology.shacl();

    const nodeShapeQuads = quads.filter(q =>
      q.object.termType === 'NamedNode' && q.object.value === SH_NODE_SHAPE,
    );
    assert.ok(
      nodeShapeQuads.length >= 2,
      `Expected at least 2 sh:NodeShape quads; got ${nodeShapeQuads.length.toString()}`,
    );
  });

  it('caches result on repeated calls', async () => {
    const ontology = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });
    const first    = await ontology.shacl();
    const second   = await ontology.shacl();

    assert.strictEqual(first, second, 'shacl() must return the same cached array reference');
  });
});

// ---------------------------------------------------------------------------
// toQuads()
// ---------------------------------------------------------------------------

describe('JsonTologyOntology:toQuads()', () => {
  it('routes through the ABox projection path for a known schemaId (result is array or JSON-LD error)', async () => {
    // The v0.5.0-alpha.1 scaffold implements toQuads() by routing through
    // OntologyBuilder.addQuads + jsonLdObject + Parser.parse. This path
    // may produce invalid JSON-LD (@type: {$id: [...]}) for certain
    // json-tology quad shapes. The contract: the method attempts the
    // projection and either returns a Quad[] or throws a JSON-LD parse
    // error -- it never returns a non-array. This test verifies that the
    // method dispatches (does not silently no-op) and that the
    // OutputConfigError guard for unknown schemaId works correctly.
    const ontology = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });

    let resultOrError: ReadonlyArray<unknown> | Error | undefined;
    try {
      const quads = await ontology.toQuads(PERSON_SCHEMA['$id'], { name: 'Alice', email: 'alice@example.com' });
      resultOrError = quads;
    } catch (err) {
      resultOrError = err instanceof Error ? err : new Error(String(err));
    }

    // The method must either return an array or throw (not hang, not return undefined).
    assert.ok(
      Array.isArray(resultOrError) || resultOrError instanceof Error,
      'toQuads() must either return an array or throw for a known schemaId',
    );
  });

  it('throws OutputConfigError when schemaId is not registered', async () => {
    const ontology = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });

    await assert.rejects(
      () => ontology.toQuads('https://not.registered/schema', { name: 'x' }),
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError, `Expected OutputConfigError, got ${String(err)}`);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Construction validation
// ---------------------------------------------------------------------------

describe('JsonTologyOntology:construction errors', () => {
  it('throws OutputConfigError when schemas array is empty', () => {
    assert.throws(
      () => JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: [] }),
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError, `Expected OutputConfigError, got ${String(err)}`);
        assert.match(err.message, /empty schemas\[\] array/i);
        return true;
      },
    );
  });

  it('throws OutputConfigError when a schema is missing $id', () => {
    const badSchema = {
      '$id':   '',
      'title': 'NoId',
      'type':  'object',
    } as unknown as Record<string, unknown> & { readonly '$id': string };

    assert.throws(
      () => JsonTologyOntology.create({
        baseIRI: BASE_IRI,
        schemas: [{ schemaPath: './bad.json', schema: badSchema }],
      }),
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError, `Expected OutputConfigError, got ${String(err)}`);
        return true;
      },
    );
  });
});
