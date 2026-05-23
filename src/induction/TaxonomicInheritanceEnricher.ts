/**
 * TaxonomicInheritanceEnricher — pure, stateless ABox enricher for OWL subClassOf
 * materialization.
 *
 * OWL semantics dictate that if `Feat rdfs:subClassOf ContentEntry`, every Feat
 * instance is entailed to also be a ContentEntry. Most consumers (SPARQL endpoints,
 * graph stores, the visualization layer) do not run OWL reasoning, so those
 * entailed `rdf:type` triples must be materialized explicitly in the ABox.
 *
 * This enricher adds ancestor `rdf:type` quads for a subject that has already
 * received its direct class type quad. It is called from `OntologyProjectionNode`
 * after the VocabEnricher pass.
 *
 * No I/O. No Date.now(). No Math.random(). Deterministic given the same inputs.
 */

import type { DataFactory, DefaultGraph, NamedNode, Quad } from '@rdfjs/types';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * Pure, stateless enricher that materializes ancestor `rdf:type` triples for
 * OWL subClassOf inheritance chains.
 *
 * @remarks
 * Mirrors the structure of {@link VocabEnricher}: one static `enrich` method,
 * no instance state, deterministic output.
 *
 * @category Induction
 * @since 0.8.0
 * @group Core
 */
export class TaxonomicInheritanceEnricher {
  /**
   * Append ancestor `rdf:type` quads to `baseQuads` for `subjectIri`.
   *
   * For each IRI in `ancestorIris`, emits:
   * ```
   * <subjectIri>  rdf:type  <ancestorIri>  (graph: targetGraph)
   * ```
   * unless that exact triple is already present in `baseQuads`.
   *
   * Iteration order mirrors `ancestorIris` exactly — the caller (typically
   * {@link JsonTologyOntology.ancestorIris}) is responsible for BFS ordering
   * (immediate parent first, root last). No internal sort is applied.
   *
   * @param baseQuads    - Quads already produced by projection + VocabEnricher.
   * @param className    - The concrete class name being projected (used only to
   *                       build the deduplication key; not written to any quad).
   * @param ancestorIris - Transitive ancestor class IRIs in traversal order.
   * @param subjectIri   - The policy-resolved subject IRI for this record.
   * @param factory      - RDF/JS DataFactory for term construction.
   * @param targetGraph  - Named graph to stamp on every emitted quad.
   * @returns A new (possibly larger) array of quads. Never mutates the input.
   */
  static enrich(
    baseQuads:    ReadonlyArray<Quad>,
    className:    string,
    ancestorIris: ReadonlyArray<string>,
    subjectIri:   string,
    factory:      DataFactory,
    targetGraph:  NamedNode | DefaultGraph,
  ): ReadonlyArray<Quad> {
    // className is accepted to satisfy the interface contract described in the
    // spec and to remain symmetric with VocabEnricher.enrich; it is not written
    // to any quad.
    void className;

    if (ancestorIris.length === 0) return baseQuads;

    // Build a Set of ancestor IRIs already asserted for this subject so we
    // can skip duplicates in O(1).
    const existingAncestors = new Set<string>();
    for (const quad of baseQuads) {
      if (
        quad.predicate.termType === 'NamedNode' &&
        quad.predicate.value   === RDF_TYPE &&
        quad.subject.termType  === 'NamedNode' &&
        quad.subject.value     === subjectIri &&
        quad.object.termType   === 'NamedNode'
      ) {
        existingAncestors.add(quad.object.value);
      }
    }

    const subject    = factory.namedNode(subjectIri);
    const rdfType    = factory.namedNode(RDF_TYPE);
    const newQuads: Quad[] = [];

    for (const ancestorIri of ancestorIris) {
      if (!existingAncestors.has(ancestorIri)) {
        newQuads.push(factory.quad(
          subject,
          rdfType,
          factory.namedNode(ancestorIri),
          targetGraph,
        ));
        // Track within this call so two identical entries in ancestorIris
        // don't produce duplicate quads.
        existingAncestors.add(ancestorIri);
      }
    }

    if (newQuads.length === 0) return baseQuads;
    return [...baseQuads, ...newQuads];
  }
}
