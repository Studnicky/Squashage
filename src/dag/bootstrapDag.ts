/**
 * bootstrapDag — master orchestrator registered under `'squashage:bootstrap'`.
 *
 * Topology:
 *
 *   induce (deep-dag squashage:induce)
 *     ──success──► refine-required-gate
 *     ──error   ──► bootstrap-end
 *
 *   refine-required-gate
 *     ──refinements-present──► refine (deep-dag squashage:refine)
 *     ──refinements-absent ──► bootstrap-end   ← operator halt, not an error
 *
 *   refine (deep-dag squashage:refine)
 *     ──success──► build-ready-gate
 *     ──error  ──► bootstrap-end
 *
 *   build-ready-gate
 *     ──schemas-present──► build (deep-dag squashage:run)
 *     ──schemas-absent ──► bootstrap-end
 *
 *   build (deep-dag squashage:run)
 *     ──success──► bootstrap-end
 *     ──error  ──► bootstrap-end
 *
 *   bootstrap-end ──► END (null)
 *
 * Note: dagonizer does not allow deep-DAG placements to route directly to
 * null (END). All routes from deep-DAG placements must target parent
 * placements. The `bootstrap-end` no-op single node owns the null route.
 *
 * stateMapping.output lifts summary fields from each child state into
 * SquashageBootstrapState via DottedPathAccessor dot-paths.
 * The mapping format is { parentKey: childKey } — reads `childKey` from
 * the child state and writes to `parentKey` on the parent state.
 */

import type { DAG } from '@noocodex/dagonizer/entities';
import type { NodeInterface } from '@noocodex/dagonizer';
import { DAGBuilder } from '@noocodex/dagonizer/builder';

import type { SquashageBootstrapState } from '../state/SquashageBootstrapState.js';

type EndOutput = 'done';

/**
 * No-op terminal node that owns the null (END) route for the bootstrap DAG.
 *
 * Exported so `registerBootstrapNodes` can register it on the dispatcher.
 * dagonizer requires every SingleNode placement to reference a registered node.
 */
export const bootstrapEndNode: NodeInterface<SquashageBootstrapState, EndOutput> = {
  name:    'bootstrap-end',
  outputs: ['done'],
  async execute(): Promise<{ output: EndOutput }> {
    return { output: 'done' };
  },
};

export const bootstrapDag: DAG = new DAGBuilder('squashage:bootstrap', '1.0')
  .deepDAG(
    'induce',
    'squashage:induce',
    { success: 'refine-required-gate', error: 'bootstrap-end' },
    {
      // dagonizer 0.10 renamed stateMapping.output → flat `outputs`.
      // Flat key mappings — DottedPathAccessor requires the parent field to
      // be non-null for dot-path writes. We use flat keys; induceResult is
      // derived in executeBootstrap from these flat fields.
      outputs: {
        'discoveredClasses': 'discoveredClasses',
        'draftsWritten':     'draftsWritten',
        'observedRecords':   'observedRecords',
      },
    },
  )

  .node(
    'refine-required-gate',
    {
      name:    'refine-required-gate',
      outputs: ['refinements-present', 'refinements-absent'] as const,
      async execute() { throw new Error('stub'); },
    },
    {
      'refinements-present': 'refine',
      'refinements-absent':  'bootstrap-end',
    },
  )

  .deepDAG(
    'refine',
    'squashage:refine',
    { success: 'build-ready-gate', error: 'bootstrap-end' },
    {
      // dagonizer 0.10 renamed stateMapping.output → flat `outputs`.
      outputs: {
        'refinedCount':     'refinedCount',
        'passthroughCount': 'passthroughCount',
      },
    },
  )

  .node(
    'build-ready-gate',
    {
      name:    'build-ready-gate',
      outputs: ['schemas-present', 'schemas-absent'] as const,
      async execute() { throw new Error('stub'); },
    },
    {
      'schemas-present': 'build',
      'schemas-absent':  'bootstrap-end',
    },
  )

  .deepDAG(
    'build',
    'squashage:run',
    { success: 'bootstrap-end', error: 'bootstrap-end' },
  )

  .node('bootstrap-end', bootstrapEndNode, { done: null })

  .entrypoint('induce')
  .build();
