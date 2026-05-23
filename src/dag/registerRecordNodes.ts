/**
 * registerRecordNodes — molecular helper that registers every node referenced
 * by `recordDag` onto a `SquashageDagonizer` instance.
 *
 * Stateless nodes are const-literal exports (registered as-is). Class-based
 * nodes (`ClassifyConflictNode`, classifier classes that hold compiled config,
 * the per-target squash node) are instantiated by the caller with their
 * config slice and passed in. The helper attaches each to the dispatcher.
 *
 * Mirrors the archivist's `registerBookSearchFanoutNodes` pattern from
 * `examples/the-archivist/deepdags/BookSearchFanoutDAG.ts`.
 */

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageDagonizer } from '../dispatcher/SquashageDagonizer.js';
import type { SquashageServices } from '../services/SquashageServices.js';
import type { ClassifyConflictNode } from '../nodes/record/classifyConflict.js';
import { jsonReadNode } from '../nodes/record/jsonRead.js';
import { outputProvenanceNode } from '../nodes/record/outputProvenance.js';
import { recordHealthGateNode } from '../nodes/record/recordHealthGate.js';
import { recordQuarantineNode } from '../nodes/record/recordQuarantine.js';
import { sourceClassifierNode } from '../nodes/record/classifiers/SourceClassifierNode.js';
import { NoOpClassifierNode } from '../nodes/record/classifiers/NoOpClassifierNode.js';
import type { OntologyClassifierNode } from '../nodes/record/classifiers/OntologyClassifierNode.js';
import type { PropertyFingerprintClassifierNode } from '../nodes/record/classifiers/PropertyFingerprintClassifierNode.js';
import type { RulesClassifierNode } from '../nodes/record/classifiers/RulesClassifierNode.js';
import type { SchemaClassifierNode } from '../nodes/record/classifiers/SchemaClassifierNode.js';
import type { ShaclShapeClassifierNode } from '../nodes/record/classifiers/ShaclShapeClassifierNode.js';
import type { StructuralClassifierNode } from '../nodes/record/classifiers/StructuralClassifierNode.js';
import type { TaxonomicNarrowingClassifierNode } from '../nodes/record/classifiers/TaxonomicNarrowingClassifierNode.js';
import type { UrlPatternClassifierNode } from '../nodes/record/classifiers/UrlPatternClassifierNode.js';
import type { WinknlpEntitiesClassifierNode } from '../nodes/record/classifiers/WinknlpEntitiesClassifierNode.js';
import type { DiscriminatorClassifierNode } from '../nodes/record/classifiers/DiscriminatorClassifierNode.js';
import type { SquashNodeInterface } from '../nodes/record/squashNode.js';
import type { SquashageRecordState } from '../state/SquashageRecordState.js';

/**
 * Stateful per-record node instances the caller must construct from config
 * slices. Each field may be `null` when the corresponding classifier is not
 * configured for the target; the DAG references them by name regardless.
 * Unregistered classifier names referenced by the parallel placement will
 * cause `registerDAG` to fail with a clear error, prompting the operator to
 * either add the config or remove the classifier from the parallel members.
 */
export interface RecordNodeInstancesInterface {
  readonly classifyConflict:              ClassifyConflictNode;
  readonly urlPatternClassifier:          UrlPatternClassifierNode          | null;
  readonly structuralClassifier:          StructuralClassifierNode          | null;
  readonly rulesClassifier:               RulesClassifierNode               | null;
  readonly schemaClassifier:              SchemaClassifierNode              | null;
  readonly shaclShapeClassifier:          ShaclShapeClassifierNode          | null;
  readonly propertyFingerprintClassifier: PropertyFingerprintClassifierNode | null;
  readonly winknlpEntitiesClassifier:     WinknlpEntitiesClassifierNode     | null;
  readonly ontologyClassifier:            OntologyClassifierNode            | null;
  readonly taxonomicNarrowingClassifier:  TaxonomicNarrowingClassifierNode  | null;
  readonly discriminatorClassifier:       DiscriminatorClassifierNode       | null;
  readonly squash:                        SquashNodeInterface;
}

type RecordNode = NodeInterface<SquashageRecordState, string, SquashageServices>;

export function registerRecordNodes(
  dispatcher: SquashageDagonizer<SquashageRecordState>,
  instances:  RecordNodeInstancesInterface,
): void {
  dispatcher.registerNode(jsonReadNode as unknown as RecordNode);
  dispatcher.registerNode(sourceClassifierNode as unknown as RecordNode);
  dispatcher.registerNode(recordHealthGateNode as unknown as RecordNode);
  dispatcher.registerNode(recordQuarantineNode as unknown as RecordNode);
  dispatcher.registerNode(outputProvenanceNode as unknown as RecordNode);

  dispatcher.registerNode(instances.classifyConflict as unknown as RecordNode);
  registerOrNoOp(dispatcher, 'classify:url-pattern',           ['proposed', 'no-match'],  instances.urlPatternClassifier);
  registerOrNoOp(dispatcher, 'classify:structural',            ['proposed', 'no-match'],  instances.structuralClassifier);
  registerOrNoOp(dispatcher, 'classify:rules',                 ['proposed', 'no-match'],  instances.rulesClassifier);
  registerOrNoOp(dispatcher, 'classify:schema',                ['proposed', 'no-match'],  instances.schemaClassifier);
  registerOrNoOp(dispatcher, 'classify:shacl-shape',           ['proposed', 'no-match'],  instances.shaclShapeClassifier);
  registerOrNoOp(dispatcher, 'classify:property-fingerprint',  ['proposed', 'no-match'],  instances.propertyFingerprintClassifier);
  registerOrNoOp(dispatcher, 'classify:winknlp-entities',      ['proposed', 'no-match'],  instances.winknlpEntitiesClassifier);
  registerOrNoOp(dispatcher, 'classify:ontology',              ['validated', 'no-match'], instances.ontologyClassifier);
  registerOrNoOp(dispatcher, 'classify:taxonomic-narrowing',   ['narrowed', 'no-op'],     instances.taxonomicNarrowingClassifier);
  registerOrNoOp(dispatcher, 'classify:discriminator',         ['proposed', 'no-match'],  instances.discriminatorClassifier);

  dispatcher.registerNode(instances.squash as unknown as RecordNode);
}

function registerOrNoOp(
  dispatcher: SquashageDagonizer<SquashageRecordState>,
  name:       string,
  outputs:    readonly ('proposed' | 'no-match' | 'validated' | 'narrowed' | 'no-op')[],
  instance:   object | null,
): void {
  if (instance !== null) {
    dispatcher.registerNode(instance as unknown as RecordNode);
  } else {
    dispatcher.registerNode(new NoOpClassifierNode(name, outputs) as unknown as RecordNode);
  }
}
