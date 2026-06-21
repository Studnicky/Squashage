/**
 * classify:source — emits a `__source__` metadata-gate proposal when the
 * record carries a `_source` block. Never proposes a class; the conflict
 * resolver filters this sentinel before picking a winner.
 *
 * Stateless — const literal node.
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../../services/SquashageServices.js';
import type { SquashageRecordState } from '../../../state/SquashageRecordState.js';

type Output = 'proposed' | 'no-match';

class SourceClassifierNodeImpl extends ScalarNode<SquashageRecordState, Output, SquashageServices> {
  public readonly name    = 'classify:source';
  public readonly outputs = ['proposed', 'no-match'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { proposed: { type: 'object' }, 'no-match': { type: 'object' } };
  }

  protected override async executeOne(
    state:    SquashageRecordState,
    _context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const raw = state.input['_source'];
    if (!SourceClassifierNodeImpl.isPlainObject(raw)) {
      return NodeOutputBuilder.of('no-match');
    }

    const reasons: string[] = [];
    if (typeof raw['target']   === 'string') reasons.push(`source.target=${raw['target']}`);
    if (typeof raw['plugin']   === 'string') reasons.push(`source.plugin=${raw['plugin']}`);
    if (typeof raw['schemaId'] === 'string') reasons.push(`source.schemaId=${raw['schemaId']}`);

    state.proposals['classify:source'] = {
      source:     'classify:source',
      className:  '__source__',
      priority:   0,
      confidence: 1,
      reasons,
    };
    return NodeOutputBuilder.of('proposed');
  }

  private static isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

export const sourceClassifierNode = new SourceClassifierNodeImpl();
