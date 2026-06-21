/**
 * SquashageDagonizer — Dagonizer subclass that forwards the five lifecycle
 * hooks to an injected ProvObserver.
 *
 * The observer is a constructor parameter and may be swapped between
 * `ProvObserver` (PROV-O writer) and `NullObserver` (tests). The dispatcher
 * knows nothing about PROV-O — it just forwards.
 */

import { Dagonizer } from '@studnicky/dagonizer';
import type { ExecutionResultType, NodeStateInterface } from '@studnicky/dagonizer';

import type { ProvObserverInterface } from '../observer/ProvObserverInterface.js';
import type { SquashageServices } from '../services/SquashageServices.js';

export interface SquashageDagonizerOptionsInterface {
  readonly services: SquashageServices;
  readonly observer: ProvObserverInterface;
}

export class SquashageDagonizer<TState extends NodeStateInterface>
  extends Dagonizer<TState, SquashageServices> {

  readonly #observer: ProvObserverInterface;

  constructor(options: SquashageDagonizerOptionsInterface) {
    super({ services: options.services });
    this.#observer = options.observer;
  }

  protected override onFlowStart(dagName: string, _state: TState): void {
    this.#observer.recordFlowStart(dagName);
  }

  protected override onFlowEnd(
    dagName: string,
    state:   TState,
    _result: ExecutionResultType<NodeStateInterface>,
  ): void {
    this.#observer.recordFlowEnd(dagName, state.lifecycle.variant);
  }

  protected override onNodeStart(
    nodeName: string,
    _state: TState,
    _placementPath: readonly string[],
  ): void {
    this.#observer.recordNodeStart(nodeName);
  }

  protected override onNodeEnd(
    nodeName: string,
    output:   string | null,
    _state:   TState,
    _placementPath: readonly string[],
  ): void {
    this.#observer.recordNodeEnd(nodeName, output);
  }

  protected override onError(
    nodeName: string,
    error: Error,
    _state: TState,
    _placementPath: readonly string[],
  ): void {
    this.#observer.recordError(nodeName, error);
  }
}
