/**
 * PROV-O + dag: vocabulary constants used by ProvObserver.
 *
 * The observer writes every node execution as a `prov:Activity` into a
 * dedicated named graph (`urn:squashage:prov:<runId>`). The Squashage CLI
 * serializes this graph to a separate file alongside the success graph.
 */

import type { DataFactory, NamedNode } from '@rdfjs/types';

const PROV_NS = 'http://www.w3.org/ns/prov#';
const RDF_NS  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD_NS  = 'http://www.w3.org/2001/XMLSchema#';
const DAG_NS  = 'https://noocodex.dev/dagonizer/vocabulary#';
const SQ_NS   = 'https://squashage.dev/vocabulary#';

/** PROV-O term IRIs as `NamedNode` factories closed over a DataFactory. */
export class ProvVocabulary {
  readonly Activity:          NamedNode;
  readonly Agent:             NamedNode;
  readonly SoftwareAgent:     NamedNode;
  readonly startedAtTime:     NamedNode;
  readonly endedAtTime:       NamedNode;
  readonly wasAssociatedWith: NamedNode;
  readonly wasInformedBy:     NamedNode;
  readonly rdfType:           NamedNode;
  readonly xsdDateTime:       NamedNode;
  readonly xsdString:         NamedNode;
  readonly dagRun:            NamedNode;
  readonly dagNodeExecution:  NamedNode;
  readonly dagDagName:        NamedNode;
  readonly dagNodeName:       NamedNode;
  readonly dagOutput:         NamedNode;
  readonly dagLifecycle:      NamedNode;
  readonly dagError:          NamedNode;
  readonly sqDispatcher:      NamedNode;

  constructor(factory: DataFactory) {
    this.Activity          = factory.namedNode(`${PROV_NS}Activity`);
    this.Agent             = factory.namedNode(`${PROV_NS}Agent`);
    this.SoftwareAgent     = factory.namedNode(`${PROV_NS}SoftwareAgent`);
    this.startedAtTime     = factory.namedNode(`${PROV_NS}startedAtTime`);
    this.endedAtTime       = factory.namedNode(`${PROV_NS}endedAtTime`);
    this.wasAssociatedWith = factory.namedNode(`${PROV_NS}wasAssociatedWith`);
    this.wasInformedBy     = factory.namedNode(`${PROV_NS}wasInformedBy`);
    this.rdfType           = factory.namedNode(`${RDF_NS}type`);
    this.xsdDateTime       = factory.namedNode(`${XSD_NS}dateTime`);
    this.xsdString         = factory.namedNode(`${XSD_NS}string`);
    this.dagRun            = factory.namedNode(`${DAG_NS}Run`);
    this.dagNodeExecution  = factory.namedNode(`${DAG_NS}NodeExecution`);
    this.dagDagName        = factory.namedNode(`${DAG_NS}dagName`);
    this.dagNodeName       = factory.namedNode(`${DAG_NS}nodeName`);
    this.dagOutput         = factory.namedNode(`${DAG_NS}output`);
    this.dagLifecycle      = factory.namedNode(`${DAG_NS}lifecycle`);
    this.dagError          = factory.namedNode(`${DAG_NS}error`);
    this.sqDispatcher      = factory.namedNode(`${SQ_NS}SquashageDispatcher`);
  }

  /** IRI for one `prov:Activity` instance keyed by run + node + timestamp. */
  activity(factory: DataFactory, runId: string, name: string, ts: number): NamedNode {
    return factory.namedNode(
      `urn:squashage:activity:${encodeURIComponent(runId)}:${encodeURIComponent(name)}:${String(ts)}`,
    );
  }

  /** IRI for the dispatcher agent. */
  agent(factory: DataFactory, dispatcherAgentId: string): NamedNode {
    return factory.namedNode(`urn:squashage:agent:${encodeURIComponent(dispatcherAgentId)}`);
  }

  /** Named graph IRI for one run's PROV-O graph. */
  graph(factory: DataFactory, runId: string): NamedNode {
    return factory.namedNode(`urn:squashage:prov:${encodeURIComponent(runId)}`);
  }
}
