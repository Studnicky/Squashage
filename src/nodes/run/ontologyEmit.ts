/**
 * ontology-emit — run-scope node that flushes the target's TBox + SHACL quads
 * into a dedicated `urn:graph:<target>/ontology` named graph within the shared
 * dataset.
 *
 * Fires once per run, after the record fan-out has fully drained and
 * `enrich-entity-link` has completed, before `rdfjs-finalize` splits the
 * dataset into output files.
 *
 * When `services.ontology` is null (target has no json-tology engine), the
 * node returns `'skipped'` immediately without error. Targets that have not
 * registered any schemas pass straight through.
 *
 * When ontology is present:
 *   1. `tbox()` and `shacl()` are awaited concurrently.
 *   2. Every returned quad is cloned into `urn:graph:<target>/ontology`.
 *   3. The cloned quads are added to `services.dataset`.
 *
 * The graph name is `urn:graph:<target>/ontology` where `<target>` is the
 * target identifier string from `services.target`.
 */

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRunState } from '../../state/SquashageRunState.js';

type Output = 'emitted' | 'skipped';

/**
 * Builds the ontology graph IRI for a given target identifier.
 *
 * @param target - The squashage target name (e.g. `"aonprd"`).
 * @returns The graph IRI string: `urn:graph:<target>/ontology`.
 */
export function ontologyGraphIri(target: string): string {
  return `urn:graph:${target}/ontology`;
}

export const ontologyEmitNode: NodeInterface<SquashageRunState, Output, SquashageServices> = {
  name:    'ontology-emit',
  outputs: ['emitted', 'skipped'],

  async execute(_state, context) {
    const { services } = context;
    const log = services.logger.forComponent('ontology-emit');

    if (services.ontology === null) {
      log.debug('execute', 'no ontology engine configured; skipping ontology emit', {
        target: services.target,
      });
      return { output: 'skipped' };
    }

    const [tboxQuads, shaclQuads] = await Promise.all([
      services.ontology.tbox(),
      services.ontology.shacl(),
    ]);

    const ontologyGraph = services.factory.namedNode(ontologyGraphIri(services.target));

    for (const quad of tboxQuads) {
      services.dataset.add(
        services.factory.quad(quad.subject, quad.predicate, quad.object, ontologyGraph),
      );
    }
    for (const quad of shaclQuads) {
      services.dataset.add(
        services.factory.quad(quad.subject, quad.predicate, quad.object, ontologyGraph),
      );
    }

    log.info('execute', 'ontology emitted', {
      target:     services.target,
      tboxCount:  tboxQuads.length,
      shaclCount: shaclQuads.length,
    });

    return { output: 'emitted' };
  },
};
