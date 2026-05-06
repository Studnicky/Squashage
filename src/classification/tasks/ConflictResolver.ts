/**
 * @fileoverview `classify:conflict` pipeline task — cascade conflict resolver.
 *
 * @remarks
 * Reads the accumulated `state.classifications` proposals emitted by all
 * upstream `classify:*` tasks, filters out metadata sentinels, and selects the
 * winning class for the record. The result is written to `state.classification`
 * as a {@link ClassificationEvidenceInterface}. Records that cannot be resolved
 * are either quarantined or skipped, depending on configuration.
 *
 * Resolution algorithm:
 * 1. Filter metadata sentinels (`__source__`, `__validation__`, `unknown`).
 * 2. If no proposals remain → `onUnknown` policy (quarantine or skip).
 * 3. If all proposals agree on a single className → that class wins; confidence
 *    is taken from the highest-priority proposal; engine is the comma-joined
 *    set of unique sources.
 * 4. If proposals disagree (multi-class conflict):
 *    a. Identify the class(es) with the highest priority.
 *    b. One clear winner → it wins regardless of `onConflict`.
 *    c. Genuine tie (≥2 classes share the highest priority):
 *       - `pickPriority` → lexicographically first className wins; `candidates`
 *         lists all tied classNames.
 *       - `quarantine` → quarantine record under bucket `'conflicts'`; leave
 *         `state.classification` null.
 *
 * **Usage**: instantiate once per pipeline run and register the bound `execute`
 * method onto the run's {@link TaskRegistry}. The factory (C5) handles
 * registration.
 *
 * @module
 * @since 0.1.0
 * @category Classification
 */

import { createHash } from 'node:crypto';

import type { NextFnInterface, TaskFnInterface }                from '../../types/Pipeline.js';
import type {
  PipelineStateInterface,
  ClassificationProposalInterface,
  ClassificationEvidenceInterface,
} from '../../types/PipelineState.js';
import { QuarantineWriter }  from '../../quarantine/QuarantineWriter.js';
import { OutputConfigError } from '../../errors/OutputConfigError.js';
import { Logger }            from '../../modules/logger/logger.js';

const logger = Logger.forComponent('ConflictResolver');

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Resolution policy configuration for {@link ConflictResolver}.
 *
 * @category Classification
 * @since 0.1.0
 * @see {@link ConflictResolver}
 * @group Types
 */
export interface ConflictResolverConfigInterface {
  /**
   * What to do when proposals tie on priority across distinct class names.
   *
   * - `'quarantine'` — write a quarantine record under bucket `'conflicts'`
   *   and leave `state.classification` null.
   * - `'pickPriority'` — deterministically break the tie by picking the
   *   className that sorts first lexicographically; `candidates` on the
   *   resulting evidence lists all tied classNames.
   */
  readonly onConflict: 'quarantine' | 'pickPriority';

  /**
   * What to do when no class proposal exists after filtering sentinels.
   *
   * - `'quarantine'` — write a quarantine record under bucket `'unknown'`.
   * - `'skip'` — leave `state.classification` null and continue.
   */
  readonly onUnknown: 'quarantine' | 'skip';

  /**
   * Whether to preserve the full proposal trail in the final
   * {@link ClassificationEvidenceInterface}.
   *
   * When `true`, `reasons` on the evidence object concatenates all reasons
   * from every contributing proposal in order. When `false`, only the top
   * reason from the winning proposal is included.
   */
  readonly evidence: boolean;
}

// ── Metadata sentinels ────────────────────────────────────────────────────────

/**
 * Set of className sentinels filtered out before conflict resolution.
 * These are coordination tokens, not class votes.
 *
 * @internal
 */
const METADATA_SENTINELS = new Set<string>(['__source__', '__validation__', '__narrowing_applied__', 'unknown']);

// ── ConflictResolver ──────────────────────────────────────────────────────────

/**
 * Pipeline task that resolves accumulated classification proposals to a single
 * winning class and writes the result to `state.classification`.
 *
 * @remarks
 * The resolver reads all proposals on `state.classifications`, filters out
 * metadata sentinels, and applies the configured resolution policy. It always
 * calls `next()` — quarantine is a graceful side-effect, not an error throw.
 *
 * @example
 * ```ts
 * const resolver = new ConflictResolver(
 *   { onConflict: 'quarantine', onUnknown: 'skip', evidence: true },
 *   './graphs',
 *   'aonprd',
 * );
 * registry.register('classify:conflict', resolver.execute);
 * ```
 *
 * @category Classification
 * @since 0.1.0
 * @see {@link ConflictResolverConfigInterface}
 * @see {@link ClassificationEvidenceInterface}
 * @group Classifiers
 */
