/**
 * shape-observe — per-record node for the induce DAG.
 *
 * Folds `state.input` into the `services.shapeCache` entry for the record's
 * classification class. Uses a single check-and-set pattern to initialize the
 * entry when first seen; Map operations in V8 are atomic at the JS layer so
 * the only race (under fan-out concurrency) is between `has` and `set`, which
 * is handled by the guarded write below.
 *
 * Outputs:
 *   observed — record successfully folded into shapeCache
 *   skipped  — state.classification is null (no classification; nothing to fold)
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import { ShapeObservationAccumulator } from '../../induction/ShapeObservation.js';
import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRecordState } from '../../state/SquashageRecordState.js';

type Output = 'observed' | 'skipped';

class ShapeObserveNodeImpl extends ScalarNode<SquashageRecordState, Output, SquashageServices> {
  public readonly name    = 'shape-observe';
  public readonly outputs = ['observed', 'skipped'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { observed: { type: 'object' }, skipped: { type: 'object' } };
  }

  protected override async executeOne(
    state:   SquashageRecordState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    // If the record has no classification the classify chain already routed it;
    // nothing to fold.
    if (state.classification === null) {
      return NodeOutputBuilder.of('skipped');
    }

    const { shapeCache } = context.services;
    const className = state.classification.type;

    // Single check-and-set: initialize the observation entry on first contact
    // for this className. Concurrent fan-out workers may race here; the worst
    // case is a transient duplicate write of an empty observation that is
    // immediately overwritten — harmless for fold correctness.
    if (!shapeCache.has(className)) {
      shapeCache.set(className, ShapeObservationAccumulator.createEmpty(className));
    }

    const observation = shapeCache.get(className)!;
    ShapeObservationAccumulator.fold(observation, state.input);

    return NodeOutputBuilder.of('observed');
  }
}

export const shapeObserveNode = new ShapeObserveNodeImpl();
