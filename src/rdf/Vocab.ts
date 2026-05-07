/**
 * @fileoverview Standard RDF vocabulary namespace builders for v0.x pipelines.
 *
 * This module exposes pre-built {@link NamespaceBuilder} constants for the five
 * core W3C vocabularies used throughout Squashage — RDF, RDFS, OWL, XSD, and
 * SHACL — together with a {@link STANDARD_PREFIXES} frozen prefix table that
 * mirrors the same five IRIs.
 *
 * All builders are constructed via {@link Namespaces.for} (the project wrapper
 * around `@rdfjs/namespace`).  Application code imports vocabulary terms from
 * here — never from `@rdfjs/namespace` or any external vocabulary package
 * directly.  The boundary is enforced by the `no-restricted-imports` ESLint
 * rule in `eslint.config.mjs`.
 *
 * `STANDARD_PREFIXES` is the canonical prefix table consumed by the serializer
 * (`src/rdf/Serializer.ts`).  A placeholder of the same name existed in
 * `src/rdf/Namespaces.ts` (W4); that export has been removed so this module is
 * the single source of truth.  The Namespaces test suite was updated to import
 * `STANDARD_PREFIXES` from here instead.
 *
 * @module rdf/Vocab
 * @since 0.1.0
 */

import { Namespaces, type NamespaceBuilder } from './Namespaces.js';

// ---------------------------------------------------------------------------
// Core vocabulary builders
// ---------------------------------------------------------------------------

/**
 * Namespace builder for the RDF Core vocabulary.
 *
 * @remarks
 * Base IRI: `http://www.w3.org/1999/02/22-rdf-syntax-ns#`
 *
 * Common terms: `RDF.type`, `RDF.Property`, `RDF.Statement`, `RDF.subject`,
 * `RDF.predicate`, `RDF.object`, `RDF.List`, `RDF.nil`, `RDF.first`,
 * `RDF.rest`, `RDF.langString`, `RDF.HTML`.
 *
 * @example
 * ```ts
 * import { RDF } from './Vocab.js';
 * RDF.type.value   // 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
 * RDF.Property.value // 'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property'
 * ```
 *
 * @category RDF
 * @since 0.1.0
 * @see {@link https://www.w3.org/TR/rdf-schema/ | RDF 1.1 Schema}
 * @group Vocab
 */
export const RDF: NamespaceBuilder = Namespaces.for('http://www.w3.org/1999/02/22-rdf-syntax-ns#');

/**
 * Namespace builder for the RDF Schema vocabulary.
 *
 * @remarks
 * Base IRI: `http://www.w3.org/2000/01/rdf-schema#`
 *
 * Common terms: `RDFS.label`, `RDFS.comment`, `RDFS.Class`, `RDFS.subClassOf`,
 * `RDFS.subPropertyOf`, `RDFS.domain`, `RDFS.range`, `RDFS.Resource`,
 * `RDFS.Literal`, `RDFS.seeAlso`, `RDFS.isDefinedBy`.
 *
 * @example
 * ```ts
 * import { RDFS } from './Vocab.js';
 * RDFS.label.value // 'http://www.w3.org/2000/01/rdf-schema#label'
 * RDFS.Class.value // 'http://www.w3.org/2000/01/rdf-schema#Class'
 * ```
 *
 * @category RDF
 * @since 0.1.0
 * @see {@link https://www.w3.org/TR/rdf-schema/ | RDF Schema 1.1}
 * @group Vocab
 */
export const RDFS: NamespaceBuilder = Namespaces.for('http://www.w3.org/2000/01/rdf-schema#');

/**
 * Namespace builder for the OWL Web Ontology Language vocabulary.
 *
 * @remarks
 * Base IRI: `http://www.w3.org/2002/07/owl#`
 *
 * Common terms: `OWL.Class`, `OWL.ObjectProperty`, `OWL.DatatypeProperty`,
 * `OWL.AnnotationProperty`, `OWL.Individual`, `OWL.Thing`, `OWL.Nothing`,
 * `OWL.Ontology`, `OWL.equivalentClass`, `OWL.equivalentProperty`,
 * `OWL.sameAs`, `OWL.differentFrom`, `OWL.inverseOf`.
 *
 * @example
 * ```ts
 * import { OWL } from './Vocab.js';
 * OWL.Class.value        // 'http://www.w3.org/2002/07/owl#Class'
 * OWL.ObjectProperty.value // 'http://www.w3.org/2002/07/owl#ObjectProperty'
 * ```
 *
 * @category RDF
 * @since 0.1.0
 * @see {@link https://www.w3.org/TR/owl2-overview/ | OWL 2 Web Ontology Language}
 * @group Vocab
 */
export const OWL: NamespaceBuilder = Namespaces.for('http://www.w3.org/2002/07/owl#');

