import test from 'node:test';
import assert from 'node:assert/strict';

import { Dagonizer, NodeStateBase, ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';
import { DAGBuilder } from '@studnicky/dagonizer/builder';

test('Dagonizer executes a single-node DAG end-to-end', async () => {
  class SmokeState extends NodeStateBase {
    greeting = '';
  }

  type GreetOutput = 'success';

  class GreetNodeImpl extends ScalarNode<SmokeState, GreetOutput> {
    public readonly name    = 'greet';
    public readonly outputs = ['success'] as const;

    public override get outputSchema(): Record<GreetOutput, { type: 'object' }> {
      return { success: { type: 'object' } };
    }

    protected override async executeOne(
      state:    SmokeState,
      _context: NodeContextType<undefined>,
    ): Promise<NodeOutputType<GreetOutput>> {
      state.greeting = 'hello';
      return NodeOutputBuilder.of('success');
    }
  }

  const greet = new GreetNodeImpl();

  const dag = new DAGBuilder('smoke', '1.0')
    .node('greet', greet, { success: 'end' })
    .terminal('end')
    .build();

  const dispatcher = new Dagonizer<SmokeState>();
  dispatcher.registerNode(greet);
  dispatcher.registerDAG(dag);

  const result = await dispatcher.execute('smoke', new SmokeState());

  assert.equal(result.state.greeting, 'hello');
  assert.equal(result.state.lifecycle.variant, 'completed');
  assert.equal(result.cursor, null);
});
