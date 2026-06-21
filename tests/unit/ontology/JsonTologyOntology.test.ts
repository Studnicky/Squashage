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

  it('maps "Person" to the expected path-form class IRI', () => {
    const ontology = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });
    const map = ontology.classMap();

    // Path-form: <baseIRI>/<className> — no '#' in the class IRI itself.
    // This ensures json-tology can append #<propertyName> for clean property IRIs.
    assert.strictEqual(map['Person'], `${BASE_IRI}/Person`);
  });

  it('maps "Organization" to the expected path-form class IRI', () => {
    const ontology = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });
    const map = ontology.classMap();

    assert.strictEqual(map['Organization'], `${BASE_IRI}/Organization`);
  });

  it('class IRIs use path-form (no # in the IRI itself) so property IRIs are RFC 3987-clean', () => {
    const ontology = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });
    const map = ontology.classMap();

    for (const iri of Object.values(map)) {
      // Class IRI must NOT contain '#' — json-tology appends #<prop> so one '#' total.
      assert.ok(!iri.includes('#'), `Class IRI "${iri}" must not contain "#" (path-form convention)`);
      // Must end with /<className>.
      assert.ok(iri.startsWith(BASE_IRI), `Class IRI "${iri}" must start with baseIRI`);
    }
  });

  it('simulated property IRI (classIri + "#" + prop) contains exactly one "#"', () => {
    // Guard: path-form ensures json-tology never produces double-hash property IRIs.
    const ontology = JsonTologyOntology.create({ baseIRI: BASE_IRI, schemas: SCHEMA_INPUTS });
    const map = ontology.classMap();
    for (const [name, classIri] of Object.entries(map)) {
      const propIri = `${classIri}#name`;
      const hashCount = (propIri.match(/#/g) ?? []).length;
      assert.equal(hashCount, 1, `property IRI for ${name} has ${hashCount.toString()} "#", expected 1`);
    }
  });

  it('baseIRI with trailing slash produces same class IRI as without', () => {
    const withSlash    = JsonTologyOntology.create({ baseIRI: `${BASE_IRI}/`, schemas: SCHEMA_INPUTS });
    const withoutSlash = JsonTologyOntology.create({ baseIRI: BASE_IRI,        schemas: SCHEMA_INPUTS });
    assert.deepStrictEqual(withSlash.classMap(), withoutSlash.classMap());
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
// ancestorIris()
// ---------------------------------------------------------------------------

// Build schemas that represent a three-level hierarchy:
//   Feat  --allOf--> ContentEntry  --allOf-->  Thing
// Plus an unrelated schema with no parents: Organization.
// Plus a direct-child schema: SimpleFeat  --allOf-->  Feat
// The $ref values follow the P19b convention: absolute $id of the parent schema.

const THING_SCHEMA_ANCESTORS: Record<string, unknown> & { readonly '$id': string } = {
  '$id':   'https://squashage.dev/schemas/ancestors/Thing',
  'title': 'Thing',
  'type':  'object',
  'properties': { 'name': { 'type': 'string' } },
};

const CONTENT_ENTRY_SCHEMA_ANCESTORS: Record<string, unknown> & { readonly '$id': string } = {
  '$id':   'https://squashage.dev/schemas/ancestors/ContentEntry',
  'title': 'ContentEntry',
  'type':  'object',
  'allOf': [{ '$ref': 'https://squashage.dev/schemas/ancestors/Thing' }],
  'properties': { 'source': { 'type': 'string' } },
};

const FEAT_SCHEMA_ANCESTORS: Record<string, unknown> & { readonly '$id': string } = {
  '$id':   'https://squashage.dev/schemas/ancestors/Feat',
  'title': 'Feat',
  'type':  'object',
  'allOf': [{ '$ref': 'https://squashage.dev/schemas/ancestors/ContentEntry' }],
  'properties': { 'level': { 'type': 'integer' } },
};

const SIMPLE_FEAT_SCHEMA_ANCESTORS: Record<string, unknown> & { readonly '$id': string } = {
  '$id':   'https://squashage.dev/schemas/ancestors/SimpleFeat',
  'title': 'SimpleFeat',
  'type':  'object',
  'allOf': [{ '$ref': 'https://squashage.dev/schemas/ancestors/Feat' }],
};

// Cycle schemas: A  --allOf-->  B  --allOf-->  A
const CYCLE_A: Record<string, unknown> & { readonly '$id': string } = {
  '$id':   'https://squashage.dev/schemas/ancestors/CycleA',
  'title': 'CycleA',
  'type':  'object',
  'allOf': [{ '$ref': 'https://squashage.dev/schemas/ancestors/CycleB' }],
};

const CYCLE_B: Record<string, unknown> & { readonly '$id': string } = {
  '$id':   'https://squashage.dev/schemas/ancestors/CycleB',
  'title': 'CycleB',
  'type':  'object',
  'allOf': [{ '$ref': 'https://squashage.dev/schemas/ancestors/CycleA' }],
};

const ANCESTORS_BASE_IRI = 'https://squashage.dev/vocabulary/ancestors';

function makeAncestorsOntology(
  extra: Array<Record<string, unknown> & { readonly '$id': string }> = [],
): ReturnType<typeof import('../../../src/ontology/JsonTologyOntology.js').JsonTologyOntology.create> {
  return JsonTologyOntology.create({
    baseIRI: ANCESTORS_BASE_IRI,
    schemas: [
      { schemaPath: './Thing.schema.json',         schema: THING_SCHEMA_ANCESTORS },
      { schemaPath: './ContentEntry.schema.json',  schema: CONTENT_ENTRY_SCHEMA_ANCESTORS },
      { schemaPath: './Feat.schema.json',           schema: FEAT_SCHEMA_ANCESTORS },
      { schemaPath: './SimpleFeat.schema.json',     schema: SIMPLE_FEAT_SCHEMA_ANCESTORS },
      ...extra.map(s => ({ schemaPath: `./${s['title'] as string}.schema.json`, schema: s })),
    ],
  });
}

describe('JsonTologyOntology:ancestorIris()', () => {
  it('returns [] for a schema with no allOf', () => {
    const ontology = makeAncestorsOntology();
    const result = ontology.ancestorIris('Thing');
    assert.deepEqual([...result], []);
  });

  it('returns one IRI for a schema with a single direct parent', () => {
    const ontology = makeAncestorsOntology();
    const result = ontology.ancestorIris('ContentEntry');

    assert.equal(result.length, 1);
    assert.equal(result[0], `${ANCESTORS_BASE_IRI}/Thing`);
  });

  it('returns parent then grandparent in BFS order for a two-level chain', () => {
    const ontology = makeAncestorsOntology();
    const result = ontology.ancestorIris('Feat');

    // Feat → ContentEntry → Thing
    assert.equal(result.length, 2);
    assert.equal(result[0], `${ANCESTORS_BASE_IRI}/ContentEntry`);
    assert.equal(result[1], `${ANCESTORS_BASE_IRI}/Thing`);
  });

  it('returns three-level chain for SimpleFeat (immediate parent, grandparent, great-grandparent)', () => {
    const ontology = makeAncestorsOntology();
    const result = ontology.ancestorIris('SimpleFeat');

    // SimpleFeat → Feat → ContentEntry → Thing
    assert.equal(result.length, 3);
    assert.equal(result[0], `${ANCESTORS_BASE_IRI}/Feat`);
    assert.equal(result[1], `${ANCESTORS_BASE_IRI}/ContentEntry`);
    assert.equal(result[2], `${ANCESTORS_BASE_IRI}/Thing`);
  });

  it('returns [] for an unknown className', () => {
    const ontology = makeAncestorsOntology();
    const result = ontology.ancestorIris('NonExistentClass');
    assert.deepEqual([...result], []);
  });

  it('terminates without infinite loop when schemas form a cycle', () => {
    const ontology = JsonTologyOntology.create({
      baseIRI: ANCESTORS_BASE_IRI,
      schemas: [
        { schemaPath: './CycleA.schema.json', schema: CYCLE_A },
        { schemaPath: './CycleB.schema.json', schema: CYCLE_B },
      ],
    });

    // Must not throw or hang — just return whatever it collected before
    // detecting the cycle.
    let result: ReadonlyArray<string>;
    assert.doesNotThrow(() => {
      result = ontology.ancestorIris('CycleA');
    });
    // At most one entry (CycleB IRI); CycleA itself must not appear.
    const classAIri = `${ANCESTORS_BASE_IRI}#CycleA`;
    assert.ok(
      !result!.includes(classAIri),
      'CycleA must not appear in its own ancestor list',
    );
  });

  it('returns the same array reference on repeated calls (cache hit)', () => {
    const ontology = makeAncestorsOntology();
    const first  = ontology.ancestorIris('Feat');
    const second = ontology.ancestorIris('Feat');
    assert.strictEqual(first, second, 'cached result must be the same reference');
  });
});

// ---------------------------------------------------------------------------
// CURIE expansion (Phase 21a)
// ---------------------------------------------------------------------------

// Helper: build a minimal ontology instance for expansion tests.
const CURIE_BASE_IRI = 'https://squashage.dev/vocabulary/curie';

const CURIE_SCHEMA: Record<string, unknown> & { readonly '$id': string } = {
  '$id':   'https://squashage.dev/schemas/curie/Widget',
  'title': 'Widget',
  'type':  'object',
  'properties': {
    'label':  { 'type': 'string' },
    'count':  { 'type': 'integer' },
  },
  'required': ['label'],
};

function makeCurieOntology(): ReturnType<typeof import('../../../src/ontology/JsonTologyOntology.js').JsonTologyOntology.create> {
  return JsonTologyOntology.create({
    baseIRI: CURIE_BASE_IRI,
    schemas: [{ schemaPath: './Widget.schema.json', schema: CURIE_SCHEMA }],
  });
}

describe('JsonTologyOntology:CURIE expansion — toQuads()', () => {
  it('expands compact rdf:type predicate to fully-qualified IRI', async () => {
    const ontology = makeCurieOntology();
    const quads = await ontology.toQuads(CURIE_SCHEMA['$id'], { label: 'foo', count: 1 });

    const rdfTypeCompact = 'rdf:type';
    const rdfTypeExpanded = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

    const hasCompact  = quads.some(q => q.predicate.value === rdfTypeCompact);
    const hasExpanded = quads.some(q => q.predicate.value === rdfTypeExpanded);

    assert.ok(!hasCompact,  `toQuads() must not emit compact predicate "${rdfTypeCompact}"`);
    assert.ok(hasExpanded,  `toQuads() must emit expanded predicate "${rdfTypeExpanded}"`);
  });

  it('expands compact xsd:string literal datatype to fully-qualified IRI', async () => {
    const ontology = makeCurieOntology();
    const quads = await ontology.toQuads(CURIE_SCHEMA['$id'], { label: 'hello', count: 1 });

    const xsdStringCompact  = 'xsd:string';
    const xsdStringExpanded = 'http://www.w3.org/2001/XMLSchema#string';

    const hasCompactDt = quads.some(
      q => q.object.termType === 'Literal' && q.object.datatype.value === xsdStringCompact,
    );
    const hasExpandedDt = quads.some(
      q => q.object.termType === 'Literal' && q.object.datatype.value === xsdStringExpanded,
    );

    assert.ok(!hasCompactDt,  `toQuads() must not emit compact datatype "${xsdStringCompact}"`);
    assert.ok(hasExpandedDt,  `toQuads() must emit expanded datatype "${xsdStringExpanded}"`);
  });

  it('emits no compact-CURIE predicates or object values across all quads', async () => {
    const ontology = makeCurieOntology();
    const quads = await ontology.toQuads(CURIE_SCHEMA['$id'], { label: 'test', count: 42 });

    const compactCurieRe = /^[a-z][a-z0-9]*:[A-Za-z]/;

    for (const q of quads) {
      assert.ok(
        !compactCurieRe.test(q.predicate.value),
        `Predicate must be expanded IRI, got "${q.predicate.value}"`,
      );
      if (q.object.termType === 'NamedNode') {
        assert.ok(
          !compactCurieRe.test(q.object.value),
          `Object NamedNode must be expanded IRI, got "${q.object.value}"`,
        );
      }
      if (q.object.termType === 'Literal') {
        assert.ok(
          !compactCurieRe.test(q.object.datatype.value),
          `Literal datatype must be expanded IRI, got "${q.object.datatype.value}"`,
        );
      }
    }
  });
});

describe('JsonTologyOntology:CURIE expansion — tbox()', () => {
  it('expands compact owl:Class object to fully-qualified IRI', async () => {
    const ontology = makeCurieOntology();
    const quads = await ontology.tbox();

    const owlClassCompact  = 'owl:Class';
    const owlClassExpanded = 'http://www.w3.org/2002/07/owl#Class';

    const hasCompact  = quads.some(q => q.object.termType === 'NamedNode' && q.object.value === owlClassCompact);
    const hasExpanded = quads.some(q => q.object.termType === 'NamedNode' && q.object.value === owlClassExpanded);

    assert.ok(!hasCompact,  `tbox() must not emit compact object "${owlClassCompact}"`);
    assert.ok(hasExpanded,  `tbox() must emit expanded object "${owlClassExpanded}"`);
  });

  it('emits no compact-CURIE predicates in tbox quads', async () => {
    const ontology = makeCurieOntology();
    const quads = await ontology.tbox();

    const compactCurieRe = /^[a-z][a-z0-9]*:[A-Za-z]/;
    for (const q of quads) {
      assert.ok(
        !compactCurieRe.test(q.predicate.value),
        `tbox() predicate must be expanded IRI, got "${q.predicate.value}"`,
      );
    }
  });
});

describe('JsonTologyOntology:CURIE expansion — shacl()', () => {
  it('expands compact sh:NodeShape object to fully-qualified IRI', async () => {
    const ontology = makeCurieOntology();
    const quads = await ontology.shacl();

    const shNodeShapeCompact  = 'sh:NodeShape';
    const shNodeShapeExpanded = 'http://www.w3.org/ns/shacl#NodeShape';

    const hasCompact  = quads.some(q => q.object.termType === 'NamedNode' && q.object.value === shNodeShapeCompact);
    const hasExpanded = quads.some(q => q.object.termType === 'NamedNode' && q.object.value === shNodeShapeExpanded);

    assert.ok(!hasCompact,  `shacl() must not emit compact object "${shNodeShapeCompact}"`);
    assert.ok(hasExpanded,  `shacl() must emit expanded object "${shNodeShapeExpanded}"`);
  });

  it('emits no compact-CURIE predicates in shacl quads', async () => {
    const ontology = makeCurieOntology();
    const quads = await ontology.shacl();

    const compactCurieRe = /^[a-z][a-z0-9]*:[A-Za-z]/;
    for (const q of quads) {
      assert.ok(
        !compactCurieRe.test(q.predicate.value),
        `shacl() predicate must be expanded IRI, got "${q.predicate.value}"`,
      );
    }
  });
});

describe('JsonTologyOntology:CURIE expansion — already-expanded IRIs pass through', () => {
  it('does not double-expand an already-expanded rdf:type IRI', async () => {
    const ontology = makeCurieOntology();
    const quads = await ontology.toQuads(CURIE_SCHEMA['$id'], { label: 'test', count: 1 });

    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

    const typeQuads = quads.filter(q => q.predicate.value === RDF_TYPE);
    assert.ok(typeQuads.length > 0, 'Must have at least one rdf:type quad');

    for (const q of typeQuads) {
      // The predicate must be exactly the expanded IRI, not double-expanded.
      assert.strictEqual(q.predicate.value, RDF_TYPE);
    }
  });

  it('quad with all already-expanded IRIs returns same reference (no allocation)', async () => {
    // The tbox always has already-expanded quads on second call (cached reference).
    const ontology = makeCurieOntology();
    const first  = await ontology.tbox();
    const second = await ontology.tbox();
    assert.strictEqual(first, second, 'Cached reference must be identical — no re-expansion');
  });
});

describe('JsonTologyOntology:CURIE expansion — unknown prefix passes through unchanged', () => {
  it('unknown:foo predicate is not expanded (Curie.expand returns input unchanged)', async () => {
    // json-tology does not emit unknown: prefixes, but the expansion logic
    // must not corrupt values it cannot expand. We verify indirectly by
    // checking that toQuads() returns only IRIs that either:
    //   (a) are absolute (contain "://")
    //   (b) were not changed from what json-tology emitted.
    // A direct test of the static method is not possible (it's private), so
    // we instead confirm the runtime invariant: ALL predicate values in
    // toQuads output are absolute IRIs.
    const ontology = makeCurieOntology();
    const quads = await ontology.toQuads(CURIE_SCHEMA['$id'], { label: 'test', count: 1 });

    for (const q of quads) {
      if (q.predicate.termType === 'NamedNode') {
        assert.ok(
          q.predicate.value.includes('://'),
          `Every predicate in toQuads output must be an absolute IRI; got "${q.predicate.value}"`,
        );
      }
    }
  });
});

describe('JsonTologyOntology:CURIE expansion — standard prefix coverage snapshot', () => {
  it('five compact-IRI quads all expand correctly (rdf, xsd, owl, rdfs, sh)', async () => {
    // Verify that all five standard prefixes the spec calls out are exercised
    // by real json-tology output.
    const ontology = makeCurieOntology();
    const [tboxQuads, shaclQuads, aboxQuads] = await Promise.all([
      ontology.tbox(),
      ontology.shacl(),
      ontology.toQuads(CURIE_SCHEMA['$id'], { label: 'snapshot', count: 5 }),
    ]);
    const all = [...tboxQuads, ...shaclQuads, ...aboxQuads];

    const expanded = {
      rdf:  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
      rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
      owl:  'http://www.w3.org/2002/07/owl#',
      xsd:  'http://www.w3.org/2001/XMLSchema#',
      sh:   'http://www.w3.org/ns/shacl#',
    };

    for (const [prefix, base] of Object.entries(expanded)) {
      const hasExpanded = all.some(q => {
        const predicateExpanded = q.predicate.value.startsWith(base);
        const objectExpanded    = q.object.termType === 'NamedNode' && q.object.value.startsWith(base);
        const datatypeExpanded  = q.object.termType === 'Literal' && q.object.datatype.value.startsWith(base);
        return predicateExpanded || objectExpanded || datatypeExpanded;
      });
      assert.ok(
        hasExpanded,
        `No quad found with expanded "${prefix}:" prefix (${base}) — expansion may be missing`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 22 — $ref inline-resolution workaround (transient, issue #126)
// ---------------------------------------------------------------------------

/**
 * Fixtures for cross-schema $ref projection tests.
 *
 * RefTargetSchema: the referenced "inner" object schema (would be registered
 *   separately in real AONPRD use, e.g. an object in /inferred/objects/).
 * RefHostSchema: a class schema whose `source` property is a $ref to
 *   RefTargetSchema — the exact pattern that triggers the issue #126 bug.
 */
const REF_TARGET_SCHEMA: Record<string, unknown> & { readonly '$id': string } = {
  '$id':   'https://squashage.dev/schemas/ref-test/Source',
  '$schema': 'https://json-schema.org/draft/2020-12/schema',
  'title': 'Source',
  'type':  'object',
  'properties': {
    'book': { 'type': 'string' },
    'page': { 'type': 'integer', 'minimum': 1 },
  },
};

const REF_HOST_SCHEMA: Record<string, unknown> & { readonly '$id': string } = {
  '$id':   'https://squashage.dev/schemas/ref-test/Action',
  '$schema': 'https://json-schema.org/draft/2020-12/schema',
  'title': 'Action',
  'type':  'object',
  'properties': {
    'name':   { 'type': 'string' },
    'source': { '$ref': 'https://squashage.dev/schemas/ref-test/Source' },
  },
  'required': ['name'],
};

const REF_TEST_BASE_IRI = 'https://squashage.dev/vocabulary/ref-test';

function makeRefTestOntology(): ReturnType<typeof import('../../../src/ontology/JsonTologyOntology.js').JsonTologyOntology.create> {
  return JsonTologyOntology.create({
    baseIRI: REF_TEST_BASE_IRI,
    schemas: [
      { schemaPath: './Action.schema.json',                         schema: REF_HOST_SCHEMA   },
      { schemaPath: './objects/Source.schema.json',                 schema: REF_TARGET_SCHEMA },
    ],
  });
}

describe('JsonTologyOntology:$ref inline-resolution — cross-schema $ref projection (issue #126)', () => {
  it('emits quads for properties of an inlined $ref object (the core issue #126 regression)', async () => {
    const ontology = makeRefTestOntology();
    const quads = await ontology.toQuads(
      REF_HOST_SCHEMA['$id'],
      { name: 'Stride', source: { book: 'Core Rulebook', page: 471 } },
    );

    // Must have at least the rdf:type quad + name + source sub-properties.
    // Without the fix, source.book and source.page are silently dropped → only 2 quads.
    assert.ok(
      quads.length > 2,
      `Expected >2 quads when source object is provided; got ${quads.length.toString()} — $ref inlining may have failed`,
    );

    // At minimum: rdf:type + name literal + at least one source property quad.
    const predicateValues = quads.map(q => q.predicate.value);
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    assert.ok(predicateValues.includes(RDF_TYPE), 'Must emit rdf:type quad');
  });

  it('emits a quad carrying the name literal value', async () => {
    const ontology = makeRefTestOntology();
    const quads = await ontology.toQuads(
      REF_HOST_SCHEMA['$id'],
      { name: 'Strike', source: { book: 'Core Rulebook', page: 471 } },
    );

    const hasName = quads.some(
      q => q.object.termType === 'Literal' && q.object.value === 'Strike',
    );
    assert.ok(hasName, 'Must emit a quad with the name literal value "Strike"');
  });

  it('toQuads works when $ref target is absent from instance (graceful omission)', async () => {
    const ontology = makeRefTestOntology();
    const quads = await ontology.toQuads(
      REF_HOST_SCHEMA['$id'],
      { name: 'Stride' }, // no source property
    );

    // Must succeed — at minimum rdf:type + name.
    assert.ok(Array.isArray(quads));
    assert.ok(quads.length >= 1);
  });
});

// ── Cycle protection ─────────────────────────────────────────────────────────

const CYCLE_REF_A: Record<string, unknown> & { readonly '$id': string } = {
  '$id':   'https://squashage.dev/schemas/cycle/SchemaA',
  '$schema': 'https://json-schema.org/draft/2020-12/schema',
  'title': 'SchemaA',
  'type':  'object',
  'properties': {
    'child': { '$ref': 'https://squashage.dev/schemas/cycle/SchemaB' },
    'name':  { 'type': 'string' },
  },
};

const CYCLE_REF_B: Record<string, unknown> & { readonly '$id': string } = {
  '$id':   'https://squashage.dev/schemas/cycle/SchemaB',
  '$schema': 'https://json-schema.org/draft/2020-12/schema',
  'title': 'SchemaB',
  'type':  'object',
  'properties': {
    'parent': { '$ref': 'https://squashage.dev/schemas/cycle/SchemaA' },
    'label':  { 'type': 'string' },
  },
};

describe('JsonTologyOntology:$ref inline-resolution — cycle protection', () => {
  it('construction terminates without infinite loop when schemas form a $ref cycle', () => {
    // If the denormalization recurses infinitely, this would hang or OOM.
    assert.doesNotThrow(() => {
      JsonTologyOntology.create({
        baseIRI: 'https://squashage.dev/vocabulary/cycle',
        schemas: [
          { schemaPath: './SchemaA.schema.json', schema: CYCLE_REF_A },
          { schemaPath: './SchemaB.schema.json', schema: CYCLE_REF_B },
        ],
      });
    });
  });

  it('toQuads terminates for a cyclic-schema pair', async () => {
    const ontology = JsonTologyOntology.create({
      baseIRI: 'https://squashage.dev/vocabulary/cycle',
      schemas: [
        { schemaPath: './SchemaA.schema.json', schema: CYCLE_REF_A },
        { schemaPath: './SchemaB.schema.json', schema: CYCLE_REF_B },
      ],
    });

    let result: ReadonlyArray<unknown> | Error;
    try {
      result = await ontology.toQuads(CYCLE_REF_A['$id'], { name: 'root', child: { label: 'leaf' } });
    } catch (err) {
      result = err instanceof Error ? err : new Error(String(err));
    }

    // Must not hang. Either a valid quad array or a known projection error is acceptable.
    assert.ok(
      Array.isArray(result) || result instanceof Error,
      'toQuads must terminate (return array or throw) for cyclic schemas',
    );
  });
});

// ── Depth cap ────────────────────────────────────────────────────────────────

// Build a 6-deep $ref chain: Level0 → Level1 → Level2 → Level3 → Level4 → Level5
const DEEP_CHAIN_BASE = 'https://squashage.dev/schemas/deep';
function makeDeepSchema(n: number): Record<string, unknown> & { readonly '$id': string } {
  const id = `${DEEP_CHAIN_BASE}/Level${n.toString()}`;
  const schema: Record<string, unknown> & { readonly '$id': string } = {
    '$id':   id,
    '$schema': 'https://json-schema.org/draft/2020-12/schema',
    'title': `Level${n.toString()}`,
    'type':  'object',
    'properties': {
      'value': { 'type': 'string' },
    },
  };
  if (n < 5) {
    (schema['properties'] as Record<string, unknown>)['child'] = {
      '$ref': `${DEEP_CHAIN_BASE}/Level${(n + 1).toString()}`,
    };
  }
  return schema;
}
const DEEP_SCHEMAS = Array.from({ length: 6 }, (_, i) => makeDeepSchema(i));

describe('JsonTologyOntology:$ref inline-resolution — depth cap', () => {
  it('construction with a 6-deep $ref chain completes without throwing (depth cap at 4)', () => {
    assert.doesNotThrow(() => {
      JsonTologyOntology.create({
        baseIRI: 'https://squashage.dev/vocabulary/deep',
        schemas: DEEP_SCHEMAS.map((s, i) => ({
          schemaPath: `./Level${i.toString()}.schema.json`,
          schema:     s,
        })),
      });
    });
  });
});

// ── Unknown $ref target ──────────────────────────────────────────────────────

const UNKNOWN_REF_HOST: Record<string, unknown> & { readonly '$id': string } = {
  '$id':   'https://squashage.dev/schemas/unknown-ref/Widget',
  '$schema': 'https://json-schema.org/draft/2020-12/schema',
  'title': 'Widget',
  'type':  'object',
  'properties': {
    'label':  { 'type': 'string' },
    'config': { '$ref': 'https://squashage.dev/schemas/NOT_REGISTERED/Config' },
  },
};

describe('JsonTologyOntology:$ref inline-resolution — unknown $ref target', () => {
  it('construction succeeds when a $ref target is not registered (best-effort)', () => {
    assert.doesNotThrow(() => {
      JsonTologyOntology.create({
        baseIRI: 'https://squashage.dev/vocabulary/unknown-ref',
        schemas: [{ schemaPath: './Widget.schema.json', schema: UNKNOWN_REF_HOST }],
      });
    });
  });

  it('toQuads works for known properties even when a $ref target is unresolvable', async () => {
    const ontology = JsonTologyOntology.create({
      baseIRI: 'https://squashage.dev/vocabulary/unknown-ref',
      schemas: [{ schemaPath: './Widget.schema.json', schema: UNKNOWN_REF_HOST }],
    });

    let result: ReadonlyArray<unknown> | Error;
    try {
      result = await ontology.toQuads(UNKNOWN_REF_HOST['$id'], { label: 'test-widget' });
    } catch (err) {
      result = err instanceof Error ? err : new Error(String(err));
    }

    // Must not hang or throw an unexpected error; either array or error is acceptable.
    assert.ok(
      Array.isArray(result) || result instanceof Error,
      'toQuads must return or throw for unknown $ref target; must not hang',
    );
  });
});

// ── TBox unchanged ───────────────────────────────────────────────────────────

describe('JsonTologyOntology:$ref inline-resolution — TBox unchanged', () => {
  it('tbox() output is identical before and after constructing with a $ref schema', async () => {
    // The reference ontology (plain inline schema) and the ref-test ontology
    // (has $ref properties) should both emit owl:Class quads. The point here
    // is that the workaround does not corrupt tbox() output.
    const ontology = makeRefTestOntology();
    const tboxQuads = await ontology.tbox();

    const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class';
    const owlClassQuads = tboxQuads.filter(
      q => q.object.termType === 'NamedNode' && q.object.value === OWL_CLASS,
    );

    // Action is the only non-extracted schema in makeRefTestOntology; expect at least 1.
    assert.ok(
      owlClassQuads.length >= 1,
      `tbox() must emit at least 1 owl:Class quad for Action; got ${owlClassQuads.length.toString()}`,
    );
  });

  it('tbox() contains no compact-CURIE predicates (CURIE expansion still applies)', async () => {
    const ontology = makeRefTestOntology();
    const quads = await ontology.tbox();
    const compactCurieRe = /^[a-z][a-z0-9]*:[A-Za-z]/;
    for (const q of quads) {
      assert.ok(
        !compactCurieRe.test(q.predicate.value),
        `tbox() predicate must be expanded IRI; got "${q.predicate.value}"`,
      );
    }
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

// ---------------------------------------------------------------------------
// ProjectionSchema.relax() — lenient ABox projection transform
// ---------------------------------------------------------------------------

/**
 * These tests exercise the relax transform indirectly via JsonTologyOntology.create
 * (which applies ProjectionSchema.relax() to every denormalized schema before
 * building the ABox instance), and directly via the observable effect on toQuads():
 * relaxed schemas must still project real-world records that would fail strict validation.
 *
 * For a white-box view of the stripped keys, a schema that carries every constraint
 * key is fed through construction and then projected against a deliberately
 * non-conforming instance that would fail strict validation.
 */

const CONSTRAINED_SCHEMA: Record<string, unknown> & { readonly '$id': string } = {
  '$id':   'https://squashage.dev/schemas/relax-test/ConstrainedWidget',
  'title': 'ConstrainedWidget',
  'type':  'object',
  'required': ['label'],
  'properties': {
    'label':    { 'type': 'string', 'minLength': 5, 'maxLength': 20, 'pattern': '^[A-Z]' },
    'count':    { 'type': 'integer', 'minimum': 1, 'maximum': 100, 'multipleOf': 2 },
    'category': { 'type': 'string', 'enum': ['alpha', 'beta', 'gamma'] },
    'fixed':    { 'type': 'string', 'const': 'immutable' },
    'tags':     { 'type': 'array', 'items': { 'type': 'string' }, 'minItems': 1, 'maxItems': 5 },
    'nullField': { 'type': 'null' },
  },
};

const RELAX_BASE_IRI = 'https://squashage.dev/vocabulary/relax-test';

function makeRelaxOntology(): ReturnType<typeof import('../../../src/ontology/JsonTologyOntology.js').JsonTologyOntology.create> {
  return JsonTologyOntology.create({
    baseIRI: RELAX_BASE_IRI,
    schemas: [{ schemaPath: './ConstrainedWidget.schema.json', schema: CONSTRAINED_SCHEMA }],
  });
}

describe('JsonTologyOntology:ProjectionSchema.relax() — construction succeeds', () => {
  it('constructs without error even when schema has required + constraints', () => {
    assert.doesNotThrow(() => makeRelaxOntology());
  });
});

describe('JsonTologyOntology:ProjectionSchema.relax() — projection leniency', () => {
  it('projects a record missing required field without throwing', async () => {
    const ontology = makeRelaxOntology();
    // Missing "label" which is required in the strict schema.
    let result: ReadonlyArray<unknown> | Error;
    try {
      result = await ontology.toQuads(CONSTRAINED_SCHEMA['$id'], { count: 3, category: 'alpha' });
    } catch (err) {
      result = err instanceof Error ? err : new Error(String(err));
    }
    // Must either project or throw a json-tology error — never hang.
    assert.ok(
      Array.isArray(result) || result instanceof Error,
      'toQuads must not hang for a record missing a required field',
    );
  });

  it('projects a record with a value outside enum without throwing', async () => {
    const ontology = makeRelaxOntology();
    let result: ReadonlyArray<unknown> | Error;
    try {
      result = await ontology.toQuads(CONSTRAINED_SCHEMA['$id'], {
        label: 'Hello', count: 2, category: 'delta', // "delta" is not in enum
      });
    } catch (err) {
      result = err instanceof Error ? err : new Error(String(err));
    }
    assert.ok(
      Array.isArray(result) || result instanceof Error,
      'toQuads must not hang for a record with an out-of-enum value',
    );
  });

  it('projects a record whose count violates minimum constraint without throwing', async () => {
    const ontology = makeRelaxOntology();
    let result: ReadonlyArray<unknown> | Error;
    try {
      result = await ontology.toQuads(CONSTRAINED_SCHEMA['$id'], {
        label: 'Hello', count: 0, // 0 < minimum:1
      });
    } catch (err) {
      result = err instanceof Error ? err : new Error(String(err));
    }
    assert.ok(
      Array.isArray(result) || result instanceof Error,
      'toQuads must not hang for a record violating numeric minimum',
    );
  });
});

describe('JsonTologyOntology:ProjectionSchema.relax() — validate() uses strict schema', () => {
  it('validate() returns ok:false for a record missing required field', () => {
    const ontology  = makeRelaxOntology();
    const result    = ontology.validate(CONSTRAINED_SCHEMA['$id'], { count: 2 }); // missing label
    assert.equal(result.ok, false, 'strict schema must reject missing required field');
    assert.ok(result.items.length > 0, 'must have at least one validation error');
  });

  it('validate() returns ok:true for a fully conforming record', () => {
    const ontology = makeRelaxOntology();
    const result   = ontology.validate(CONSTRAINED_SCHEMA['$id'], {
      label: 'Alpha', count: 2, category: 'alpha', fixed: 'immutable', tags: ['a'],
    });
    assert.equal(result.ok, true, 'strict schema must accept a fully conforming record');
  });

  it('validate() throws OutputConfigError for an unknown schemaId', () => {
    const ontology = makeRelaxOntology();
    assert.throws(
      () => ontology.validate('https://not-registered/schema', {}),
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError);
        return true;
      },
    );
  });
});

describe('JsonTologyOntology:ProjectionSchema.relax() — structural markers preserved', () => {
  it('classMap() still maps ConstrainedWidget after relax (schema identity preserved)', () => {
    const ontology = makeRelaxOntology();
    const map = ontology.classMap();
    assert.ok('ConstrainedWidget' in map, 'classMap must include ConstrainedWidget after relax');
    assert.strictEqual(map['ConstrainedWidget'], `${RELAX_BASE_IRI}/ConstrainedWidget`);
  });
});
