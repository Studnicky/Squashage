/**
 * @fileoverview `classify:source` pipeline task — source-contract metadata gate
 * (legacy class + self-registering silo plugin).
 *
 * @remarks
 * Inspects the record's `_source` block and emits a single
 * {@link ClassificationProposalInterface} with `className: '__source__'` when
 * the block is present. The proposal carries no class vote; its purpose is to
 * surface source provenance into the evidence chain so the ConflictResolver and
 * downstream review tooling can inspect it. The ConflictResolver ignores
 * `__source__` proposals when picking a winner but preserves them in evidence.
 *
 * **Module side effects** (per the v0.7.0 silo migration, task #12):
 *
 * 1. {@link TaskRegistry.registerHook}`('classify:source', 'onRunStart', ...)` —
 *    validates `ctx.config.source` against {@link sourceConfigSchema} via
 *    `ctx.ajv.compile(...)`. The hook no-ops when the namespace is absent so
 *    the plugin coexists with the legacy {@link ClassificationFactory} wiring
 *    (which reads `targetConfig.classification.source`); it fails fast when
 *    the namespace is present but the value is anything other than literal
 *    `true`.
 *
 * 2. {@link TaskRegistry.register}`('classify:source', sourceClassifyTask,
 *    { proposesClass: false })` — registers the per-record task. The body
 *    inspects `state.input._source`, appends a single `__source__` proposal
 *    with `source: 'classify:source'` when the block is present, and
 *    unconditionally calls `await next()`. `proposesClass` is `false` because
 *    `__source__` is a metadata gate, not a class vote — it is registered with
 *    `proposesClass: false` and is excluded from conflict-resolution vote
 *    counting.
 *
 * The legacy class-based {@link SourceClassifier} is retained for the existing
 * {@link ClassificationFactory} wiring. Task #24 rewires the orchestrator to
 * drive the lifecycle hook chain and discard the factory.
 *
 * @module
 * @since 0.1.0
 * @category Classification
 */

import type { NextFnInterface, TaskFnInterface } from '../../types/Pipeline.js';
import type {
  PipelineContextInterface,
  PipelineStateInterface,
  ClassificationProposalInterface,
} from '../../types/PipelineState.js';
import { Logger } from '../../modules/logger/logger.js';
import { TaskRegistry } from '../../registry/TaskRegistry.js';
import { ExternalSchemaError } from '../../errors/ExternalSchemaError.js';

const logger = Logger.forComponent('SourceClassifier');

// ── Plugin registration names ─────────────────────────────────────────────────

/** Per-record task name registered in the {@link TaskRegistry}. */
export const SOURCE_TASK_NAME = 'classify:source' as const;

/**
 * Lifecycle hook name for the onRunStart config-validation step.
 *
 * @remarks
 * Aliased to the per-record task name so every classifier plugin in the silo
 * uses the single convention `name == hook == task`. The TaskRegistry keys
 * its hook map and per-record task map separately, so the same name is
 * unambiguous.
 */
export const SOURCE_HOOK_NAME = SOURCE_TASK_NAME;

// ── AJV config schema ────────────────────────────────────────────────────────

/**
 * AJV schema fragment for `ctx.config.source` (the plugin's config namespace).
 *
 * @remarks
 * The legal value is the literal `true`. Any other value — `false`, a string,
 * an object, `null` — fails the compiled validator and the `onRunStart` hook
 * raises {@link ExternalSchemaError}. The namespace itself is optional; an
 * absent `source` key skips validation and skips registration of the per-record
 * task's effects (the task is always registered, but emits no proposal when
 * `_source` is absent on the record, mirroring the legacy class).
 *
 * Exported so unit tests can compile the schema directly with the run-wide
 * `ctx.ajv` and assert acceptance/rejection behaviour without round-tripping
 * through the orchestrator.
 *
 * @category Classification
 * @since 0.7.0
 */
export const sourceConfigSchema = {
  $id:   'https://squashage.dev/schemas/classify-source-config.json',
  type:  'boolean',
  const: true,
} as const;

