/**
 * squash — per-target projection node. Reads the classified record from state,
 * builds typed RDF quads, and writes them to (a) `state.squashedQuads` (for
 * streaming consumers) and (b) `services.dataset` (for the file-mode
 * `rdfjs-finalize` to serialize at end of run).
 *
 * Squash logic is target-specific. The framework ships a `DefaultSquashNode`
 * that emits a single `rdf:type` assertion using the classification class and
 * a deterministic subject IRI. Target plugins (`plugins/<target>/squash.ts`)
 * export their own `NodeInterface<SquashageRecordState, …, SquashageServices>`
 * with `name: 'squash'` and `SquashageRun` registers exactly one — either the
 * plugin's or the default.
 */

import { ScalarNode, NodeOutputBuilder, NodeErrorBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType, NodeInterface } from '@studnicky/dagonizer';
import type { Quad } from '@rdfjs/types';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRecordState } from '../../state/SquashageRecordState.js';

export { ontologyProjectionNode } from './ontologyProjection.js';

export type SquashOutput = 'squashed' | 'quarantined';

/** Contract every target's squash node must satisfy. */
export type SquashNodeInterface =
  NodeInterface<SquashageRecordState, SquashOutput, SquashageServices>;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * Default squash node — emits a single `<record> rdf:type <classIri>` quad
 * derived from the record's resolved classification. Target plugins override
 * with their own NodeInterface registered under the same name (`'squash'`).
 */
class DefaultSquashNodeImpl extends ScalarNode<SquashageRecordState, SquashOutput, SquashageServices> {
  public readonly name    = 'squash';
  public readonly outputs = ['squashed', 'quarantined'] as const;

  public override get outputSchema(): Record<SquashOutput, { type: 'object' }> {
    return { squashed: { type: 'object' }, quarantined: { type: 'object' } };
  }

  protected override async executeOne(
    state:   SquashageRecordState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<SquashOutput>> {
    const log = context.services.logger.forComponent('squash');
    if (state.classification === null) {
      state.collectError(NodeErrorBuilder.from(
        'SQUASH_NO_CLASSIFICATION',
        'squash invoked but state.classification is null',
        'squash', false, new Date().toISOString(),
      ));
      state.quarantineBucket = 'projection';
      return NodeOutputBuilder.of('quarantined');
    }

    const factory    = context.services.factory;
    const subjectIri = context.services.subjectIri.resolve(
      state.input,
      state.recordPath,
      state.recordLine,
      state.classification.type,
    );

    const subject   = factory.namedNode(subjectIri);
    const predicate = factory.namedNode(RDF_TYPE);
    const object    = factory.namedNode(
      `${context.services.prefixes.vocabulary.base}${state.classification.type}`,
    );
    const graph = context.services.graphs['default'] ?? factory.defaultGraph();
    const quad: Quad = factory.quad(subject, predicate, object, graph);

    state.squashedQuads = [quad];
    context.services.dataset.add(quad);

    log.debug('executeOne', 'squash emitted rdf:type', { subjectIri, classIri: object.value });
    return NodeOutputBuilder.of('squashed');
  }
}

export const defaultSquashNode: SquashNodeInterface = new DefaultSquashNodeImpl();
