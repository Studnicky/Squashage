/**
 * bootstrapDag — master orchestrator registered under `'squashage:bootstrap'`.
 *
 * Topology:
 *
 *   induce (embeddedDAG squashage:induce)
 *     ──success──► refine-required-gate
 *     ──error   ──► bootstrap-end
 *
 *   refine-required-gate
 *     ──refinements-present──► refine (embeddedDAG squashage:refine)
 *     ──refinements-absent ──► bootstrap-end   ← operator halt, not an error
 *
 *   refine (embeddedDAG squashage:refine)
 *     ──success──► build-ready-gate
 *     ──error  ──► bootstrap-end
 *
 *   build-ready-gate
 *     ──schemas-present──► build (embeddedDAG squashage:run)
 *     ──schemas-absent ──► bootstrap-end
 *
 *   build (embeddedDAG squashage:run)
 *     ──success──► bootstrap-end
 *     ──error  ──► bootstrap-end
 *
 *   bootstrap-end ──► end
 *
 * stateMapping.output lifts summary fields from each child state into
 * SquashageBootstrapState via DottedPathAccessor dot-paths.
 * The mapping format is { parentKey: childKey } — reads `childKey` from
 * the child state and writes to `parentKey` on the parent state.
 */

import type { DAGType } from '@studnicky/dagonizer';
import { MonadicNode, ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { Batch, NodeContextType, RoutedBatchType, NodeInterface, NodeOutputType } from '@studnicky/dagonizer';
import { DAGBuilder } from '@studnicky/dagonizer/builder';

import type { SquashageBootstrapState } from '../state/SquashageBootstrapState.js';
import type { SquashageServices } from '../services/SquashageServices.js';

type EndOutput = 'done';

/**
 * No-op terminal node that owns the bootstrap-end route.
 *
 * Exported so `registerBootstrapNodes` can register it on the dispatcher.
 * dagonizer requires every SingleNode placement to reference a registered node.
 * Routes every batch item to 'done' unchanged.
 */
class BootstrapEndNodeImpl extends ScalarNode<SquashageBootstrapState, EndOutput, SquashageServices> {
  public readonly name    = 'bootstrap-end';
  public readonly outputs = ['done'] as const;

  public override get outputSchema(): Record<EndOutput, { type: 'object' }> {
    return { done: { type: 'object' } };
  }

  protected override async executeOne(
    _state:   SquashageBootstrapState,
    _context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<EndOutput>> {
    return NodeOutputBuilder.of('done');
  }
}

/**
 * Stub for inline gate nodes within this file — they are registered on the
 * dispatcher by registerBootstrapNodes (via bootstrapEndNode), but the
 * refine-required-gate and build-ready-gate nodes are registered from their
 * own module files imported in registerBootstrapNodes.
 */
function stubBootstrap<TOutput extends string>(
  stubName: string,
  stubOutputs: readonly TOutput[],
): NodeInterface<SquashageBootstrapState, TOutput, SquashageServices> {
  class Stub extends MonadicNode<SquashageBootstrapState, TOutput, SquashageServices> {
    public readonly name    = stubName;
    public readonly outputs = stubOutputs;
    public override get outputSchema(): Record<TOutput, { type: 'object' }> {
      return Object.fromEntries(stubOutputs.map((o) => [o, { type: 'object' }])) as Record<TOutput, { type: 'object' }>;
    }
    public override async execute(
      _b: Batch<SquashageBootstrapState>,
      _c: NodeContextType<SquashageServices>,
    ): Promise<RoutedBatchType<TOutput, SquashageBootstrapState>> {
      throw new Error(`stub '${stubName}' called; register the real node on the dispatcher`);
    }
  }
  return new Stub();
}

export const bootstrapEndNode = new BootstrapEndNodeImpl();

// A real no-op instance for use inside the DAGBuilder inline node position —
// the dispatcher will resolve the name at execution time.
class BootstrapEndStubImpl extends MonadicNode<SquashageBootstrapState, EndOutput, SquashageServices> {
  public readonly name    = 'bootstrap-end';
  public readonly outputs = ['done'] as const;
  public override get outputSchema(): Record<EndOutput, { type: 'object' }> {
    return { done: { type: 'object' } };
  }
  public override async execute(
    _b: Batch<SquashageBootstrapState>,
    _c: NodeContextType<SquashageServices>,
  ): Promise<RoutedBatchType<EndOutput, SquashageBootstrapState>> {
    throw new Error('bootstrap-end stub called; register the real node on the dispatcher');
  }
}

// Inline node used in .node() placement — resolved by name at runtime.
const bootstrapEndStub = new BootstrapEndStubImpl();

export const bootstrapDag: DAGType = new DAGBuilder('squashage:bootstrap', '1.0')
  .embeddedDAG(
    'induce',
    'squashage:induce',
    { success: 'refine-required-gate', error: 'bootstrap-end' },
    {
      outputs: {
        'discoveredClasses': 'discoveredClasses',
        'draftsWritten':     'draftsWritten',
        'observedRecords':   'observedRecords',
      },
    },
  )

  .node(
    'refine-required-gate',
    stubBootstrap('refine-required-gate', ['refinements-present', 'refinements-absent'] as const),
    {
      'refinements-present': 'refine',
      'refinements-absent':  'bootstrap-end',
    },
  )

  .embeddedDAG(
    'refine',
    'squashage:refine',
    { success: 'build-ready-gate', error: 'bootstrap-end' },
    {
      outputs: {
        'refinedCount':     'refinedCount',
        'passthroughCount': 'passthroughCount',
      },
    },
  )

  .node(
    'build-ready-gate',
    stubBootstrap('build-ready-gate', ['schemas-present', 'schemas-absent'] as const),
    {
      'schemas-present': 'build',
      'schemas-absent':  'bootstrap-end',
    },
  )

  .embeddedDAG(
    'build',
    'squashage:run',
    { success: 'bootstrap-end', error: 'bootstrap-end' },
  )

  .node('bootstrap-end', bootstrapEndStub, { done: 'end' })

  .terminal('end')
  .entrypoint('induce')
  .build();
