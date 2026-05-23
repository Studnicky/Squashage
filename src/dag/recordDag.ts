/**
 * recordDag — per-record deep-DAG registered under the name
 * `'squashage:record'`. Invoked by the run-scope DAG's fan-out placement, one
 * execution per `RecordLocator`.
 *
 * Topology:
 *
 *   json-read ─loaded──► classify-all (parallel: source, url-pattern, structural)
 *                                            │
 *                              success/error │
 *                                            ▼
 *                                  record-health-gate
 *                                            │
 *                  has-proposals / errors / none
 *                       │           │         │
 *                       ▼           ▼         ▼
 *               classify-conflict  rq        rq
 *                       │
 *           resolved / tie / unknown
 *                       │
 *                       ▼
 *                     squash ──squashed──► output-provenance ──► END
 *                       │                                 │
 *                  quarantined                       (written/skipped → END)
 *                       │
 *                       ▼
 *                record-quarantine ──► END
 *
 * Quarantine is a real DAG path: every failure-route lands on
 * `record-quarantine` which writes the failed-records dump file and ends the
 * per-record execution via output→null.
 *
 * The placement objects reference nodes by name only. The actual node
 * instances (some class-based, requiring per-target config) are registered on
 * the dispatcher in `registerRecordNodes(...)` inside `SquashageRun`.
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
 * instance is registered separately on the dispatcher. The `execute` is never
 * invoked through this object — the dispatcher resolves nodes by name at
 * execute time.
 */
function stub<TOutput extends string>(name: string, outputs: readonly TOutput[]): StubFor<TOutput> {
  return {
    name,
    outputs,
    async execute() { throw new Error(`stub for ${name} called; the real node must be registered on the dispatcher`); },
  };
}

export const recordDag: DAG = new DAGBuilder('squashage:record', '1.0')
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
    validated: 'classify:taxonomic-narrowing',
    'no-match': 'classify:taxonomic-narrowing',
  })
  .node('classify:taxonomic-narrowing', stub('classify:taxonomic-narrowing', ['narrowed', 'no-op'] as const), {
    narrowed: 'record-health-gate',
    'no-op':   'record-health-gate',
  })

  .node('record-health-gate', stub('record-health-gate', ['has-proposals', 'none', 'errors'] as const), {
    'has-proposals': 'classify-conflict',
    none:            'record-quarantine',
    errors:          'record-quarantine',
  })

  .node('classify-conflict', stub('classify-conflict', ['resolved', 'tie', 'unknown'] as const), {
    resolved: 'squash',
    tie:      'record-quarantine',
    unknown:  'record-quarantine',
  })

  .node('squash', stub('squash', ['squashed', 'quarantined'] as const), {
    squashed:    'output-provenance',
    quarantined: 'record-quarantine',
  })

  .node('output-provenance', stub('output-provenance', ['written', 'skipped'] as const), {
    written: null,
    skipped: null,
  })

  .node('record-quarantine', stub('record-quarantine', ['recorded'] as const), {
    recorded: null,
  })

  .entrypoint('json-read')
  .build();
