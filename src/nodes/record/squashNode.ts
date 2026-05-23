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

import type { NodeInterface } from '@noocodex/dagonizer';
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
export const defaultSquashNode: SquashNodeInterface = {
  name:    'squash',
  outputs: ['squashed', 'quarantined'],
  async execute(state, context) {
    const log = context.services.logger.forComponent('squash');
    if (state.classification === null) {
      state.collectError({
        code:        'SQUASH_NO_CLASSIFICATION',
        message:     'squash invoked but state.classification is null',
        operation:   'squash',
        recoverable: false,
        timestamp:   new Date().toISOString(),
      });
      state.quarantineBucket = 'projection';
      return { output: 'quarantined' };
    }

    const factory    = context.services.factory;
    const subjectIri = context.services.subjectIri.resolve(
      state.input,
      state.recordPath,
      state.recordLine,
      state.classification.type,
    );

    const subject = factory.namedNode(subjectIri);
    const predicate = factory.namedNode(RDF_TYPE);
    const object  = factory.namedNode(
      `${context.services.prefixes.vocabulary.base}${state.classification.type}`,
    );
    const graph = context.services.graphs['default'] ?? factory.defaultGraph();
    const quad: Quad = factory.quad(subject, predicate, object, graph);

    (state as unknown as { squashedQuads: Quad[] }).squashedQuads = [quad];
    context.services.dataset.add(quad);

    log.debug('execute', 'squash emitted rdf:type', { subjectIri, classIri: object.value });
    return { output: 'squashed' };
  },
};
