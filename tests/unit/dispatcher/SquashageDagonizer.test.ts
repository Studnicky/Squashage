import test from 'node:test';
import assert from 'node:assert/strict';

import { NodeStateBase, Batch, RoutedBatchBuilder, Timeout } from '@studnicky/dagonizer';
import { DAGBuilder } from '@studnicky/dagonizer/builder';
import type { NodeInterface, RoutedBatchType } from '@studnicky/dagonizer';

import { SquashageDagonizer } from '../../../src/dispatcher/SquashageDagonizer.js';
import { SquashageServices } from '../../../src/services/SquashageServices.js';
import type { TargetConfigInterface } from '../../../src/config/SquashageConfig.js';
import type { OutputConfigInterface } from '../../../src/config/OutputConfig.js';

class S extends NodeStateBase {
  steps: string[] = [];
}

const baseTarget: TargetConfigInterface = {
  input:    { basePath: './input/aonprd', format: 'json' },
  output:   { kind: 'file', path: './graphs/aonprd.jsonld' } as OutputConfigInterface,
  graphs:   { default: 'https://squashage.dev/graph/aonprd/default' },
  ontology: { baseIri: 'https://aonprd.example.org/' },
  concurrency: 1,
};

async function buildServices(): Promise<SquashageServices> {
  return SquashageServices.forTarget({
    target:       'aonprd',
    targetConfig: baseTarget,
    output:       baseTarget.output,
    outDir:       './graphs',
    schemasBase:  process.cwd(),
    sampleSource: undefined,
    runStartTime: '2026-05-18T00:00:00Z',
  });
}

test('happy path', async (t) => {
  await t.test('PROV quads land in services.dataset after executing a 2-node DAG', async () => {
    const services = await buildServices();
    const dispatcher = new SquashageDagonizer<S>({ services });

    const PROV = 'http://www.w3.org/ns/prov#';

    const stepA: NodeInterface<S, 'success', SquashageServices> = {
      name: 'a', outputs: ['success'],
      outputSchema: { success: { type: 'object' } },
      timeout: Timeout.none(),
      async execute(batch: Batch<S>): Promise<RoutedBatchType<'success', S>> {
        for (const item of batch) { item.state.steps.push('a'); }
        return RoutedBatchBuilder.of('success', batch);
      },
    };
    const stepB: NodeInterface<S, 'success', SquashageServices> = {
      name: 'b', outputs: ['success'],
      outputSchema: { success: { type: 'object' } },
      timeout: Timeout.none(),
      async execute(batch: Batch<S>): Promise<RoutedBatchType<'success', S>> {
        for (const item of batch) { item.state.steps.push('b'); }
        return RoutedBatchBuilder.of('success', batch);
      },
    };

    const dag = new DAGBuilder('two-step', '1.0')
      .node('a', stepA, { success: 'b' })
      .node('b', stepB, { success: 'end' })
      .terminal('end')
      .build();

    dispatcher.registerNode(stepA);
    dispatcher.registerNode(stepB);
    dispatcher.registerDAG(dag);

    const result = await dispatcher.execute('two-step', new S());

    assert.deepEqual(result.state.steps, ['a', 'b']);
    assert.equal(result.state.lifecycle.variant, 'completed');

    // PROV quads must have landed in services.dataset (no provSink configured).
    assert.ok(services.dataset.size > 0, 'dataset must contain PROV quads after execution');

    const activityQuads = [...services.dataset].filter(
      (q) => q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
             q.object.value    === `${PROV}Activity`,
    );
    // run activity + a activity + b activity + end activity = at least 3
    assert.ok(activityQuads.length >= 3, 'at least 3 prov:Activity quads expected');

    // Every quad must be in the PROV named graph.
    const provGraphCount = [...services.dataset].filter(
      (q) => q.graph.value.startsWith('urn:squashage:prov:'),
    ).length;
    assert.equal(provGraphCount, services.dataset.size, 'all quads must be in the PROV graph');
  });
});

test('edge cases', async (t) => {
  await t.test('executes a run and PROV quads land in services.dataset', async () => {
    const services = await buildServices();
    const dispatcher = new SquashageDagonizer<S>({ services });

    const tick: NodeInterface<S, 'success', SquashageServices> = {
      name: 'tick', outputs: ['success'],
      outputSchema: { success: { type: 'object' } },
      timeout: Timeout.none(),
      async execute(batch: Batch<S>): Promise<RoutedBatchType<'success', S>> {
        for (const item of batch) { item.state.steps.push('tick'); }
        return RoutedBatchBuilder.of('success', batch);
      },
    };
    const dag = new DAGBuilder('one', '1.0')
      .node('tick', tick, { success: 'end' })
      .terminal('end')
      .build();
    dispatcher.registerNode(tick);
    dispatcher.registerDAG(dag);

    const result = await dispatcher.execute('one', new S());
    assert.deepEqual(result.state.steps, ['tick']);
    assert.equal(result.state.lifecycle.variant, 'completed');
    assert.ok(services.dataset.size > 0, 'PROV quads must exist in dataset');
  });
});
