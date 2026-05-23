/**
 * merge-shape-cache — sync-barrier node for the induce DAG.
 *
 * By being a single sequential node after the fan-out drains, this node
 * guarantees that all `shape-observe` writes have completed before
 * materialization begins. dagonizer's fan-out fan-in contract ensures the
 * fan-out workers are fully drained before `merge-shape-cache` executes.
 *
 * Reads `services.shapeCache`, computes summary statistics, and writes them
 * into `state`:
 *   - `observedRecords`: sum of `recordCount` across all observations
 *   - `discoveredClasses`: sorted list of class names
 *
 * Outputs:
 *   merged — always; the barrier always succeeds (empty cache is valid)
 */

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageInduceRunState } from '../../state/SquashageInduceRunState.js';

type Output = 'merged';

export const mergeShapeCacheNode: NodeInterface<SquashageInduceRunState, Output, SquashageServices> = {
  name:    'merge-shape-cache',
  outputs: ['merged'],

  async execute(state, context) {
    const log = context.services.logger.forComponent('merge-shape-cache');
    const { shapeCache } = context.services;

    let observedRecords = 0;
    for (const observation of shapeCache.values()) {
      observedRecords += observation.recordCount;
    }

    const discoveredClasses = [...shapeCache.keys()].sort();

    state.observedRecords   = observedRecords;
    state.discoveredClasses = discoveredClasses;

    log.info('execute', 'shape cache merged', {
      classCount:      discoveredClasses.length,
      observedRecords,
    });

    return { output: 'merged' };
  },
};
