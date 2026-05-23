/**
 * recordInduceDag — per-record deep-DAG registered under the name
 * `'squashage:record-induce'`. Invoked by the induce-scope DAG's fan-out
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

import type { DAG } from '@noocodex/dagonizer/entities';
import type { NodeInterface } from '@noocodex/dagonizer';
import { DAGBuilder } from '@noocodex/dagonizer/builder';

import type { SquashageRecordState } from '../state/SquashageRecordState.js';
import type { SquashageServices } from '../services/SquashageServices.js';
import { classifyAllParallelMembers } from './recordDagClassifierMembers.js';

type StubFor<TOutput extends string> =
  NodeInterface<SquashageRecordState, TOutput, SquashageServices>;

/**
 * Type-only stub used to satisfy DAGBuilder's signature for nodes whose real
 * instance is registered separately on the dispatcher.
 */
function stub<TOutput extends string>(name: string, outputs: readonly TOutput[]): StubFor<TOutput> {
  return {
    name,
    outputs,
    async execute() { throw new Error(`stub for ${name} called; the real node must be registered on the dispatcher`); },
  };
}

export const recordInduceDag: DAG = new DAGBuilder('squashage:record-induce', '1.0')
  .node('json-read', stub('json-read', ['loaded', 'quarantined'] as const), {
    loaded:      'classify-all',
    quarantined: 'record-quarantine',
  })

  .parallel(
    'classify-all',
    classifyAllParallelMembers,
    'collect',
    { success: 'classify:ontology', error: 'classify:ontology' },
  )

  .node('classify:discriminator',         stub('classify:discriminator',         ['proposed', 'no-match'] as const), { proposed: null, 'no-match': null })
  .node('classify:source',                stub('classify:source',                ['proposed', 'no-match'] as const), { proposed: null, 'no-match': null })
  .node('classify:url-pattern',           stub('classify:url-pattern',           ['proposed', 'no-match'] as const), { proposed: null, 'no-match': null })
  .node('classify:structural',            stub('classify:structural',            ['proposed', 'no-match'] as const), { proposed: null, 'no-match': null })
  .node('classify:rules',                 stub('classify:rules',                 ['proposed', 'no-match'] as const), { proposed: null, 'no-match': null })
  .node('classify:schema',                stub('classify:schema',                ['proposed', 'no-match'] as const), { proposed: null, 'no-match': null })
  .node('classify:shacl-shape',           stub('classify:shacl-shape',           ['proposed', 'no-match'] as const), { proposed: null, 'no-match': null })
  .node('classify:property-fingerprint',  stub('classify:property-fingerprint',  ['proposed', 'no-match'] as const), { proposed: null, 'no-match': null })
  .node('classify:winknlp-entities',      stub('classify:winknlp-entities',      ['proposed', 'no-match'] as const), { proposed: null, 'no-match': null })

  // Post-parallel sequential classifiers (read other classifiers' proposals).
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
    observed: null,
    skipped:  null,
  })

  .node('record-quarantine', stub('record-quarantine', ['recorded'] as const), {
    recorded: null,
  })

  .entrypoint('json-read')
  .build();
