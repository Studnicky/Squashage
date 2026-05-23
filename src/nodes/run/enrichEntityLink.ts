/**
 * enrich-entity-link — placeholder. Entity-linking enrichment runs once after
 * all records have been processed (post fan-out, pre finalize). Reads
 * `services.targetConfig.enrichment.entityLink` config; no-ops when absent.
 *
 * The full algorithm lives in the legacy `src/tasks/entityLink.ts`. Porting
 * it is queued as Phase 4 follow-up; for now this node is a pass-through so
 * the run-scope DAG wires correctly.
 */

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRunState } from '../../state/SquashageRunState.js';

type Output = 'enriched' | 'skipped';

export const enrichEntityLinkNode: NodeInterface<SquashageRunState, Output, SquashageServices> = {
  name:    'enrich-entity-link',
  outputs: ['enriched', 'skipped'],
  async execute(_state, context) {
    const enrichment = (context.services.targetConfig.enrichment ?? {}) as Record<string, unknown>;
    if (enrichment['entityLink'] === undefined) {
      return { output: 'skipped' };
    }
    // Full port of legacy entityLink algorithm queued — currently a pass-through.
    return { output: 'skipped' };
  },
};
