/**
 * enrich-entity-link — placeholder. Entity-linking enrichment runs once after
 * all records have been processed (post fan-out, pre finalize). Reads
 * `services.targetConfig.enrichment.entityLink` config; no-ops when absent.
 *
 * The full algorithm lives in the legacy `src/tasks/entityLink.ts`. Porting
 * it is queued as Phase 4 follow-up; for now this node is a pass-through so
 * the run-scope DAG wires correctly.
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRunState } from '../../state/SquashageRunState.js';

type Output = 'enriched' | 'skipped';

class EnrichEntityLinkNodeImpl extends ScalarNode<SquashageRunState, Output, SquashageServices> {
  public readonly name    = 'enrich-entity-link';
  public readonly outputs = ['enriched', 'skipped'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return {
      enriched: { type: 'object' },
      skipped:  { type: 'object' },
    };
  }

  protected override async executeOne(
    _state:  SquashageRunState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const enrichment = (context.services.targetConfig.enrichment ?? {}) as Record<string, unknown>;
    if (enrichment['entityLink'] === undefined) {
      return NodeOutputBuilder.of('skipped');
    }
    // Full port of legacy entityLink algorithm queued — currently a pass-through.
    return NodeOutputBuilder.of('skipped');
  }
}

export const enrichEntityLinkNode = new EnrichEntityLinkNodeImpl();
