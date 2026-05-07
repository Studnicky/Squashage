/**
 * @fileoverview Schema-based classifier task for the Squashage pipeline.
 *
 * @remarks
 * Provides {@link SchemaClassifier}, an idiomatic task class that wraps an
 * {@link AjvClassifier} engine. On each pipeline invocation the task classifies
 * `state.input` and appends any returned {@link ClassificationProposalInterface}
 * values to `state.classifications` immutably before advancing via `next()`.
 *
 * Callers construct a `SchemaClassifier` with pre-compiled AJV entries (see
 * {@link AjvClassEntryInterface}) and pass `instance.execute` directly to the
 * pipeline or task registry.
 *
 * @module
 * @since 2.2.0
 * @category Classification
 */

import type { TaskFnInterface, NextFnInterface } from '../../types/Pipeline.js';
import type { PipelineStateInterface, ClassificationProposalInterface } from '../../types/PipelineState.js';
import { AjvClassifier, type AjvClassEntryInterface } from '../AjvClassifier.js';
import { Logger } from '../../modules/logger/logger.js';

const logger = Logger.forComponent('SchemaClassifier');

// ── SchemaClassifier ──────────────────────────────────────────────────────────

/**
 * Idiomatic task class wrapping an {@link AjvClassifier} for use in the
 * Squashage pipeline.
 *
 * @remarks
 * Instantiate once per pipeline target (or per target configuration), then
 * register or supply `instance.execute` as the task function. The constructor
 * validates that at least one class entry is provided; subsequent calls to
 * `execute` are pure and do not mutate engine state.
 *
 * The task appends proposals to `state.classifications` **immutably** — the
 * existing array is never mutated; a new `ReadonlyArray` is spread each run.
 * `next()` is always called after classification regardless of whether any
 * proposals matched.
 *
 * @example
 * ```ts
 * const classifier = new SchemaClassifier([
 *   { className: 'feat', priority: 10, validate: ajv.compile(featSchema) },
 * ]);
 * pipeline.use(classifier.execute);
 * ```
 *
 * @category Classification
 * @since 2.2.0
 * @see {@link AjvClassifier}
 * @see {@link AjvClassEntryInterface}
 * @group Tasks
 */
export class SchemaClassifier {
  readonly #engine: AjvClassifier;

  /**
   * @param entries - Ordered AJV class entries. Forwarded verbatim to
   *   {@link AjvClassifier}; see its constructor for validation rules.
   * @throws {OutputConfigError} When `entries` is empty.
   */
  constructor(entries: ReadonlyArray<AjvClassEntryInterface>) {
    this.#engine = new AjvClassifier(entries);
    logger.debug('constructor', 'SchemaClassifier initialised', { count: entries.length });
  }

  /**
   * Pipeline task function bound to this instance.
   *
   * @remarks
   * Classifies `state.input` via the underlying {@link AjvClassifier}, appends
   * any returned proposals to `state.classifications` immutably, and calls
   * `next()` unconditionally. Logging is emitted at `debug` level for each
   * invocation.
   *
   * @param next  - Pipeline continuation; called once after classification.
   * @param state - Mutable pipeline state for the current record.
   */
  public readonly execute: TaskFnInterface<PipelineStateInterface> = async (
    next: NextFnInterface,
    state: PipelineStateInterface,
  ): Promise<void> => {
    logger.debug('execute', 'Running schema classification', { targetId: state.targetId });

    const proposals: ReadonlyArray<ClassificationProposalInterface> = this.#engine.classify(state.input);

    if (proposals.length > 0) {
      logger.debug('execute', `Appending ${proposals.length.toString()} proposal(s) to state.classifications`, { count: proposals.length });
      (state as unknown as { classifications: ReadonlyArray<ClassificationProposalInterface> }).classifications = [
        ...state.classifications,
        ...proposals,
      ];
    }

    await next();
  };
}
