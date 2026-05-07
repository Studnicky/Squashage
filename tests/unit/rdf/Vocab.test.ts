/**
 * Unit tests for src/rdf/Vocab.ts.
 *
 * Each vocabulary builder is tested by resolving a well-known term and
 * asserting the full IRI value.  The STANDARD_PREFIXES table is tested for
 * correct IRI values and immutability.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RDF,
  RDFS,
  OWL,
  XSD,
  SHACL,
  STANDARD_PREFIXES,
} from '../../../src/rdf/Vocab.js';

// ---------------------------------------------------------------------------
// RDF
// ---------------------------------------------------------------------------

describe('RDF', () => {
  it('RDF.type resolves to the correct IRI', () => {
    assert.equal(
      RDF.type.value,
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    );
  });

  it('RDF.Property resolves to the correct IRI', () => {
    assert.equal(
      RDF.Property.value,
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property',
    );
  });

  it('RDF.nil resolves to the correct IRI', () => {
    assert.equal(
      RDF.nil.value,
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil',
    );
  });
});

// ---------------------------------------------------------------------------
// RDFS
// ---------------------------------------------------------------------------

describe('RDFS', () => {
  it('RDFS.label resolves to the correct IRI', () => {
    assert.equal(
      RDFS.label.value,
      'http://www.w3.org/2000/01/rdf-schema#label',
    );
  });

  it('RDFS.Class resolves to the correct IRI', () => {
    assert.equal(
      RDFS.Class.value,
      'http://www.w3.org/2000/01/rdf-schema#Class',
    );
  });

  it('RDFS.subClassOf resolves to the correct IRI', () => {
    assert.equal(
      RDFS.subClassOf.value,
      'http://www.w3.org/2000/01/rdf-schema#subClassOf',
    );
  });
});

// ---------------------------------------------------------------------------
// OWL
// ---------------------------------------------------------------------------

describe('OWL', () => {
  it('OWL.Class resolves to the correct IRI', () => {
    assert.equal(
      OWL.Class.value,
      'http://www.w3.org/2002/07/owl#Class',
    );
  });

  it('OWL.ObjectProperty resolves to the correct IRI', () => {
    assert.equal(
      OWL.ObjectProperty.value,
      'http://www.w3.org/2002/07/owl#ObjectProperty',
    );
  });

  it('OWL.sameAs resolves to the correct IRI', () => {
    assert.equal(
      OWL.sameAs.value,
      'http://www.w3.org/2002/07/owl#sameAs',
    );
  });
});

// ---------------------------------------------------------------------------
// XSD
// ---------------------------------------------------------------------------

describe('XSD', () => {
  it('XSD.string resolves to the correct IRI', () => {
    assert.equal(
      XSD.string.value,
      'http://www.w3.org/2001/XMLSchema#string',
    );
  });

  it('XSD.integer resolves to the correct IRI', () => {
    assert.equal(
      XSD.integer.value,
      'http://www.w3.org/2001/XMLSchema#integer',
    );
  });

  it('XSD.boolean resolves to the correct IRI', () => {
    assert.equal(
      XSD.boolean.value,
      'http://www.w3.org/2001/XMLSchema#boolean',
    );
  });
});

// ---------------------------------------------------------------------------
// SHACL
// ---------------------------------------------------------------------------

describe('SHACL', () => {
  it('SHACL.NodeShape resolves to the correct IRI', () => {
    assert.equal(
      SHACL.NodeShape.value,
      'http://www.w3.org/ns/shacl#NodeShape',
    );
  });

  it('SHACL.conforms resolves to the correct IRI', () => {
    assert.equal(
      SHACL.conforms.value,
      'http://www.w3.org/ns/shacl#conforms',
    );
  });

  it('SHACL.ValidationReport resolves to the correct IRI', () => {
    assert.equal(
      SHACL.ValidationReport.value,
      'http://www.w3.org/ns/shacl#ValidationReport',
    );
  });
});

// ---------------------------------------------------------------------------
// STANDARD_PREFIXES
// ---------------------------------------------------------------------------

describe('STANDARD_PREFIXES', () => {
  it('rdf prefix is correct', () => {
    assert.equal(
      STANDARD_PREFIXES.rdf,
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    );
  });

  it('rdfs prefix is correct', () => {
    assert.equal(
      STANDARD_PREFIXES.rdfs,
      'http://www.w3.org/2000/01/rdf-schema#',
    );
  });

  it('owl prefix is correct', () => {
    assert.equal(
      STANDARD_PREFIXES.owl,
      'http://www.w3.org/2002/07/owl#',
    );
  });

  it('xsd prefix is correct', () => {
    assert.equal(
      STANDARD_PREFIXES.xsd,
      'http://www.w3.org/2001/XMLSchema#',
    );
  });

  it('sh (SHACL) prefix is correct', () => {
    assert.equal(
      STANDARD_PREFIXES.sh,
      'http://www.w3.org/ns/shacl#',
    );
  });

  it('is frozen — Object.isFrozen returns true', () => {
    assert.equal(Object.isFrozen(STANDARD_PREFIXES), true);
  });

  it('is frozen — mutation throws in strict mode', () => {
    assert.throws(() => {
      // @ts-expect-error intentional mutation test
      (STANDARD_PREFIXES as Record<string, string>)['rdf'] = 'mutated';
    });
  });
});
