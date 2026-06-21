/**
 * induce-schemas — run-scope materialization node for the induce DAG.
 *
 * Calls `SchemaInducer.materialize(services.shapeCache, { baseIri })` and
 * stores the result on `state.inducedSchemas` for consumption by `write-drafts`.
 *
 * The `baseIri` is derived from `targetConfig.ontology.baseIRI` (the
 * json-tology engine setting), falling back to `'https://example.org/'` when
 * the ontology block is absent.
 *
 * Outputs:
 *   induced — at least one schema was materialized
 *   empty   — shapeCache is empty; nothing to induce
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import { SchemaInducer } from '../../induction/SchemaInducer.js';
import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageInduceRunState } from '../../state/SquashageInduceRunState.js';

type Output = 'induced' | 'empty';

function resolveBaseIri(services: SquashageServices): string {
  const ontology = services.targetConfig.ontology as Readonly<Record<string, unknown>> | undefined;
  const candidate = ontology?.['baseIRI'] ?? ontology?.['baseIri'];
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : 'https://example.org/';
}

class InduceSchemasNodeImpl extends ScalarNode<SquashageInduceRunState, Output, SquashageServices> {
  public readonly name    = 'induce-schemas';
  public readonly outputs = ['induced', 'empty'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return {
      induced: { type: 'object' },
      empty:   { type: 'object' },
    };
  }

  protected override async executeOne(
    state:   SquashageInduceRunState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const log = context.services.logger.forComponent('induce-schemas');
    const { shapeCache } = context.services;

    if (shapeCache.size === 0) {
      log.info('executeOne', 'shape cache is empty; skipping induction', {});
      return NodeOutputBuilder.of('empty');
    }

    const baseIri = resolveBaseIri(context.services);
    const schemaSet = SchemaInducer.materialize(shapeCache, { baseIri });

    state.inducedSchemas = schemaSet;

    const total = schemaSet.classes.length + schemaSet.primitives.length + schemaSet.objects.length;
    log.info('executeOne', 'schemas induced', {
      classes:    schemaSet.classes.length,
      primitives: schemaSet.primitives.length,
      objects:    schemaSet.objects.length,
      total,
      baseIri,
    });

    return NodeOutputBuilder.of('induced');
  }
}

export const induceSchemasNode = new InduceSchemasNodeImpl();
