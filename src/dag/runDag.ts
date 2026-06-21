/**
 * RunDag — builds the run-scope DAG (`squashage:run`).
 *
 * Topology:
 *
 *   walk-input
 *     ──walked──► process-all-records (scatter, dag=squashage:record, locators)
 *     ──empty ──► rdfjs-finalize
 *
 *   process-all-records
 *     ──all-success──► enrich-entity-link
 *     ──partial     ──► enrich-entity-link
 *     ──all-error   ──► rdfjs-finalize
 *     ──empty       ──► rdfjs-finalize
 *
 *   enrich-entity-link ──enriched/skipped──► ontology-emit
 *   ontology-emit       ──emitted/skipped/error──► rdfjs-finalize
 *   rdfjs-finalize      ──written──► catalog-emit
 *                       ──empty  ──► run-end
 *   catalog-emit        ──emitted/skipped──► run-end
 *   run-end (terminal)
 *
 * `DEFAULT_RECORD_CONCURRENCY` is baked into authored documents. At runtime,
 * `RunDag.build(services.targetConfig.concurrency ?? 1)` overrides it with the
 * live target config value.
 *
 * Semantic delta: the authored document uses `DEFAULT_RECORD_CONCURRENCY = 1`.
 * Production runs pass the actual target concurrency via `RunDag.build(n)`.
 */

import type { DAGType } from '@studnicky/dagonizer';
import { MonadicNode } from '@studnicky/dagonizer';
import type { Batch, NodeContextType, RoutedBatchType, NodeInterface, NodeStateInterface } from '@studnicky/dagonizer';
import { DAGBuilder } from '@studnicky/dagonizer/builder';

type StubFor<TOutput extends string> =
  NodeInterface<NodeStateInterface, TOutput, unknown>;

function stub<TOutput extends string>(stubName: string, stubOutputs: readonly TOutput[]): StubFor<TOutput> {
  class Stub extends MonadicNode<NodeStateInterface, TOutput, unknown> {
    public readonly name    = stubName;
    public readonly outputs = stubOutputs;
    public override get outputSchema(): Record<TOutput, { type: 'object' }> {
      return Object.fromEntries(stubOutputs.map((o) => [o, { type: 'object' }])) as Record<TOutput, { type: 'object' }>;
    }
    public override async execute(
      _b: Batch<NodeStateInterface>,
      _c: NodeContextType<unknown>,
    ): Promise<RoutedBatchType<TOutput, NodeStateInterface>> {
      throw new Error(`stub '${stubName}' called; register the real node on the dispatcher`);
    }
  }
  return new Stub();
}

export class RunDag {
  static readonly DEFAULT_RECORD_CONCURRENCY = 1;

  static build(concurrency: number = RunDag.DEFAULT_RECORD_CONCURRENCY): DAGType {
    return new DAGBuilder('squashage:run', '1.0')
      .node('walk-input',
        stub('walk-input', ['walked', 'empty'] as const),
        { walked: 'process-all-records', empty: 'rdfjs-finalize' })
      .scatter(
        'process-all-records',
        'locators',
        { dag: 'squashage:record' },
        { 'all-success': 'enrich-entity-link', partial: 'enrich-entity-link', 'all-error': 'rdfjs-finalize', empty: 'rdfjs-finalize' },
        {
          gather:      { strategy: 'discard' },
          concurrency,
          itemKey:     'currentLocator',
        },
      )
      .node('enrich-entity-link',
        stub('enrich-entity-link', ['enriched', 'skipped'] as const),
        { enriched: 'ontology-emit', skipped: 'ontology-emit' })
      .node('ontology-emit',
        stub('ontology-emit', ['emitted', 'skipped', 'error'] as const),
        { emitted: 'rdfjs-finalize', skipped: 'rdfjs-finalize', error: 'rdfjs-finalize' })
      .node('rdfjs-finalize',
        stub('rdfjs-finalize', ['written', 'empty'] as const),
        { written: 'catalog-emit', empty: 'run-end' })
      .node('catalog-emit',
        stub('catalog-emit', ['emitted', 'skipped'] as const),
        { emitted: 'run-end', skipped: 'run-end' })
      .terminal('run-end')
      .entrypoint('walk-input')
      .build();
  }
}
