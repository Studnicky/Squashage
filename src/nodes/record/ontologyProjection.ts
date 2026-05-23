/**
 * ontologyProjection — generic squash node that calls services.ontology.toQuads()
 * against the registered schemas and writes the projected quads into the dataset.
 *
 * This node replaces every per-target plugin's hand-coded squash logic. It
 * requires `services.ontology` to be non-null (i.e. the target must have
 * `ontology.engine: json-tology` configured). Targets that have not opted into
 * the ontology engine will continue to use `defaultSquashNode` with a startup
 * warning.
 *
 * Subject rebinding: json-tology mints its own subject IRI during projection.
 * This node detects the minted subject (the subject of the first rdf:type quad
 * whose object is the class IRI for state.classification.type) and replaces it
 * with the SubjectIriPolicy-resolved IRI on every quad that shared it. Quads
 * whose subject is a blank node or a different IRI are left unchanged.
 *
 * Graph rebinding: every quad is rebound to services.graphs['default'] (or the
 * default graph), matching the behavior of defaultSquashNode.
 */

import type { Quad, NamedNode, BlankNode, DefaultGraph } from '@rdfjs/types';

import { TaxonomicInheritanceEnricher } from '../../induction/TaxonomicInheritanceEnricher.js';
import { VocabEnricher }                from '../../induction/VocabEnricher.js';
import { FormatResolver }               from '../../output/FormatResolver.js';
import type { SquashNodeInterface }      from './squashNode.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * Generic ontology-projection squash node.
 *
 * Calls `services.ontology.toQuads(schema.$id, instance)`, rebinds the
 * minted subject to the policy-resolved IRI, and lands every quad in the
 * target's default named graph.
 *
 * Guard conditions (quarantine with an error code):
 * - `state.classification === null`  → SQUASH_NO_CLASSIFICATION
 * - `services.ontology === null`     → SQUASH_NO_ONTOLOGY
 * - schema not found for className   → SQUASH_NO_SCHEMA_FOR_CLASS
 * - `toQuads()` throws               → SQUASH_PROJECTION_FAILED
 */
