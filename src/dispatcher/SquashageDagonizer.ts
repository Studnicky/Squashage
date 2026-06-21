/**
 * SquashageDagonizer — Dagonizer subclass that writes PROV-O quads directly
 * from the five lifecycle hook overrides.
 *
 * PROV quads are written to `services.provSink` (stream mode) or
 * `services.dataset` (dataset mode) using `services.factory`. The
 * `ProvObserverInterface` indirection layer has been removed — PROV logic
 * lives here, using `ProvVocabulary` for all term construction.
 */

import type { NamedNode, Quad } from '@rdfjs/types';
import { Dagonizer } from '@studnicky/dagonizer';
import type { ExecutionResultType, NodeStateInterface } from '@studnicky/dagonizer';

import { ProvVocabulary } from '../observer/ProvVocabulary.js';
import type { SquashageServices } from '../services/SquashageServices.js';

export interface SquashageDagonizerOptionsInterface {
  readonly services: SquashageServices;
}

export class SquashageDagonizer<TState extends NodeStateInterface>
  extends Dagonizer<TState, SquashageServices> {

  readonly #services:     SquashageServices;
  readonly #vocab:        ProvVocabulary;
  readonly #graph:        NamedNode;
  readonly #agent:        NamedNode;
  readonly #run:          NamedNode;
  #lastActivity:          NamedNode | null = null;
  readonly #activeByNode: Map<string, NamedNode> = new Map();

  constructor(options: SquashageDagonizerOptionsInterface) {
    super({ services: options.services });
    this.#services = options.services;
    this.#vocab    = new ProvVocabulary(options.services.factory);
    this.#graph    = this.#vocab.graph(options.services.factory, options.services.runStartTime);
    this.#agent    = this.#vocab.agent(options.services.factory, `squashage/${options.services.target}`);
    this.#run      = this.#vocab.activity(options.services.factory, options.services.runStartTime, 'run', 0);
  }

  protected override onFlowStart(dagName: string, _state: TState): void {
    this.#typed(this.#agent, this.#vocab.SoftwareAgent);
    this.#typed(this.#run,   this.#vocab.Activity);
    this.#typed(this.#run,   this.#vocab.dagRun);
    this.#assertLiteral(this.#run, this.#vocab.dagDagName, dagName);
    this.#assertDateTime(this.#run, this.#vocab.startedAtTime, new Date());
    this.#assert(this.#run, this.#vocab.wasAssociatedWith, this.#agent);
  }

  protected override onFlowEnd(
    _dagName: string,
    state:    TState,
    _result:  ExecutionResultType<NodeStateInterface>,
  ): void {
    this.#assertDateTime(this.#run, this.#vocab.endedAtTime, new Date());
    this.#assertLiteral(this.#run, this.#vocab.dagLifecycle, state.lifecycle.variant);
  }

  protected override onNodeStart(
    nodeName: string,
    _state: TState,
    _placementPath: readonly string[],
  ): void {
    const ts       = Date.now();
    const activity = this.#vocab.activity(this.#services.factory, this.#services.runStartTime, nodeName, ts);
    this.#typed(activity, this.#vocab.Activity);
    this.#typed(activity, this.#vocab.dagNodeExecution);
    this.#assertLiteral(activity, this.#vocab.dagNodeName, nodeName);
    this.#assertDateTime(activity, this.#vocab.startedAtTime, new Date(ts));
    this.#assert(activity, this.#vocab.wasAssociatedWith, this.#agent);
    this.#assert(activity, this.#vocab.wasInformedBy, this.#lastActivity ?? this.#run);
    this.#lastActivity = activity;
    this.#activeByNode.set(nodeName, activity);
  }

  protected override onNodeEnd(
    nodeName: string,
    output:   string | null,
    _state:   TState,
    _placementPath: readonly string[],
  ): void {
    const activity = this.#activeByNode.get(nodeName);
    if (activity === undefined) return;
    this.#assertDateTime(activity, this.#vocab.endedAtTime, new Date());
    if (output !== null) {
      this.#assertLiteral(activity, this.#vocab.dagOutput, output);
    }
    this.#activeByNode.delete(nodeName);
  }

  protected override onError(
    nodeName: string,
    error: Error,
    _state: TState,
    _placementPath: readonly string[],
  ): void {
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
    const quad: Quad = this.#services.factory.quad(subject, predicate, object, this.#graph);
    if (this.#services.provSink !== null) {
      this.#services.provSink.writeQuad(quad);
    } else {
      this.#services.dataset.add(quad);
    }
  }

  #assertLiteral(subject: NamedNode, predicate: NamedNode, value: string): void {
    const quad: Quad = this.#services.factory.quad(
      subject,
      predicate,
      this.#services.factory.literal(value, this.#vocab.xsdString),
      this.#graph,
    );
    if (this.#services.provSink !== null) {
      this.#services.provSink.writeQuad(quad);
    } else {
      this.#services.dataset.add(quad);
    }
  }

  #assertDateTime(subject: NamedNode, predicate: NamedNode, value: Date): void {
    const quad: Quad = this.#services.factory.quad(
      subject,
      predicate,
      this.#services.factory.literal(value.toISOString(), this.#vocab.xsdDateTime),
      this.#graph,
    );
    if (this.#services.provSink !== null) {
      this.#services.provSink.writeQuad(quad);
    } else {
      this.#services.dataset.add(quad);
    }
  }
}
