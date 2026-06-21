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

import { ScalarNode, NodeOutputBuilder, NodeErrorBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType, NodeWarningType } from '@studnicky/dagonizer';

import { TaxonomicInheritanceEnricher } from '../../induction/TaxonomicInheritanceEnricher.js';
import { VocabEnricher }                from '../../induction/VocabEnricher.js';
import { FormatResolver }               from '../../output/FormatResolver.js';
import type { SquashOutput }            from './squashNode.js';
import type { SquashageServices }       from '../../services/SquashageServices.js';
import type { SquashageRecordState }    from '../../state/SquashageRecordState.js';

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
class OntologyProjectionNodeImpl
  extends ScalarNode<SquashageRecordState, SquashOutput, SquashageServices> {

  public readonly name    = 'squash';
  public readonly outputs = ['squashed', 'quarantined'] as const;

  public override get outputSchema(): Record<SquashOutput, { type: 'object' }> {
    return { squashed: { type: 'object' }, quarantined: { type: 'object' } };
  }

  protected override async executeOne(
    state:   SquashageRecordState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<SquashOutput>> {
    const { services } = context;
    const log = services.logger.forComponent('ontologyProjectionNode');

    // ── a. classification guard ───────────────────────────────────────────────
    if (state.classification === null) {
      state.collectError(NodeErrorBuilder.from(
        'SQUASH_NO_CLASSIFICATION',
        'ontologyProjectionNode invoked but state.classification is null',
        'squash', false, new Date().toISOString(),
      ));
      state.quarantineBucket = 'projection';
      return NodeOutputBuilder.of('quarantined');
    }

    // ── b. ontology service guard ─────────────────────────────────────────────
    if (services.ontology === null) {
      state.collectError(NodeErrorBuilder.from(
        'SQUASH_NO_ONTOLOGY',
        'ontologyProjectionNode requires services.ontology; target has no `ontology.engine: json-tology` configured',
        'squash', false, new Date().toISOString(),
      ));
      state.quarantineBucket = 'projection';
      return NodeOutputBuilder.of('quarantined');
    }

    const className = state.classification.type;

    // ── c. schema lookup ──────────────────────────────────────────────────────
    // Try className first; fall back to 'Generic' with an advisory warning.
    let schema = services.ontology.schemaForClassName(className);
    if (schema === undefined) {
      const genericSchema = services.ontology.schemaForClassName('Generic');
      if (genericSchema === undefined) {
        state.collectError(NodeErrorBuilder.from(
          'SQUASH_NO_SCHEMA_FOR_CLASS',
          `ontologyProjectionNode: no schema registered for className "${className}"`,
          'squash', false, new Date().toISOString(),
          { context: { className } },
        ));
        state.quarantineBucket = 'projection';
        return NodeOutputBuilder.of('quarantined');
      }
      const fallbackWarning: NodeWarningType = {
        code:      'PROJECTION_GENERIC_FALLBACK',
        message:   `ontologyProjectionNode: no schema for className "${className}"; using Generic schema for projection`,
        operation: 'squash',
        timestamp: new Date().toISOString(),
      };
      state.collectWarning(fallbackWarning);
      schema = genericSchema;
    }

    // ── d. subject IRI ────────────────────────────────────────────────────────
    const subjectIri = services.subjectIri.resolve(
      state.input,
      state.recordPath,
      state.recordLine,
      className,
    );

    // ── e. advisory schema validation (warnings only — never prevents projection) ──
    // Emit ONE summary warning per record when validation fails, not one per
    // violated constraint.  Per-item warnings accumulate unboundedly on the parent
    // SquashageRunState._warnings (the dagonizer propagates all clone warnings
    // upward via ackItem), which causes multi-GB heap growth on large corpora.
    // The bounded summary is sufficient for diagnostics; the violation count is
    // included in the message so operators can tell how noisy the schema fit is.
    try {
      const validation = services.ontology.validate(schema.$id, state.input);
      if (!validation.ok) {
        const violationCount = validation.items.length;
        const firstMessage   = validation.items[0]?.message ?? 'unknown constraint';
        const constraintWarning: NodeWarningType = {
          code:      'PROJECTION_CONSTRAINT_VIOLATION',
          message:   `Schema constraint violation on "${schema.$id}": ${violationCount} violation(s); first: ${firstMessage}`,
          operation: 'squash',
          timestamp: new Date().toISOString(),
        };
        state.collectWarning(constraintWarning);
      }
    } catch {
      // Validation is best-effort; a failure here must never prevent projection.
    }

    // ── f. projection ─────────────────────────────────────────────────────────
    let rawQuads: ReadonlyArray<Quad>;
    try {
      rawQuads = await services.ontology.toQuads(schema.$id, state.input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.collectError(NodeErrorBuilder.from(
        'SQUASH_PROJECTION_FAILED',
        `ontologyProjectionNode: toQuads() threw: ${message}`,
        'squash', false, new Date().toISOString(),
        { context: { className, schemaId: schema.$id, errorMessage: message } },
      ));
      state.quarantineBucket = 'projection';
      return NodeOutputBuilder.of('quarantined');
    }

    if (rawQuads.length === 0) {
      // Empty projection is valid — write nothing, proceed as squashed.
      state.squashedQuads = [];
      log.debug('executeOne', 'toQuads returned empty array', { className, subjectIri });
      return NodeOutputBuilder.of('squashed');
    }

    // ── f. subject rebinding ──────────────────────────────────────────────────
    // Detect the json-tology-minted subject: the subject of the first rdf:type
    // quad whose object is the class IRI derived from the classification type.
    const classIri = OntologyProjectionNodeImpl.classIriFrom(services.ontology.baseIRI(), className);
    const mintedSubject = OntologyProjectionNodeImpl.detectMintedSubject(rawQuads, classIri);

    const factory = services.factory;
    // Per-class named graph when configured, else fall back to `default`.
    // Lets viz tools partition the dataset by class without inspecting rdf:type.
    const targetGraph: NamedNode | DefaultGraph =
      services.graphs[className] ?? services.graphs['default'] ?? factory.defaultGraph();

    const policySubject = factory.namedNode(subjectIri);

    // ── g. graph rebinding + subject rebinding ────────────────────────────────
    const rebound: Quad[] = rawQuads.map((quad) => {
      const subject = OntologyProjectionNodeImpl.shouldRebindSubject(quad.subject, mintedSubject)
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
    const ancestors       = services.ontology.ancestorIris(className);
    const withInheritance = TaxonomicInheritanceEnricher.enrich(
      enriched,
      className,
      ancestors,
      subjectIri,
      factory,
      targetGraph,
    );

    const finalQuads: Quad[] = [...withInheritance];

    state.squashedQuads = finalQuads;

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
      log.debug('executeOne', 'ontology projection complete (batched — format unresolvable)', {
        className,
        subjectIri,
        quadCount: finalQuads.length,
      });
      return NodeOutputBuilder.of('squashed');
    }

    // Guard: partial service mocks in unit tests may not provide openRecordWriter.
    const openWriter = services.openRecordWriter?.bind(services);
    const writer = openWriter !== undefined
      ? await openWriter(services.output.path, resolvedFormat)
      : null;

    if (writer !== null) {
      // Streaming path: write directly to the open file stream.
      await writer.write(finalQuads);
      // Release large per-record objects from clone state now that serialization is
      // complete.  V8 will not GC these while the clone holds references; clearing
      // both fields makes ~450 Quads (+ their term objects) and the parsed JSON
      // record eligible for collection before RecordFoldGather.reduce() drops the
      // clone — critical for keeping peak RSS well under the 4 GB V8 heap limit on
      // large corpora.
      state.squashedQuads = [];
      state.input         = {};
    } else {
      // Batched path (JSON-LD, writer unavailable, or partial test mock): accumulate in dataset.
      for (const quad of finalQuads) {
        services.dataset.add(quad);
      }
    }

    log.debug('executeOne', 'ontology projection complete', {
      className,
      subjectIri,
      quadCount:  finalQuads.length,
      streaming:  writer !== null,
    });

    return NodeOutputBuilder.of('squashed');
  }

  /**
   * Derive the class IRI from a baseIRI and className using the same convention
   * as {@link JsonTologyOntology.classMap}: path-form `${baseIRI}/${className}`.
   *
   * Path-form avoids double-hash property IRIs (json-tology appends `#<prop>` to
   * the schema `$id`; with fragment-form the result would be `<base>#<class>#<prop>`).
   */
  private static classIriFrom(baseIRI: string, className: string): string {
    let trimmed = baseIRI;
    while (trimmed.endsWith('#') || trimmed.endsWith('/')) {
      trimmed = trimmed.slice(0, -1);
    }
    return `${trimmed}/${className}`;
  }

  /**
   * Find the subject of the first rdf:type quad whose object matches classIri.
   * Returns null when no such quad exists (nothing to rebind).
   */
  private static detectMintedSubject(quads: ReadonlyArray<Quad>, classIri: string): string | null {
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
   */
  private static shouldRebindSubject(
    subject:       Quad['subject'],
    mintedSubject: string | null,
  ): boolean {
    return (
      mintedSubject !== null &&
      subject.termType === 'NamedNode' &&
      subject.value    === mintedSubject
    );
  }
}

export const ontologyProjectionNode: OntologyProjectionNodeImpl = new OntologyProjectionNodeImpl();
