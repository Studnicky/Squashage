/**
 * @fileoverview `classify:property-fingerprint` pipeline task -- Jaccard-similarity
 * property-set fingerprint classifier.
 *
 * @remarks
 * Loads a fingerprints JSON file once at construction time and pre-computes each
 * fingerprint's key set into a frozen `Set<string>` for O(1) intersection. On each
 * record, extracts the top-level property key set and computes the Jaccard similarity
 * against every loaded fingerprint. Each fingerprint whose similarity meets or exceeds
 * `config.minMatchScore` produces one {@link ClassificationProposalInterface} with
 * `engine: 'property-fingerprint'` in the reasons array.
 *
 * Multiple fingerprints may match a single record, producing multiple proposals. The
 * ConflictResolver downstream handles conflict resolution.
 *
 * **Usage**: call `PropertyFingerprintClassifier.create(config, configDir)` once at
 * startup and register the bound `execute` method onto the per-run {@link TaskRegistry}.
 * The factory (ClassificationFactory) handles registration.
 *
 * @module
 * @since 0.5.0
 * @category Classification
 */

import { readFileSync } from 'node:fs';
import { resolve }      from 'node:path';

import type { NextFnInterface, TaskFnInterface } from '../../types/Pipeline.js';
import type { PipelineStateInterface, ClassificationProposalInterface } from '../../types/PipelineState.js';
import { OutputConfigError } from '../../errors/OutputConfigError.js';
import { Logger }            from '../../modules/logger/logger.js';

const logger = Logger.forComponent('PropertyFingerprintClassifier');

// ── Config interfaces ──────────────────────────────────────────────────────────

/**
 * A single entry in the fingerprints JSON file.
 *
 * @category Classification
 * @since 0.5.0
 * @group Types
 */
export interface FingerprintEntryInterface {
  /** Top-level property keys that characterise records of this class. */
  readonly keys:   ReadonlyArray<string>;
  /**
   * Informational weight stored in the file; currently not used in scoring
   * but preserved for future extension.
   */
  readonly weight?: number | undefined;
}

/**
 * Configuration block for {@link PropertyFingerprintClassifier}.
 *
 * @category Classification
 * @since 0.5.0
 * @group Types
 */
export interface PropertyFingerprintConfigInterface {
  /**
   * Filesystem path to the fingerprints JSON file. Resolved relative to the
   * directory that contains the squashage config file (the `configDir` argument
   * passed to {@link PropertyFingerprintClassifier.create}).
   */
  readonly fingerprintsFrom: string;
  /**
   * Minimum Jaccard similarity required to emit a proposal.
   * Must be in the range [0, 1]. Default: 0.85.
   */
  readonly minMatchScore?: number | undefined;
  /**
   * Numeric priority written onto every emitted proposal. Default: 32.
   */
  readonly priority?: number | undefined;
}

// ── Compiled fingerprint type ──────────────────────────────────────────────────

/** A pre-computed fingerprint ready for per-record Jaccard evaluation. */
interface CompiledFingerprintInterface {
  readonly className: string;
  readonly priority:  number;
  readonly keySet:    ReadonlySet<string>;
}

// ── PropertyFingerprintClassifier ──────────────────────────────────────────────

/**
 * Classifier task that evaluates Jaccard similarity over property key sets.
 *
 * @remarks
 * Each fingerprint's key set is pre-computed at construction time from the loaded
 * fingerprints JSON file. On each record the classifier:
 *
 * 1. Extracts the record's top-level property key set (top-level keys, sorted).
 * 2. For each pre-computed fingerprint computes `|A ∩ B| / |A ∪ B|`.
 * 3. Emits one proposal per fingerprint whose similarity >= `minMatchScore`.
 *
 * No file I/O occurs on the per-record path. The fingerprints file is read exactly
 * once during `PropertyFingerprintClassifier.create(config, configDir)`.
 *
 * @example
 * ```ts
 * const classifier = PropertyFingerprintClassifier.create(
 *   { fingerprintsFrom: './fingerprints.json', minMatchScore: 0.85, priority: 32 },
 *   path.dirname(configPath),
 * );
 * registry.register('classify:property-fingerprint', classifier.execute);
 * ```
 *
 * @category Classification
 * @since 0.5.0
 * @see {@link PropertyFingerprintConfigInterface}
 * @see {@link ClassificationProposalInterface}
 * @group Classifiers
 */