export class ConflictResolver {
  /** Frozen resolution policy. */
  readonly #config:   ConflictResolverConfigInterface;
  /** Run output root directory; quarantine records land under `<outDir>/<targetId>/quarantine/`. */
  readonly #outDir:   string;
  /** Target identifier used for quarantine attribution. */
  readonly #targetId: string;

  /**
   * Creates a {@link ConflictResolver} instance.
   *
   * @remarks
   * Validates that `outDir` and `targetId` are non-empty strings. Empty values
   * indicate a misconfigured pipeline and fail fast at construction time.
   *
   * @param config   - Resolution policy.
   * @param outDir   - Run output directory; quarantine writes here.
   * @param targetId - Target identifier; quarantine attribution.
   * @throws {OutputConfigError} When `outDir` or `targetId` is empty.
   */
  public constructor(
    config:   ConflictResolverConfigInterface,
    outDir:   string,
    targetId: string,
  ) {
    if (!outDir || !targetId) {
      throw OutputConfigError.create(
        'ConflictResolver requires non-empty outDir and targetId.',
        { metadata: { task: 'classify:conflict', outDir, targetId } },
      );
    }

    this.#config   = Object.freeze({ ...config });
    this.#outDir   = outDir;
    this.#targetId = targetId;

    // Bind execute so it can be passed as a bare function reference to
    // TaskRegistry.register() without losing its `this` context.
    this.execute = this.#executeImpl.bind(this);
  }

  /**
   * Bound pipeline task function for `classify:conflict`.
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
    logger.debug('execute', 'ConflictResolver invoked', {
      targetId:      state.targetId,
      proposalCount: state.classifications.length,
    });

    // Step 1: filter out metadata sentinels — they are coordination tokens.
    const candidates = state.classifications.filter(
      (p) => !METADATA_SENTINELS.has(p.className),
    );

    // Step 2: no real proposals → apply onUnknown policy.
    if (candidates.length === 0) {
      await this.#handleUnknown(state);
      await next();
      return;
    }

    // Step 3: gather the distinct class names in the proposal set.
    const classNames = new Set<string>(candidates.map((p) => p.className));

    if (classNames.size === 1) {
      // All proposals agree — single winner (possibly multiple corroborations).
      const winner = this.#pickHighestPriority(candidates);
      const evidence = this.#buildEvidence(winner.className, candidates, undefined);
      (state as unknown as { classification: ClassificationEvidenceInterface | null })
        .classification = evidence;

      logger.info('execute', 'Classification resolved (single class)', {
        targetId:  state.targetId,
        className: winner.className,
        engine:    evidence.engine,
      });

      await next();
      return;
    }

    // Step 4: multi-class conflict — find the class(es) with the highest priority.
    const maxPriority = Math.max(...candidates.map((p) => p.priority));
    const topProposals = candidates.filter((p) => p.priority === maxPriority);
    const topClassNames = [...new Set<string>(topProposals.map((p) => p.className))];

    if (topClassNames.length === 1) {
      // Clear winner by priority — no genuine tie.
      const winnerClass = topClassNames[0] as string;
      const winnerProposals = candidates.filter((p) => p.className === winnerClass);
      const evidence = this.#buildEvidence(winnerClass, winnerProposals, undefined);
      (state as unknown as { classification: ClassificationEvidenceInterface | null })
        .classification = evidence;

      logger.info('execute', 'Classification resolved (priority winner)', {
        targetId:  state.targetId,
        className: winnerClass,
        engine:    evidence.engine,
      });

      await next();
      return;
    }

    // Genuine tie: ≥2 distinct classes share the highest priority.
    const tiedClassNames = topClassNames.sort();

    if (this.#config.onConflict === 'quarantine') {
      await this.#handleConflict(state, tiedClassNames);
    } else {
      // pickPriority: lexicographically first wins, candidates lists all tied.
      const winnerClass = tiedClassNames[0] as string;
      const winnerProposals = candidates.filter((p) => p.className === winnerClass);
      const evidence = this.#buildEvidence(winnerClass, winnerProposals, tiedClassNames);
      (state as unknown as { classification: ClassificationEvidenceInterface | null })
        .classification = evidence;

      logger.info('execute', 'Classification resolved (lex tiebreak)', {
        targetId:    state.targetId,
        className:   winnerClass,
        tiedClasses: tiedClassNames,
        engine:      evidence.engine,
      });
    }

    await next();
  }

  // ── Resolution helpers ────────────────────────────────────────────────────

  /**
   * Returns the proposal with the highest `priority` from `proposals`.
   *
   * @remarks
   * When multiple proposals share the highest priority (same className,
   * multiple corroborating sources), the first one in array order is returned
   * — all carry the same class, so the tiebreak is irrelevant for confidence.
   *
   * @param proposals - Non-empty, pre-filtered proposal list (sentinels removed).
   * @returns The highest-priority proposal.
   */
  #pickHighestPriority(proposals: ReadonlyArray<ClassificationProposalInterface>): ClassificationProposalInterface {
    let winner = proposals[0] as ClassificationProposalInterface;

