/**
 * @fileoverview `classify:source` pipeline task — source-contract metadata gate.
 *
 * @remarks
 * Inspects the record's `_source` block and emits a single
 * {@link ClassificationProposalInterface} with `className: '__source__'` when
 * the block is present. The proposal carries no class vote; its purpose is to
 * surface source provenance into the evidence chain so the ConflictResolver and
 * downstream review tooling can inspect it. The ConflictResolver ignores
 * `__source__` proposals when picking a winner but preserves them in evidence.
 *
 * **Usage**: instantiate once per pipeline run and register the bound `execute`
 * method onto the run's {@link TaskRegistry}. The factory (C5) handles
 * registration; this class only provides the bound execute surface.
 *
 * @module
 * @since 0.1.0
 * @category Classification
 */

import type { NextFnInterface, TaskFnInterface } from '../../types/Pipeline.js';
import type { PipelineStateInterface, ClassificationProposalInterface } from '../../types/PipelineState.js';
import { Logger } from '../../modules/logger/logger.js';

const logger = Logger.forComponent('SourceClassifier');

// ── SourceClassifier ──────────────────────────────────────────────────────────

/**
 * Classifier task that emits a source-contract metadata proposal.
 *
 * @remarks
 * Reads the record's `_source.target`, `_source.plugin`, and
 * `_source.schemaId` fields and — when the `_source` block is present —
 * pushes one {@link ClassificationProposalInterface} onto
 * `state.classifications`. The proposal's `className` is the sentinel string
 * `'__source__'`, signalling to the ConflictResolver that this is a metadata
 * gate, not a class proposal; it will be preserved in evidence but never
 * elected as the winning class.
 *
 * When `_source` is absent, no proposal is emitted and `next()` is called
 * immediately.
 *
 * @example
 * ```ts
 * const classifier = new SourceClassifier();
 * registry.register('classify:source', classifier.execute);
 * ```
 *
 * @category Classification
 * @since 0.1.0
 * @see {@link ClassificationProposalInterface}
 * @group Classifiers
 */
export class SourceClassifier {
  /**
   * Creates a {@link SourceClassifier} instance.
   *
   * @remarks
   * No configuration is required — the classifier derives all information it
   * needs from the record's `_source` block at execution time.
   */
  public constructor() {
    // Bind execute so it can be passed as a bare function reference to
    // TaskRegistry.register() without losing its `this` context.
    this.execute = this.#executeImpl.bind(this);
  }

  /**
   * Bound pipeline task function for `classify:source`.
   *
   * @remarks
   * Public class field; safe to pass as a bare reference to
   * {@link TaskRegistry.register} — `this` binding is captured at
   * construction time.
   */
  public readonly execute: TaskFnInterface<PipelineStateInterface>;

  // ── Private implementation ────────────────────────────────────────────────

  async #executeImpl(
    next:  NextFnInterface,
    state: PipelineStateInterface,
  ): Promise<void> {
    logger.debug('execute', 'SourceClassifier invoked', { targetId: state.targetId });

    const raw = state.input['_source'];

    if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      logger.debug('execute', '_source block absent; emitting no proposal', { targetId: state.targetId });
      await next();
      return;
    }

    const src = raw as Record<string, unknown>;

    // Build reasons from whichever source fields are present.
    const reasons: string[] = [];

    if (typeof src['target'] === 'string') {
      reasons.push(`source.target=${src['target']}`);
    }
    if (typeof src['plugin'] === 'string') {
      reasons.push(`source.plugin=${src['plugin']}`);
    }
    if (typeof src['schemaId'] === 'string') {
      reasons.push(`source.schemaId=${src['schemaId']}`);
    }

    const proposal: ClassificationProposalInterface = {
      source:     'classify:source',
      className:  '__source__',
      priority:   0,
      confidence: 1,
      reasons,
    };

    (state as unknown as { classifications: ReadonlyArray<ClassificationProposalInterface> })
      .classifications = [...state.classifications, proposal];

    logger.info('execute', 'Source proposal emitted', {
      targetId: state.targetId,
      reasons,
    });

    await next();
  }
}