/**
 * Namespace builder for the XML Schema Definition (XSD) datatypes vocabulary.
 *
 * @remarks
 * Base IRI: `http://www.w3.org/2001/XMLSchema#`
 *
 * Common terms: `XSD.string`, `XSD.integer`, `XSD.decimal`, `XSD.float`,
 * `XSD.double`, `XSD.boolean`, `XSD.date`, `XSD.dateTime`, `XSD.time`,
 * `XSD.anyURI`, `XSD.normalizedString`, `XSD.token`, `XSD.nonNegativeInteger`.
 *
 * @example
 * ```ts
 * import { XSD } from './Vocab.js';
 * XSD.string.value  // 'http://www.w3.org/2001/XMLSchema#string'
 * XSD.integer.value // 'http://www.w3.org/2001/XMLSchema#integer'
 * ```
 *
 * @category RDF
 * @since 0.1.0
 * @see {@link https://www.w3.org/TR/xmlschema11-2/ | XML Schema Definition Language (XSD) 1.1 Part 2: Datatypes}
 * @group Vocab
 */
export const XSD: NamespaceBuilder = Namespaces.for('http://www.w3.org/2001/XMLSchema#');

/**
 * Namespace builder for the SHACL (Shapes Constraint Language) vocabulary.
 *
 * @remarks
 * Base IRI: `http://www.w3.org/ns/shacl#`
 *
 * The W3C-recommended prefix for this vocabulary is `sh` (not `shacl`), as
 * reflected in {@link STANDARD_PREFIXES}.
 *
 * Common terms: `SHACL.NodeShape`, `SHACL.PropertyShape`, `SHACL.targetClass`,
 * `SHACL.targetNode`, `SHACL.property`, `SHACL.path`, `SHACL.datatype`,
 * `SHACL.minCount`, `SHACL.maxCount`, `SHACL.pattern`, `SHACL.conforms`,
 * `SHACL.ValidationReport`, `SHACL.ValidationResult`, `SHACL.resultMessage`.
 *
 * @example
 * ```ts
 * import { SHACL } from './Vocab.js';
 * SHACL.NodeShape.value  // 'http://www.w3.org/ns/shacl#NodeShape'
 * SHACL.conforms.value   // 'http://www.w3.org/ns/shacl#conforms'
 * ```
 *
 * @category RDF
 * @since 0.1.0
 * @see {@link https://www.w3.org/TR/shacl/ | Shapes Constraint Language (SHACL)}
 * @group Vocab
 */
export const SHACL: NamespaceBuilder = Namespaces.for('http://www.w3.org/ns/shacl#');

/**
 * Namespace builder for the PROV-O (Provenance Ontology) vocabulary.
 *
 * @remarks
 * Base IRI: `http://www.w3.org/ns/prov#`
 *
 * Common terms: `PROV.Activity`, `PROV.wasGeneratedBy`, `PROV.atTime`,
 * `PROV.value`, `PROV.reason`.
 *
 * @example
 * ```ts
 * import { PROV } from './Vocab.js';
 * PROV.Activity.value        // 'http://www.w3.org/ns/prov#Activity'
 * PROV.wasGeneratedBy.value  // 'http://www.w3.org/ns/prov#wasGeneratedBy'
 * ```
 *
 * @category RDF
 * @since 0.5.0
 * @see {@link https://www.w3.org/TR/prov-o/ | PROV-O: The PROV Ontology}
 * @group Vocab
 */
export const PROV: NamespaceBuilder = Namespaces.for('http://www.w3.org/ns/prov#');

// ---------------------------------------------------------------------------
// STANDARD_PREFIXES
// ---------------------------------------------------------------------------

/**
 * Frozen prefix table for the v0.x default vocabularies.
 *
 * @remarks
 * Contains the five core RDF/OWL/SHACL prefixes used across all Squashage
 * pipelines.  Pass this object (or a subset) to `Serializer.serialize` as the
 * `prefixes` option to obtain a well-prefixed Turtle or TriG document.
 *
 * The W3C-recommended prefix for SHACL is `sh` (not `shacl`), matching the
 * spec's own examples and the majority of published ontologies.
 *
 * This constant is the **canonical** prefix table consumed by the serializer.
 * A placeholder of the same name was present in `src/rdf/Namespaces.ts` (W4)
 * and has been removed so this file is the single authoritative source.  Any
 * module that previously imported `STANDARD_PREFIXES` from `Namespaces.ts`
 * should be updated to import from `Vocab.ts`.
 *
 * The object is frozen — mutation attempts throw in strict mode.
 *
 * @example
 * ```ts
 * import { STANDARD_PREFIXES } from './Vocab.js';
 *
 * STANDARD_PREFIXES.rdf  // 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
 * STANDARD_PREFIXES.rdfs // 'http://www.w3.org/2000/01/rdf-schema#'
 * STANDARD_PREFIXES.owl  // 'http://www.w3.org/2002/07/owl#'
 * STANDARD_PREFIXES.xsd  // 'http://www.w3.org/2001/XMLSchema#'
 * STANDARD_PREFIXES.sh   // 'http://www.w3.org/ns/shacl#'
 * ```
 *
 * @category RDF
 * @since 0.1.0
 * @see {@link RDF}
 * @see {@link RDFS}
 * @see {@link OWL}
 * @see {@link XSD}
 * @see {@link SHACL}
 * @group Vocab
 */
export const STANDARD_PREFIXES: Readonly<Record<'rdf' | 'rdfs' | 'owl' | 'xsd' | 'sh' | 'prov', string>> = Object.freeze({
  rdf:  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl:  'http://www.w3.org/2002/07/owl#',
  xsd:  'http://www.w3.org/2001/XMLSchema#',
  sh:   'http://www.w3.org/ns/shacl#',
  prov: 'http://www.w3.org/ns/prov#',
});