    for (let i = 1; i < proposals.length; i++) {
      const p = proposals[i] as ClassificationProposalInterface;
      if (p.priority > winner.priority) {
        winner = p;
      }
    }

    return winner;
  }

  /**
   * Builds a {@link ClassificationEvidenceInterface} from the winning class
   * and the proposals that support it.
   *
   * @param className      - The winning class name.
   * @param proposals      - All proposals for the winning class (used for engine + reasons).
   * @param tiedClassNames - Sorted list of tied classNames (only present on lex tiebreak).
   * @returns Fully populated evidence object.
   */
  #buildEvidence(
    className:      string,
    proposals:      ReadonlyArray<ClassificationProposalInterface>,
    tiedClassNames: ReadonlyArray<string> | undefined,
  ): ClassificationEvidenceInterface {
    const winner    = this.#pickHighestPriority(proposals);
    const sources   = [...new Set<string>(proposals.map((p) => p.source))];
    const engine    = sources.join(',');

    const reasons: ReadonlyArray<string> = this.#config.evidence
      ? proposals.flatMap((p) => [...p.reasons])
      : [winner.reasons[0] ?? winner.className];

    return {
      type:       className,
      confidence: winner.confidence,
      engine,
      reasons,
      candidates: tiedClassNames,
    };
  }

  /**
   * Handles the `onUnknown` policy: quarantine or skip.
   *
   * @param state - Current pipeline state; used for quarantine record fields.
   */
  async #handleUnknown(state: PipelineStateInterface): Promise<void> {
    if (this.#config.onUnknown !== 'quarantine') {
      logger.debug('execute', 'No proposals; skip policy applied', {
        targetId: state.targetId,
      });
      return;
    }

    const id = createHash('sha1')
      .update(`${state.source.path}#${state.classifications.length}`)
      .digest('hex');

    const writer = QuarantineWriter.forRun(this.#outDir, this.#targetId);
    await writer.write({
      id,
      target:         state.source.target,
      bucket:         'unknown',
      source:         state.source,
      input:          state.input,
      classification: null,
      timestamp:      new Date().toISOString(),
    });

    logger.info('execute', 'Record quarantined (no class proposals)', {
      targetId: state.targetId,
      id,
    });
  }

  /**
   * Handles a genuine tie under the `quarantine` conflict policy: writes a
   * quarantine record under bucket `'conflicts'` and leaves
   * `state.classification` null.
   *
   * @param state          - Current pipeline state.
   * @param tiedClassNames - Sorted array of all tied class names.
   */
  async #handleConflict(
    state:          PipelineStateInterface,
    tiedClassNames: ReadonlyArray<string>,
  ): Promise<void> {
    const id = createHash('sha1')
      .update(`${state.source.path}#${state.classifications.length}`)
      .digest('hex');

    const writer = QuarantineWriter.forRun(this.#outDir, this.#targetId);
    await writer.write({
      id,
      target:         state.source.target,
      bucket:         'conflicts',
      source:         state.source,
      input:          state.input,
      classification: null,
      candidates:     tiedClassNames.map((className) => ({
        type:       className,
        confidence: 1,
        engine:     'classify:conflict',
        reasons:    [`tied-class: ${className}`],
      })),
      timestamp: new Date().toISOString(),
    });

    logger.info('execute', 'Record quarantined (conflict tie)', {
      targetId:    state.targetId,
      id,
      tiedClasses: tiedClassNames,
    });
  }
}
