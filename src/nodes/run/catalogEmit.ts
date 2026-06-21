/**
 * catalog-emit — placeholder. Writes the per-target catalog manifest after
 * the success graph is on disk. The full algorithm lives in
 * `src/tasks/emitCatalog.ts`. Currently a pass-through so the run-scope DAG
 * wires correctly; full port queued.
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRunState } from '../../state/SquashageRunState.js';

type Output = 'emitted' | 'skipped';

class CatalogEmitNodeImpl extends ScalarNode<SquashageRunState, Output, SquashageServices> {
  public readonly name    = 'catalog-emit';
  public readonly outputs = ['emitted', 'skipped'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return {
      emitted: { type: 'object' },
      skipped: { type: 'object' },
    };
  }

  protected override async executeOne(
    _state:  SquashageRunState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const bucketing = (context.services.output as Record<string, unknown>)['bucketing'];
    if (bucketing === undefined) return NodeOutputBuilder.of('skipped');
    return NodeOutputBuilder.of('skipped');
  }
}

export const catalogEmitNode = new CatalogEmitNodeImpl();