export class PropertyFingerprintClassifier {
  /** Frozen compiled-fingerprint list; evaluated per-record on the hot path. */
  readonly #fingerprints: ReadonlyArray<CompiledFingerprintInterface>;
  /** Minimum Jaccard similarity threshold. */
  readonly #minMatchScore: number;

  private constructor(
    fingerprints:  ReadonlyArray<CompiledFingerprintInterface>,
    minMatchScore: number,
  ) {
    this.#fingerprints  = Object.freeze([...fingerprints]);
    this.#minMatchScore = minMatchScore;
    // Bind execute so it can be passed as a bare function reference to
    // TaskRegistry.register() without losing its `this` context.
    this.execute = this.#executeImpl.bind(this);
  }

  /**
   * Creates a {@link PropertyFingerprintClassifier} instance from raw config.
   *
   * @remarks
   * The fingerprints JSON file is read and parsed synchronously once at call
   * time. Every fingerprint's key list is validated (non-empty) and pre-computed
   * into a `Set<string>` for O(1) intersection on the hot path.
   *
   * @param config    - Raw property-fingerprint config from the target's
   *   `classification.propertyFingerprint` block.
   * @param configDir - Directory of the squashage config file; used to resolve
   *   relative `fingerprintsFrom` paths.
   * @returns A fully constructed, ready-to-register classifier instance.
   * @throws {OutputConfigError} When the fingerprints file is missing, malformed,
   *   or any fingerprint entry has an empty `keys` array.
   */
  public static create(
    config:    PropertyFingerprintConfigInterface,
    configDir: string,
  ): PropertyFingerprintClassifier {
    const absPath      = resolve(configDir, config.fingerprintsFrom);
    const minMatchScore = config.minMatchScore ?? 0.85;
    const priority      = config.priority      ?? 32;

    // Load fingerprints file synchronously (once at startup, never per-record).
    let text: string;
    try {
      text = readFileSync(absPath, 'utf-8');
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw OutputConfigError.create(
        `classify:property-fingerprint: cannot read fingerprints file at ${absPath}: ${cause?.message ?? String(err)}`,
        { cause, metadata: { fingerprintsFrom: config.fingerprintsFrom, absPath } },
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw OutputConfigError.create(
        `classify:property-fingerprint: cannot parse fingerprints JSON at ${absPath}: ${cause?.message ?? String(err)}`,
        { cause, metadata: { fingerprintsFrom: config.fingerprintsFrom, absPath } },
      );
    }

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw OutputConfigError.create(
        `classify:property-fingerprint: fingerprints file at ${absPath} must be a JSON object mapping className -> { keys, weight? }`,
        { metadata: { fingerprintsFrom: config.fingerprintsFrom, absPath } },
      );
    }

    const rawMap = raw as Record<string, unknown>;
    const compiled: CompiledFingerprintInterface[] = [];

    for (const [className, entry] of Object.entries(rawMap)) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('keys' in entry) ||
        !Array.isArray((entry as Record<string, unknown>)['keys'])
      ) {
        throw OutputConfigError.create(
          `classify:property-fingerprint: fingerprint entry "${className}" at ${absPath} must have a "keys" array`,
          { metadata: { className, absPath } },
        );
      }

      const keys = (entry as Record<string, unknown>)['keys'] as unknown[];

      if (keys.length === 0) {
        throw OutputConfigError.create(
          `classify:property-fingerprint: fingerprint entry "${className}" at ${absPath} has an empty "keys" array; at least one key is required`,
          { metadata: { className, absPath } },
        );
      }

