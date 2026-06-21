/**
 * ProvObserver — writes one `prov:Activity` per node execution into a
 * dedicated PROV-O graph in the run's dataset.
 *
 * Engine-agnostic. The SquashageDagonizer subclass forwards each of the five
 * lifecycle hooks (onFlowStart, onFlowEnd, onNodeStart, onNodeEnd, onError)
 * here. The observer never throws — failures are logged via the injected
 * logger.
 *
 * Quads land in `urn:squashage:prov:<runId>`; the run-scope `rdfjs-finalize`
 * node serializes that graph to a separate file alongside the success graph.
 */

import type { DataFactory, DatasetCore, NamedNode } from '@rdfjs/types';

import type { LoggerFactoryInterface, ComponentLoggerInterface } from '../types/Logger.js';
import { ProvVocabulary } from './ProvVocabulary.js';
import type { ProvObserverInterface } from './ProvObserverInterface.js';

export interface ProvObserverOptionsInterface {
  readonly factory:           DataFactory;
  readonly dataset:           DatasetCore;
  readonly runId:             string;
  readonly dispatcherAgentId: string;
  readonly logger:            LoggerFactoryInterface;
}

export class ProvObserver implements ProvObserverInterface {
  readonly #factory:    DataFactory;
  readonly #dataset:    DatasetCore;
  readonly #runId:      string;
  readonly #graph:      NamedNode;
  readonly #agent:      NamedNode;
  readonly #run:        NamedNode;
  readonly #vocab:      ProvVocabulary;
  readonly #log:        ComponentLoggerInterface;
  #lastActivity:        NamedNode | null;
  readonly #activeByNode: Map<string, NamedNode>;

  constructor(options: ProvObserverOptionsInterface) {
    this.#factory      = options.factory;
    this.#dataset      = options.dataset;
    this.#runId        = options.runId;
    this.#vocab        = new ProvVocabulary(options.factory);
    this.#graph        = this.#vocab.graph(options.factory, options.runId);
    this.#agent        = this.#vocab.agent(options.factory, options.dispatcherAgentId);
    this.#run          = this.#vocab.activity(options.factory, options.runId, 'run', 0);
    this.#log          = options.logger.forComponent('ProvObserver');
    this.#lastActivity = null;
    this.#activeByNode = new Map();
  }

  recordFlowStart(dagName: string): void {
    this.#typed(this.#agent, this.#vocab.SoftwareAgent);
    this.#typed(this.#run,   this.#vocab.Activity);
    this.#typed(this.#run,   this.#vocab.dagRun);
    this.#assertLiteral(this.#run, this.#vocab.dagDagName, dagName);
    this.#assertDateTime(this.#run, this.#vocab.startedAtTime, new Date());
    this.#assert(this.#run, this.#vocab.wasAssociatedWith, this.#agent);
    this.#log.debug('recordFlowStart', 'PROV run activity opened', { dagName, runId: this.#runId });
  }

  recordFlowEnd(_dagName: string, lifecycleKind: string): void {
    this.#assertDateTime(this.#run, this.#vocab.endedAtTime, new Date());
    this.#assertLiteral(this.#run, this.#vocab.dagLifecycle, lifecycleKind);
    this.#log.debug('recordFlowEnd', 'PROV run activity closed', { lifecycleKind });
  }

  recordNodeStart(nodeName: string): void {
    const ts = Date.now();
    const activity = this.#vocab.activity(this.#factory, this.#runId, nodeName, ts);
    this.#typed(activity, this.#vocab.Activity);
    this.#typed(activity, this.#vocab.dagNodeExecution);
    this.#assertLiteral(activity, this.#vocab.dagNodeName, nodeName);
    this.#assertDateTime(activity, this.#vocab.startedAtTime, new Date(ts));
    this.#assert(activity, this.#vocab.wasAssociatedWith, this.#agent);
    this.#assert(activity, this.#vocab.wasInformedBy, this.#lastActivity ?? this.#run);
    this.#lastActivity = activity;
    this.#activeByNode.set(nodeName, activity);
  }

  recordNodeEnd(nodeName: string, output: string | null): void {
    const activity = this.#activeByNode.get(nodeName);
    if (activity === undefined) return;
    this.#assertDateTime(activity, this.#vocab.endedAtTime, new Date());
    if (output !== null) {
      this.#assertLiteral(activity, this.#vocab.dagOutput, output);
    }
    this.#activeByNode.delete(nodeName);
  }

  recordError(nodeName: string, error: Error): void {
    const activity = this.#activeByNode.get(nodeName);
    if (activity === undefined) return;
    this.#assertLiteral(activity, this.#vocab.dagError, error.message);
    this.#assertDateTime(activity, this.#vocab.endedAtTime, new Date());
    this.#activeByNode.delete(nodeName);
  }

  #typed(subject: NamedNode, type: NamedNode): void {
    this.#assert(subject, this.#vocab.rdfType, type);
  }

  #assert(subject: NamedNode, predicate: NamedNode, object: NamedNode): void {
    this.#dataset.add(
      this.#factory.quad(subject, predicate, object, this.#graph),
    );
  }

  #assertLiteral(subject: NamedNode, predicate: NamedNode, value: string): void {
    this.#dataset.add(
      this.#factory.quad(
        subject,
        predicate,
        this.#factory.literal(value, this.#vocab.xsdString),
        this.#graph,
      ),
    );
  }

  #assertDateTime(subject: NamedNode, predicate: NamedNode, value: Date): void {
    this.#dataset.add(
      this.#factory.quad(
        subject,
        predicate,
        this.#factory.literal(value.toISOString(), this.#vocab.xsdDateTime),
        this.#graph,
      ),
    );
  }
}
