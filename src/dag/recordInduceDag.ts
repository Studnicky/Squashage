/**
 * recordInduceDag — per-record deep-DAG registered under the name
 * `'squashage:record-induce'`. Invoked by the induce-scope DAG's scatter
 * placement, one execution per `RecordLocator`.
 *
 * Topology mirrors `recordDag` up through `classify-conflict`. The tail
 * differs: `squash → output-provenance` is replaced by a single `shape-observe`
 * node that folds `state.input` into `services.shapeCache.<className>`.
 *
 * All classification nodes (`json-read`, `classify:*`, `record-health-gate`,
 * `classify-conflict`, `record-quarantine`) are shared with `squashage:record`
 * — they are registered once on the dispatcher and referenced by name from
 * both DAGs.
 *
 * The only new per-record node is `shape-observe`, registered in
 * `registerInduceNodes`.
 */

import type { DAGType } from '@studnicky/dagonizer';
import { MonadicNode } from '@studnicky/dagonizer';
import type { Batch, NodeContextType, RoutedBatchType, NodeInterface } from '@studnicky/dagonizer';
import { DAGBuilder } from '@studnicky/dagonizer/builder';

import type { SquashageRecordState } from '../state/SquashageRecordState.js';
import type { SquashageServices } from '../services/SquashageServices.js';
import { recordInitNode } from './recordInitNode.js';

type StubFor<TOutput extends string> =
  NodeInterface<SquashageRecordState, TOutput, SquashageServices>;

/**
 * Type-only stub used to satisfy DAGBuilder's signature for nodes whose real
 * instance is registered separately on the dispatcher.
 */
function stub<TOutput extends string>(stubName: string, stubOutputs: readonly TOutput[]): StubFor<TOutput> {
  class Stub extends MonadicNode<SquashageRecordState, TOutput, SquashageServices> {
    public readonly name    = stubName;
    public readonly outputs = stubOutputs;
    public override get outputSchema(): Record<TOutput, { type: 'object' }> {
      return Object.fromEntries(stubOutputs.map((o) => [o, { type: 'object' }])) as Record<TOutput, { type: 'object' }>;
    }
    public override async execute(
      _b: Batch<SquashageRecordState>,
      _c: NodeContextType<SquashageServices>,
    ): Promise<RoutedBatchType<TOutput, SquashageRecordState>> {
      throw new Error(`stub '${stubName}' called; register the real node on the dispatcher`);
    }
  }
  return new Stub();
}

export const recordInduceDag: DAGType = new DAGBuilder('squashage:record-induce', '1.0')
  // record-init seeds recordPath/recordLine/source from currentLocator metadata.
  // Runs as entrypoint (not pre-phase) because scatter bodies use embedded:true.
  .node('record-init', recordInitNode, {
    done: 'json-read',
  })

  .node('json-read', stub('json-read', ['loaded', 'quarantined'] as const), {
    loaded:      'classify:discriminator',
    quarantined: 'record-quarantine',
  })

  // Sequential classifier chain (each writes its own proposals slot)
  .node('classify:discriminator',         stub('classify:discriminator',         ['proposed', 'no-match'] as const), { proposed: 'classify:source',               'no-match': 'classify:source' })
  .node('classify:source',                stub('classify:source',                ['proposed', 'no-match'] as const), { proposed: 'classify:url-pattern',          'no-match': 'classify:url-pattern' })
  .node('classify:url-pattern',           stub('classify:url-pattern',           ['proposed', 'no-match'] as const), { proposed: 'classify:structural',           'no-match': 'classify:structural' })
  .node('classify:structural',            stub('classify:structural',            ['proposed', 'no-match'] as const), { proposed: 'classify:rules',                'no-match': 'classify:rules' })
  .node('classify:rules',                 stub('classify:rules',                 ['proposed', 'no-match'] as const), { proposed: 'classify:schema',               'no-match': 'classify:schema' })
  .node('classify:schema',                stub('classify:schema',                ['proposed', 'no-match'] as const), { proposed: 'classify:shacl-shape',          'no-match': 'classify:shacl-shape' })
  .node('classify:shacl-shape',           stub('classify:shacl-shape',           ['proposed', 'no-match'] as const), { proposed: 'classify:property-fingerprint', 'no-match': 'classify:property-fingerprint' })
  .node('classify:property-fingerprint',  stub('classify:property-fingerprint',  ['proposed', 'no-match'] as const), { proposed: 'classify:winknlp-entities',     'no-match': 'classify:winknlp-entities' })
  .node('classify:winknlp-entities',      stub('classify:winknlp-entities',      ['proposed', 'no-match'] as const), { proposed: 'classify:ontology',             'no-match': 'classify:ontology' })

  // Post-chain sequential classifiers (read other classifiers' proposals).
  .node('classify:ontology', stub('classify:ontology', ['validated', 'no-match'] as const), {
    validated:  'classify:taxonomic-narrowing',
    'no-match': 'classify:taxonomic-narrowing',
  })
  .node('classify:taxonomic-narrowing', stub('classify:taxonomic-narrowing', ['narrowed', 'no-op'] as const), {
    narrowed: 'record-health-gate',
    'no-op':  'record-health-gate',
  })

  .node('record-health-gate', stub('record-health-gate', ['has-proposals', 'none', 'errors'] as const), {
    'has-proposals': 'classify-conflict',
    none:            'record-quarantine',
    errors:          'record-quarantine',
  })

  .node('classify-conflict', stub('classify-conflict', ['resolved', 'tie', 'unknown'] as const), {
    resolved: 'shape-observe',
    tie:      'record-quarantine',
    unknown:  'record-quarantine',
  })

  // shape-observe replaces squash + output-provenance in the induce DAG.
  .node('shape-observe', stub('shape-observe', ['observed', 'skipped'] as const), {
    observed: 'end',
    skipped:  'end',
  })

  .node('record-quarantine', stub('record-quarantine', ['recorded'] as const), {
    recorded: 'end',
  })

  .terminal('end')
  .entrypoint('record-init')
  .build();
