/**
 * @fileoverview `classify:url-pattern` pipeline task -- URL-regex classifier.
 *
 * @remarks
 * Inspects the record's `_source.url` field (squashage-enriched) or falls back
 * to the top-level `url` field (raw scrape). For each configured pattern, the
 * pre-compiled regex is evaluated against the URL string. Each match emits one
 * {@link ClassificationProposalInterface} with `engine: 'url-pattern'` in the
 * reasons array.
 *
 * Regexes are compiled once at construction time via {@link UrlPatternClassifier.create}
 * and never re-compiled per record. Invalid regex source strings fail fast with
 * {@link OutputConfigError} at startup, naming the zero-based pattern index.
 *
 * Multiple patterns may match a single URL, producing multiple proposals. The
 * ConflictResolver downstream handles any resulting conflict.
 *
 * **Usage**: call `UrlPatternClassifier.create(config)` once at startup and
 * register the bound `execute` method onto the per-run {@link TaskRegistry}.
 * The factory (ClassificationFactory) handles registration.
 *
 * @module
 * @since 0.5.0
 * @category Classification
 */

import type { NextFnInterface, TaskFnInterface } from '../../types/Pipeline.js';
import type { PipelineStateInterface, ClassificationProposalInterface } from '../../types/PipelineState.js';
import { OutputConfigError } from '../../errors/OutputConfigError.js';
import { Logger }            from '../../modules/logger/logger.js';

const logger = Logger.forComponent('UrlPatternClassifier');

// ── Config interfaces ──────────────────────────────────────────────────────────

/**
 * A single URL-pattern entry as it appears in the target config's
 * `classification.urlPattern.patterns[]` array.
 *
 * @category Classification
 * @since 0.5.0
 * @group Types
 */
export interface UrlPatternEntryInterface {
  /** Ontology class id proposed when the pattern matches the record URL. */
  readonly className: string;
  /** Regex source string; compiled once at config load via {@link UrlPatternClassifier.create}. */
  readonly match:     string;
  /** Numeric priority forwarded onto the emitted proposal. Defaults to 35. */
  readonly priority?: number | undefined;
}

/**
 * Configuration block for {@link UrlPatternClassifier}.
 *
 * @category Classification
 * @since 0.5.0
 * @group Types
 */
export interface UrlPatternConfigInterface {
  /** At least one pattern must be present. */
  readonly patterns: ReadonlyArray<UrlPatternEntryInterface>;
}

// ── Compiled pattern type ──────────────────────────────────────────────────────

/** A pre-compiled pattern ready for per-record evaluation. */
interface CompiledPatternInterface {
  readonly className: string;
  readonly priority:  number;
  readonly regex:     RegExp;
  /** Pre-computed reason string for the regex to avoid interpolation on the hot path. */
  readonly reason:    string;
}

// ── UrlPatternClassifier ───────────────────────────────────────────────────────

/**
 * Classifier task that emits URL-pattern proposals.
 *
 * @remarks
 * Each configured pattern is compiled to a `RegExp` once at construction time.
 * On each record, the classifier extracts the URL from `_source.url` (priority)
 * or top-level `url` (fallback). When neither is present, no proposal is emitted.
 *
 * For each pattern whose regex matches the URL, one proposal is pushed onto
 * `state.classifications` with:
 * - `source: 'classify:url-pattern'`
 * - `className`: from config
 * - `priority`: from config (default 35)
 * - `engine: 'url-pattern'` in the `reasons` array
 * - `url=<matched url>` in the `reasons` array
 *
 * @example
 * ```ts
 * const classifier = UrlPatternClassifier.create({
 *   patterns: [
 *     { className: 'feat',  match: '/Feats\\.aspx',  priority: 35 },
 *     { className: 'spell', match: '/Spells\\.aspx', priority: 35 },
 *   ],
 * });
 * registry.register('classify:url-pattern', classifier.execute);
 * ```
 *
 * @category Classification
 * @since 0.5.0
 * @see {@link UrlPatternConfigInterface}
 * @see {@link ClassificationProposalInterface}
 * @group Classifiers
 */