// ── SourceClassifier (legacy class) ──────────────────────────────────────────

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

// ── Plugin self-registration (silo migration, task #12) ──────────────────────

/**
 * `onRunStart` hook for `classify:source`.
 *
 * @remarks
 * Validates `ctx.config.source` against {@link sourceConfigSchema} via the
 * run-wide `ctx.ajv`. No-ops when the namespace is absent (legacy-coexistence
 * path). Throws {@link ExternalSchemaError} when the namespace is present but
 * not the literal `true`.
 *
 * @internal
 */
function sourceOnRunStart(ctx: PipelineContextInterface): void {
  const raw = ctx.config['source'];

  // Absent namespace: no-op so the plugin coexists with the legacy factory
  // wiring (which reads `targetConfig.classification.source`). When the
  // orchestrator rewires in task #24, the flat namespace becomes the
  // primary source of truth and this branch will simply mean
  // "classify:source is not requested for this target".
  if (raw === undefined) {
    logger.debug('onRunStart', 'ctx.config.source absent; classify:source not requested');
    return;
  }

  const validate = ctx.ajv.compile(sourceConfigSchema);
  if (!validate(raw)) {
    throw ExternalSchemaError.create(
      'classify:source: ctx.config.source must be the literal true',
      {
        metadata: {
          hook:     SOURCE_HOOK_NAME,
          target:   ctx.target,
          errors:   validate.errors,
          received: typeof raw,
        },
      },
    );
  }

  logger.debug('onRunStart', 'ctx.config.source validated', { target: ctx.target });
}

/**
 * Per-record pipeline task body for `classify:source`.
 *
 * @remarks
 * Inspects `state.input._source` and, when the block is a plain object,
 * appends one {@link ClassificationProposalInterface} carrying
 * `className: '__source__'` to `state.classifications`. The proposal is a
 * metadata gate — the ConflictResolver preserves it in evidence but never
 * elects it as the winning class (see `__source__` handling in
 * `src/classification/tasks/ConflictResolver.ts`). When `_source` is absent
 * or not a plain object, no proposal is emitted.
 *
 * This task is `proposesClass: false` (registered below) because
 * `__source__` is a metadata sentinel rather than a class vote.
 * It is excluded from conflict-resolution vote counting.
 *
 * @internal
 */
const sourceClassifyTask: TaskFnInterface<PipelineStateInterface> = async (
  next:  NextFnInterface,
  state: PipelineStateInterface,
): Promise<void> => {
  logger.debug('execute', 'classify:source invoked', { targetId: state.targetId });

  const raw = state.input['_source'];

  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    logger.debug('execute', '_source block absent; emitting no proposal', { targetId: state.targetId });
    await next();
    return;
  }

  const src = raw as Record<string, unknown>;

  const reasons: string[] = [];
  if (typeof src['target']   === 'string') reasons.push(`source.target=${src['target']}`);
  if (typeof src['plugin']   === 'string') reasons.push(`source.plugin=${src['plugin']}`);
  if (typeof src['schemaId'] === 'string') reasons.push(`source.schemaId=${src['schemaId']}`);

  const proposal: ClassificationProposalInterface = {
    source:     'classify:source',
    className:  '__source__',
    priority:   0,
    confidence: 1,
    reasons,
  };

  // Append-only mutation of the readonly array slot, mirroring the convention
  // used by every other class-proposer in the legacy classifier set.
  (state as unknown as { classifications: ReadonlyArray<ClassificationProposalInterface> })
    .classifications = [...state.classifications, proposal];

  logger.info('execute', 'Source proposal emitted', { targetId: state.targetId, reasons });

  await next();
};

TaskRegistry.registerHook(SOURCE_HOOK_NAME, 'onRunStart', sourceOnRunStart, { proposesClass: false });
TaskRegistry.register(SOURCE_TASK_NAME, sourceClassifyTask, { proposesClass: false });
