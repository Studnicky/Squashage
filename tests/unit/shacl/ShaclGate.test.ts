/**
 * Unit tests for src/shacl/ShaclGate.ts.
 *
 * Builds minimal SHACL shape and data graphs by hand using the RDF/JS
 * DataFactory so there is no dependency on an RDF parser in unit tests.
 *
 * Fixtures:
 *   - shapes: a NodeShape targeting ex:Person requiring sh:minCount 1 on ex:name
 *   - conforming data: an ex:Person instance with an ex:name triple
 *   - non-conforming data: an ex:Person instance without ex:name
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Dataset } from '../../../src/rdf/Dataset.js';
import { dataFactory } from '../../../src/rdf/DataFactory.js';
import { ShaclGate } from '../../../src/shacl/ShaclGate.js';
import type { ShaclResultInterface } from '../../../src/types/ShaclResult.js';

// ---------------------------------------------------------------------------
// Shared IRIs
// ---------------------------------------------------------------------------

const RDF_TYPE    = dataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
const XSD_INT     = dataFactory.namedNode('http://www.w3.org/2001/XMLSchema#integer');

const SH_NODE_SHAPE         = dataFactory.namedNode('http://www.w3.org/ns/shacl#NodeShape');
const SH_TARGET_CLASS       = dataFactory.namedNode('http://www.w3.org/ns/shacl#targetClass');
const SH_PROPERTY           = dataFactory.namedNode('http://www.w3.org/ns/shacl#property');
const SH_PATH               = dataFactory.namedNode('http://www.w3.org/ns/shacl#path');
const SH_MIN_COUNT          = dataFactory.namedNode('http://www.w3.org/ns/shacl#minCount');

const EX_PERSON_SHAPE = dataFactory.namedNode('http://example.org/shapes/PersonShape');
const EX_PROP_NODE    = dataFactory.blankNode('prop1');
const EX_PERSON_CLASS = dataFactory.namedNode('http://example.org/Person');
const EX_NAME         = dataFactory.namedNode('http://example.org/name');
const EX_ALICE        = dataFactory.namedNode('http://example.org/Alice');

const DG = dataFactory.defaultGraph();

// ---------------------------------------------------------------------------
// Fixture: SHACL shapes graph
//
//   ex:PersonShape a sh:NodeShape ;
//     sh:targetClass ex:Person ;
//     sh:property [
//       sh:path ex:name ;
//       sh:minCount 1 ;
//     ] .
// ---------------------------------------------------------------------------

const shapeQuads = [
  dataFactory.quad(EX_PERSON_SHAPE, RDF_TYPE,          SH_NODE_SHAPE,         DG),
  dataFactory.quad(EX_PERSON_SHAPE, SH_TARGET_CLASS,   EX_PERSON_CLASS,       DG),
  dataFactory.quad(EX_PERSON_SHAPE, SH_PROPERTY,       EX_PROP_NODE,          DG),
  dataFactory.quad(EX_PROP_NODE,    SH_PATH,            EX_NAME,               DG),
  dataFactory.quad(EX_PROP_NODE,    SH_MIN_COUNT,
    dataFactory.literal('1', XSD_INT),                                         DG),
];

// Fixture: conforming data — Alice is a Person and has a name
const conformingQuads = [
  dataFactory.quad(EX_ALICE, RDF_TYPE, EX_PERSON_CLASS,                        DG),
  dataFactory.quad(EX_ALICE, EX_NAME,  dataFactory.literal('Alice'),            DG),
];

// Fixture: non-conforming data — Alice is a Person but has no name
const nonConformingQuads = [
  dataFactory.quad(EX_ALICE, RDF_TYPE, EX_PERSON_CLASS,                        DG),
];

// ---------------------------------------------------------------------------
// ShaclGate.run
// ---------------------------------------------------------------------------

describe('ShaclGate.run', () => {
  describe('conforming data', () => {
    it('report.conforms is true', async () => {
      const shapes = Dataset.from(shapeQuads);
      const data   = Dataset.from(conformingQuads);
      const report = await ShaclGate.run(shapes, data);
      assert.equal(report.conforms, true);
    });

    it('report.results is empty', async () => {
      const shapes = Dataset.from(shapeQuads);
      const data   = Dataset.from(conformingQuads);
      const report = await ShaclGate.run(shapes, data);
      assert.equal(report.results.length, 0);
    });

    it('report.reportDataset is a DatasetCore (has .size and .match)', async () => {
      const shapes = Dataset.from(shapeQuads);
      const data   = Dataset.from(conformingQuads);
      const report = await ShaclGate.run(shapes, data);
      assert.equal(typeof report.reportDataset.size, 'number');
      assert.equal(typeof report.reportDataset.match, 'function');
    });
  });

  describe('non-conforming data', () => {
    it('report.conforms is false', async () => {
      const shapes = Dataset.from(shapeQuads);
      const data   = Dataset.from(nonConformingQuads);
      const report = await ShaclGate.run(shapes, data);
      assert.equal(report.conforms, false);
    });

    it('report.results has at least one entry', async () => {
      const shapes = Dataset.from(shapeQuads);
      const data   = Dataset.from(nonConformingQuads);
      const report = await ShaclGate.run(shapes, data);
      assert.equal(report.results.length >= 1, true);
    });

    it('each result entry carries a severity value string', async () => {
      const shapes = Dataset.from(shapeQuads);
      const data   = Dataset.from(nonConformingQuads);
      const report = await ShaclGate.run(shapes, data);
      const first  = report.results[0] as ShaclResultInterface;
      assert.equal(typeof first?.severity?.value, 'string');
    });

    it('each result entry carries a focusNode matching Alice', async () => {
      const shapes = Dataset.from(shapeQuads);
      const data   = Dataset.from(nonConformingQuads);
      const report = await ShaclGate.run(shapes, data);
      const first  = report.results[0] as ShaclResultInterface;
      assert.equal(first?.focusNode?.value, 'http://example.org/Alice');
    });

    it('report.reportDataset is non-empty (ValidationReport triples present)', async () => {
      const shapes = Dataset.from(shapeQuads);
      const data   = Dataset.from(nonConformingQuads);
      const report = await ShaclGate.run(shapes, data);
      assert.equal(report.reportDataset.size > 0, true);
    });
  });
});

// ---------------------------------------------------------------------------
// ShaclGate.formatReport
// ---------------------------------------------------------------------------

describe('ShaclGate.formatReport', () => {
  it('returns empty string for a conforming report with no results', () => {
    const text = ShaclGate.formatReport({ results: [] });
    assert.equal(text, '');
  });

  it('renders one line per result', () => {
    const synthetic: ReadonlyArray<ShaclResultInterface> = [
      {
        severity:  { value: 'http://www.w3.org/ns/shacl#Violation' },
        focusNode: { value: 'http://example.org/Alice' },
        path:      { value: 'http://example.org/name' },
        message:   [{ value: 'Less than 1 values' }],
      },
      {
        severity:  { value: 'http://www.w3.org/ns/shacl#Warning' },
        focusNode: { value: 'http://example.org/Bob' },
      },
    ];
    const lines = ShaclGate.formatReport({ results: synthetic }).split('\n');
    assert.equal(lines.length, 2);
  });

  it('line format is [severity] focusNode path → message', () => {
    const synthetic: ReadonlyArray<ShaclResultInterface> = [
      {
        severity:  { value: 'http://www.w3.org/ns/shacl#Violation' },
        focusNode: { value: 'http://example.org/Alice' },
        path:      { value: 'http://example.org/name' },
        message:   [{ value: 'Less than 1 values' }],
      },
    ];
    const text = ShaclGate.formatReport({ results: synthetic });
    assert.match(text, /^\[http:\/\/www\.w3\.org\/ns\/shacl#Violation\]/);
    assert.match(text, /http:\/\/example\.org\/Alice/);
    assert.match(text, /http:\/\/example\.org\/name/);
    assert.match(text, /→ Less than 1 values/);
  });

  it('gracefully omits undefined path and message without throwing', () => {
    const synthetic: ReadonlyArray<ShaclResultInterface> = [
      {
        severity:  { value: 'http://www.w3.org/ns/shacl#Violation' },
        focusNode: { value: 'http://example.org/Bob' },
      },
    ];
    assert.doesNotThrow(() => ShaclGate.formatReport({ results: synthetic }));
    const text = ShaclGate.formatReport({ results: synthetic });
    assert.match(text, /\[http:\/\/www\.w3\.org\/ns\/shacl#Violation\]/);
    assert.match(text, /→/);
  });

  it('integration: formats results from a real non-conforming run', async () => {
    const shapes = Dataset.from(shapeQuads);
    const data   = Dataset.from(nonConformingQuads);
    const report = await ShaclGate.run(shapes, data);
    assert.equal(report.conforms, false);
    const text = ShaclGate.formatReport(report);
    assert.equal(typeof text, 'string');
    assert.equal(text.length > 0, true);
    assert.match(text, /→/);
  });
});