export class UrlPatternClassifier {
  /** Frozen compiled-pattern list; evaluated per-record on the hot path. */
  readonly #patterns: ReadonlyArray<CompiledPatternInterface>;

  private constructor(patterns: ReadonlyArray<CompiledPatternInterface>) {
    this.#patterns = Object.freeze([...patterns]);
    // Bind execute so it can be passed as a bare function reference to
    // TaskRegistry.register() without losing its `this` context.
    this.execute = this.#executeImpl.bind(this);
  }

  /**
   * Creates a {@link UrlPatternClassifier} instance from raw config.
   *
   * @remarks
   * Each `match` string is compiled to a `RegExp` at call time. An invalid
   * regex source string at any index throws {@link OutputConfigError} immediately,
   * naming the zero-based pattern index so the user can locate it in their config.
   *
   * @param config - Raw URL-pattern config from the target's `classification.urlPattern` block.
   * @returns A fully constructed, ready-to-register classifier instance.
   * @throws {OutputConfigError} When any `match` string is an invalid regex, naming the pattern index.
   */
  public static create(config: UrlPatternConfigInterface): UrlPatternClassifier {
    const compiled: CompiledPatternInterface[] = config.patterns.map((entry, idx) => {
      let regex: RegExp;
      try {
        regex = new RegExp(entry.match);
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        throw OutputConfigError.create(
          `classify:url-pattern: invalid regex at patterns[${idx}].match "${entry.match}": ${cause?.message ?? String(err)}`,
          { cause, metadata: { patternIndex: idx, match: entry.match } },
        );
      }
      return {
        className: entry.className,
        priority:  entry.priority ?? 35,
        regex,
        reason:    `url-pattern: ${entry.match}`,
      };
    });

    return new UrlPatternClassifier(compiled);
  }

  /**
   * Bound pipeline task function for `classify:url-pattern`.
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
    logger.debug('execute', 'UrlPatternClassifier invoked', {
      targetId:     state.targetId,
      patternCount: this.#patterns.length,
    });

    // Extract URL: _source.url takes priority over top-level url.
    const url = UrlPatternClassifier.#extractUrl(state.input);

    if (url === undefined) {
      logger.debug('execute', 'No URL found on record; emitting no proposals', {
        targetId: state.targetId,
      });
      await next();
      return;
    }

    const newProposals: ClassificationProposalInterface[] = [];

    for (const pattern of this.#patterns) {
      if (pattern.regex.test(url)) {
        newProposals.push({
          source:     'classify:url-pattern',
          className:  pattern.className,
          priority:   pattern.priority,
          confidence: 1,
          reasons:    [pattern.reason, `url=${url}`],
        });
      }
    }

    if (newProposals.length > 0) {
      (state as unknown as { classifications: ReadonlyArray<ClassificationProposalInterface> })
        .classifications = [...state.classifications, ...newProposals];

      logger.info('execute', 'URL-pattern proposals emitted', {
        targetId:      state.targetId,
        url,
        proposalCount: newProposals.length,
      });
    } else {
      logger.debug('execute', 'No URL patterns matched', {
        targetId: state.targetId,
        url,
      });
    }

    await next();
  }

  /**
   * Extracts the URL string from the input record.
   *
   * @remarks
   * Reads `_source.url` first (squashage-enriched form). Falls back to the
   * top-level `url` field (raw scrape form). Returns `undefined` when neither
   * is a non-empty string.
   *
   * @param input - Parsed input JSON record from `state.input`.
   * @returns The URL string, or `undefined` when absent.
   */
  static #extractUrl(input: Readonly<Record<string, unknown>>): string | undefined {
    // Prefer _source.url (squashage-enriched).
    const sourceBlock = input['_source'];
    if (sourceBlock !== null && typeof sourceBlock === 'object' && !Array.isArray(sourceBlock)) {
      const src = sourceBlock as Record<string, unknown>;
      if (typeof src['url'] === 'string' && src['url'].length > 0) {
        return src['url'];
      }
    }

    // Fallback: top-level url.
    if (typeof input['url'] === 'string' && input['url'].length > 0) {
      return input['url'];
    }

    return undefined;
  }
}
