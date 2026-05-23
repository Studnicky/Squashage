import test from 'node:test';
import assert from 'node:assert/strict';

import { Dagonizer, NodeStateBase } from '@noocodex/dagonizer';
import { DAGBuilder } from '@noocodex/dagonizer/builder';
import type { NodeInterface } from '@noocodex/dagonizer';

test('Dagonizer executes a single-node DAG end-to-end', async () => {
  class SmokeState extends NodeStateBase {
    greeting = '';
  }

  const greet: NodeInterface<SmokeState, 'success'> = {
    name: 'greet',
    outputs: ['success'],
    async execute(state) {
      state.greeting = 'hello';
      return { output: 'success' };
    },
  };

  const dag = new DAGBuilder('smoke', '1.0')
    .node('greet', greet, { success: null })
    .build();

  const dispatcher = new Dagonizer<SmokeState>();
  dispatcher.registerNode(greet);
  dispatcher.registerDAG(dag);

  const result = await dispatcher.execute('smoke', new SmokeState());

  assert.equal(result.state.greeting, 'hello');
  assert.equal(result.state.lifecycle.kind, 'completed');
  assert.equal(result.cursor, null);
});
