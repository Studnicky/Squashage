import test from 'node:test';
import assert from 'node:assert/strict';

import { NodeStateBase, Batch, RoutedBatchBuilder, Timeout } from '@studnicky/dagonizer';
import { DAGBuilder } from '@studnicky/dagonizer/builder';
import type { NodeInterface, RoutedBatchType } from '@studnicky/dagonizer';

import { SquashageDagonizer } from '../../../src/dispatcher/SquashageDagonizer.js';
import { NullObserver } from '../../../src/observer/NullObserver.js';
import type { ProvObserverInterface } from '../../../src/observer/ProvObserverInterface.js';
import { SquashageServices } from '../../../src/services/SquashageServices.js';
import type { TargetConfigInterface } from '../../../src/config/SquashageConfig.js';
import type { OutputConfigInterface } from '../../../src/config/OutputConfig.js';

class S extends NodeStateBase {
  steps: string[] = [];
}

const baseTarget: TargetConfigInterface = {
  input:    './input/aonprd',
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

class RecordingObserver implements ProvObserverInterface {
  readonly calls: string[] = [];
  recordFlowStart(dagName: string): void { this.calls.push(`flowStart:${dagName}`); }
  recordFlowEnd(dagName: string, kind: string): void { this.calls.push(`flowEnd:${dagName}:${kind}`); }
  recordNodeStart(name: string): void { this.calls.push(`nodeStart:${name}`); }
  recordNodeEnd(name: string, output: string | undefined): void { this.calls.push(`nodeEnd:${name}:${output ?? '∅'}`); }
  recordError(name: string, err: Error): void { this.calls.push(`error:${name}:${err.message}`); }
}

test('happy path', async (t) => {
  await t.test('forwards every lifecycle event to the injected observer in order', async () => {
    const services = await buildServices();
    const observer = new RecordingObserver();
    const dispatcher = new SquashageDagonizer<S>({ services, observer });

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
    assert.deepEqual(observer.calls, [
      'flowStart:two-step',
      'nodeStart:a', 'nodeEnd:a:success',
      'nodeStart:b', 'nodeEnd:b:success',
      'nodeStart:end', 'nodeEnd:end:completed',
      'flowEnd:two-step:completed',
    ]);
  });
});

test('edge cases', async (t) => {
  await t.test('accepts NullObserver and executes without observer side effects', async () => {
    const services = await buildServices();
    const dispatcher = new SquashageDagonizer<S>({ services, observer: new NullObserver() });

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
  });
});