export const ontologyProjectionNode: SquashNodeInterface = {
  name:    'squash',
  outputs: ['squashed', 'quarantined'],

  async execute(state, context) {
    const { services } = context;
    const log = services.logger.forComponent('ontologyProjectionNode');

    // ── a. classification guard ───────────────────────────────────────────────
    if (state.classification === null) {
      state.collectError({
        code:        'SQUASH_NO_CLASSIFICATION',
        message:     'ontologyProjectionNode invoked but state.classification is null',
        operation:   'squash',
        recoverable: false,
        timestamp:   new Date().toISOString(),
      });
      state.quarantineBucket = 'projection';
      return { output: 'quarantined' };
    }

    // ── b. ontology service guard ─────────────────────────────────────────────
    if (services.ontology === null) {
      state.collectError({
        code:        'SQUASH_NO_ONTOLOGY',
        message:     'ontologyProjectionNode requires services.ontology; target has no `ontology.engine: json-tology` configured',
        operation:   'squash',
        recoverable: false,
        timestamp:   new Date().toISOString(),
      });
      state.quarantineBucket = 'projection';
      return { output: 'quarantined' };
    }

    const className = state.classification.type;

    // ── c. schema lookup ──────────────────────────────────────────────────────
    const schema = services.ontology.schemaForClassName(className);
    if (schema === undefined) {
      state.collectError({
        code:        'SQUASH_NO_SCHEMA_FOR_CLASS',
        message:     `ontologyProjectionNode: no schema registered for className "${className}"`,
        operation:   'squash',
        recoverable: false,
        timestamp:   new Date().toISOString(),
        context:     { className },
      });
      state.quarantineBucket = 'projection';
      return { output: 'quarantined' };
    }

    // ── d. subject IRI ────────────────────────────────────────────────────────
    const subjectIri = services.subjectIri.resolve(
      state.input,
      state.recordPath,
      state.recordLine,
      className,
    );

    // ── e. projection ─────────────────────────────────────────────────────────
    let rawQuads: ReadonlyArray<Quad>;
    try {
      rawQuads = await services.ontology.toQuads(schema.$id, state.input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.collectError({
        code:        'SQUASH_PROJECTION_FAILED',
        message:     `ontologyProjectionNode: toQuads() threw: ${message}`,
        operation:   'squash',
        recoverable: false,
        timestamp:   new Date().toISOString(),
        context:     { className, schemaId: schema.$id, errorMessage: message },
      });
      state.quarantineBucket = 'projection';
      return { output: 'quarantined' };
    }

    if (rawQuads.length === 0) {
      // Empty projection is valid — write nothing, proceed as squashed.
      (state as unknown as { squashedQuads: Quad[] }).squashedQuads = [];
      log.debug('execute', 'toQuads returned empty array', { className, subjectIri });
      return { output: 'squashed' };
    }

    // ── f. subject rebinding ──────────────────────────────────────────────────
    // Detect the json-tology-minted subject: the subject of the first rdf:type
    // quad whose object is the class IRI derived from the classification type.
    const classIri = buildClassIri(services.ontology.baseIRI(), className);
    const mintedSubject = detectMintedSubject(rawQuads, classIri);

    const factory = services.factory;
    // Per-class named graph when configured, else fall back to `default`.
    // Lets viz tools partition the dataset by class without inspecting rdf:type.
    const targetGraph: NamedNode | DefaultGraph =
      services.graphs[className] ?? services.graphs['default'] ?? factory.defaultGraph();

    const policySubject = factory.namedNode(subjectIri);

    // ── g. graph rebinding + subject rebinding ────────────────────────────────
    const rebound: Quad[] = rawQuads.map((quad) => {
      const subject = shouldRebindSubject(quad.subject, mintedSubject)
        ? policySubject
        : (quad.subject as NamedNode | BlankNode);
      return factory.quad(subject, quad.predicate as NamedNode, quad.object, targetGraph);
    });

    // ── h. vocab enrichment ───────────────────────────────────────────────────
    const enriched = VocabEnricher.enrich(
      rebound,
      schema as Readonly<Record<string, unknown>>,
      state.input,
      subjectIri,
      factory,
      services.ontology.baseIRI(),
      targetGraph,
    );

    // ── i. taxonomic inheritance enrichment ───────────────────────────────────
    // Materialize ancestor rdf:type triples for consumers that do not run OWL
    // reasoning (SPARQL endpoints, graph stores, visualization layer).
    const ancestors          = services.ontology.ancestorIris(className);
    const withInheritance    = TaxonomicInheritanceEnricher.enrich(
      enriched,
      className,
      ancestors,
      subjectIri,
      factory,
      targetGraph,
    );

    const finalQuads: Quad[] = [...withInheritance];

    (state as unknown as { squashedQuads: Quad[] }).squashedQuads = finalQuads;

    // ── j. streaming vs. batched write ───────────────────────────────────────
    // Attempt to open (or reuse) the per-record streaming writer.  On first
    // call this lazily opens the success-graph file stream.  On subsequent
    // concurrent calls it awaits the same Promise, so the file is opened
    // exactly once regardless of fan-out concurrency.
    //
    // Fall back to the dataset accumulation path when:
    //   - The output format is JSON-LD (requires batch serialization).
    //   - The services bag has no output path (e.g. dry-run, test fixtures).
    let resolvedFormat: ReturnType<typeof FormatResolver.resolve>;
    try {
      resolvedFormat = FormatResolver.resolve(services.output);
    } catch {
      // If format cannot be resolved (e.g. test fixture with .nq extension
      // missing a format field), fall back to dataset path.
      for (const quad of finalQuads) {
        services.dataset.add(quad);
      }
      log.debug('execute', 'ontology projection complete (batched — format unresolvable)', {
        className,
        subjectIri,
        quadCount: finalQuads.length,
      });
      return { output: 'squashed' };
    }

    // Guard: partial service mocks in unit tests may not provide openRecordWriter.
    const openWriter = services.openRecordWriter?.bind(services);
    const writer = openWriter !== undefined
      ? await openWriter(services.output.path, resolvedFormat)
      : null;

    if (writer !== null) {
      // Streaming path: write directly to the open file stream.
      await writer.write(finalQuads);
    } else {
      // Batched path (JSON-LD, writer unavailable, or partial test mock): accumulate in dataset.
      for (const quad of finalQuads) {
        services.dataset.add(quad);
      }
    }

    log.debug('execute', 'ontology projection complete', {
      className,
      subjectIri,
      quadCount:  finalQuads.length,
      streaming:  writer !== null,
    });

    return { output: 'squashed' };
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derive the class IRI from a baseIRI and className using the same convention
 * as {@link JsonTologyOntology.classMap}: path-form `${baseIRI}/${className}`.
 *
 * Path-form avoids double-hash property IRIs (json-tology appends `#<prop>` to
 * the schema `$id`; with fragment-form the result would be `<base>#<class>#<prop>`).
 *
 * @internal
 */
function buildClassIri(baseIRI: string, className: string): string {
  let trimmed = baseIRI;
  while (trimmed.endsWith('#') || trimmed.endsWith('/')) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}/${className}`;
}

/**
 * Find the subject of the first rdf:type quad whose object matches classIri.
 * Returns null when no such quad exists (nothing to rebind).
 *
 * @internal
 */
function detectMintedSubject(quads: ReadonlyArray<Quad>, classIri: string): string | null {
  for (const quad of quads) {
    if (
      quad.predicate.termType === 'NamedNode' &&
      quad.predicate.value   === RDF_TYPE &&
      quad.object.termType   === 'NamedNode' &&
      quad.object.value      === classIri
    ) {
      return quad.subject.value;
    }
  }
  return null;
}

/**
 * Returns true when quad.subject should be replaced by the policy-resolved IRI.
 *
 * Rebind only when:
 * 1. A minted subject was found (`mintedSubject !== null`).
 * 2. The quad's subject is a NamedNode (not a blank node).
 * 3. The quad's subject value matches the minted subject.
 *
 * @internal
 */
function shouldRebindSubject(
  subject:       Quad['subject'],
  mintedSubject: string | null,
): boolean {
  return (
    mintedSubject !== null &&
    subject.termType === 'NamedNode' &&
    subject.value    === mintedSubject
  );
}
