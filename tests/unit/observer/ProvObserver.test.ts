import test from 'node:test';
import assert from 'node:assert/strict';

import { dataFactory } from '../../../src/rdf/DataFactory.js';
import { Dataset } from '../../../src/rdf/Dataset.js';
import { Logger } from '../../../src/modules/logger/logger.js';
import { ProvObserver } from '../../../src/observer/ProvObserver.js';
import type { LoggerFactoryInterface } from '../../../src/types/Logger.js';

const PROV   = 'http://www.w3.org/ns/prov#';
const DAGNS  = 'https://noocodex.dev/dagonizer/vocabulary#';

test('happy path', async (t) => {
  await t.test('records a complete prov:Activity chain for a 2-node run', () => {
    const factory = dataFactory;
    const dataset = Dataset.empty();
    const logger  = Logger as unknown as LoggerFactoryInterface;
    const observer = new ProvObserver({
      factory, dataset, runId: '2026-05-18T00:00:00Z',
      dispatcherAgentId: 'squashage-test', logger,
    });

    observer.recordFlowStart('squashage:run');
    observer.recordNodeStart('walk-input');
    observer.recordNodeEnd('walk-input', 'success');
    observer.recordNodeStart('rdfjs-finalize');
    observer.recordNodeEnd('rdfjs-finalize', 'written');
    observer.recordFlowEnd('squashage:run', 'completed');

    // Every quad lives in the PROV graph.
    let total = 0;
    let provGraphCount = 0;
    for (const q of dataset) {
      total += 1;
      if (q.graph.value.startsWith('urn:squashage:prov:')) provGraphCount += 1;
    }
    assert.equal(total, provGraphCount, 'every quad goes to the PROV graph');
    assert.ok(total > 0);

    // Activity chain: 3 activities (run + 2 nodes).
    const types = [...dataset].filter(
      (q) => q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
             q.object.value    === `${PROV}Activity`,
    );
    assert.equal(types.length, 3);

    // Both node-execution activities carry a dag:NodeExecution type.
    const nodeExecs = [...dataset].filter(
      (q) => q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
             q.object.value    === `${DAGNS}NodeExecution`,
    );
    assert.equal(nodeExecs.length, 2);

    // Lifecycle terminal value lands on the run activity.
    const lifecycle = [...dataset].find((q) => q.predicate.value === `${DAGNS}lifecycle`);
    assert.ok(lifecycle);
    assert.equal(lifecycle.object.value, 'completed');
  });
});

test('edge cases', async (t) => {
  await t.test('records error on node activity and closes it', () => {
    const factory = dataFactory;
    const dataset = Dataset.empty();
    const logger  = Logger as unknown as LoggerFactoryInterface;
    const observer = new ProvObserver({
      factory, dataset, runId: 'r1', dispatcherAgentId: 'x', logger,
    });
    observer.recordFlowStart('d');
    observer.recordNodeStart('boom');
    observer.recordError('boom', new Error('explosion'));
    observer.recordFlowEnd('d', 'failed');

    const errorQuad = [...dataset].find(
      (q) => q.predicate.value === `${DAGNS}error`,
    );
    assert.ok(errorQuad);
    assert.equal(errorQuad.object.value, 'explosion');
  });
});

test('unhappy path', async (t) => {
  await t.test('recordNodeEnd / recordError silently drop when no matching start', () => {
    const factory = dataFactory;
    const dataset = Dataset.empty();
    const logger  = Logger as unknown as LoggerFactoryInterface;
    const observer = new ProvObserver({
      factory, dataset, runId: 'r1', dispatcherAgentId: 'x', logger,
    });
    observer.recordNodeEnd('never-started', 'success');
    observer.recordError('never-started', new Error('still no'));
    assert.equal(dataset.size, 0);
  });
});