      const keySet = new Set(keys.map((k) => String(k)));

      compiled.push({
        className,
        priority,
        keySet: Object.freeze(keySet) as ReadonlySet<string>,
      });
    }

    logger.debug('create', 'PropertyFingerprintClassifier created', {
      absPath,
      fingerprintCount: compiled.length,
      minMatchScore,
      priority,
    });

    return new PropertyFingerprintClassifier(compiled, minMatchScore);
  }

  /**
   * Bound pipeline task function for `classify:property-fingerprint`.
   *
   * @remarks
   * Public class field; safe to pass as a bare reference to
   * {@link TaskRegistry.register} -- `this` binding is captured at
   * construction time.
   */
  public readonly execute: TaskFnInterface<PipelineStateInterface>;

  // ── Private implementation ──────────────────────────────────────────────────

  async #executeImpl(
    next:  NextFnInterface,
    state: PipelineStateInterface,
  ): Promise<void> {
    logger.debug('execute', 'PropertyFingerprintClassifier invoked', {
      targetId:         state.targetId,
      fingerprintCount: this.#fingerprints.length,
    });

    // Extract top-level key set from the input record.
    const recordKeys = PropertyFingerprintClassifier.#extractKeySet(state.input);

    if (recordKeys.size === 0) {
      logger.debug('execute', 'Record has no top-level keys; emitting no proposals', {
        targetId: state.targetId,
      });
      await next();
      return;
    }

    const newProposals: ClassificationProposalInterface[] = [];

    for (const fingerprint of this.#fingerprints) {
      const score = PropertyFingerprintClassifier.#jaccard(recordKeys, fingerprint.keySet);

      if (score >= this.#minMatchScore) {
        const sharedCount = PropertyFingerprintClassifier.#intersectionSize(recordKeys, fingerprint.keySet);
        newProposals.push({
          source:     'classify:property-fingerprint',
          className:  fingerprint.className,
          priority:   fingerprint.priority,
          confidence: score,
          reasons: [
            `fingerprint.score=${score.toFixed(2)}`,
            `fingerprint.shared=${sharedCount}`,
          ],
        });
      }
    }

    if (newProposals.length > 0) {
      (state as unknown as { classifications: ReadonlyArray<ClassificationProposalInterface> })
        .classifications = [...state.classifications, ...newProposals];

      logger.info('execute', 'Property-fingerprint proposals emitted', {
        targetId:      state.targetId,
        proposalCount: newProposals.length,
      });
    } else {
      logger.debug('execute', 'No fingerprints matched', {
        targetId:  state.targetId,
        keyCount:  recordKeys.size,
        threshold: this.#minMatchScore,
      });
    }

    await next();
  }

  /**
   * Extracts the set of top-level property keys from the input record.
   *
   * @param input - Parsed input JSON record from `state.input`.
   * @returns A `Set<string>` of the record's top-level keys.
   */
  static #extractKeySet(input: Readonly<Record<string, unknown>>): Set<string> {
    return new Set(Object.keys(input));
  }

  /**
   * Computes Jaccard similarity between two key sets.
   *
   * @remarks
   * `|A ∩ B| / |A ∪ B|`. Returns 0 when both sets are empty.
   *
   * @param a - Record key set.
   * @param b - Fingerprint key set.
   * @returns Jaccard similarity in [0, 1].
   */
  static #jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
    if (a.size === 0 && b.size === 0) return 0;

    const intersect = PropertyFingerprintClassifier.#intersectionSize(a, b);
    const union     = a.size + b.size - intersect;

    return union === 0 ? 0 : intersect / union;
  }

  /**
   * Counts the number of elements in the intersection of two sets.
   *
   * @param a - First set.
   * @param b - Second set (iterated).
   * @returns Count of elements present in both `a` and `b`.
   */
  static #intersectionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
    let count = 0;
    for (const key of b) {
      if (a.has(key)) count++;
    }
    return count;
  }
}
