import { Logger } from '../modules/logger/logger.js';

const log = Logger.forComponent('ConfigClamp');

/**
 * Hard limits for all configurable numeric values.
 * Any value outside these bounds is clamped and a warning is logged.
 *
 * @remarks
 * Limits reflect real API or protocol constraints where applicable:
 * `batchSize` and `maxPages` (wiki-side allpages enumeration) are capped at the MediaWiki API maximums.
 * All other limits are practical safety ceilings.
 *
 * @example
 * ```ts
 * const safe = ConfigClamp.mediawiki({ batchSize: 999, rateLimitMs: 0 });
 * // logs warnings for both violations, returns clamped values
 * ```
 *
 * @category Configuration
 * @since 2.0.0
 * @see {@link ConfigClamp}
 * @group Config
 */
export interface ClampRulesInterface {
  /** Minimum allowed value (inclusive). Must be ≥ 0. */
  readonly min: number;
  /** Maximum allowed value (inclusive). */
  readonly max: number;
  /** Human-readable reason shown in the warning log. */
  readonly reason: string;
}

/**
 * Named clamp rules for every numeric config field.
 *
 * @remarks Used by {@link ConfigClamp.apply} to validate and correct config values.
 * @category Configuration
 * @since 2.0.0
 * @see {@link ConfigClamp}
 * @group Config
 */
export const CLAMP_RULES: Readonly<Record<string, ClampRulesInterface>> = Object.freeze({
  'rateLimitMs':      { min: 0,   max: 60_000,  reason: 'minimum gap between requests (0 = unlimited; ≥100 recommended for public wikis)' },
  'jitterMs':         { min: 0,   max: 10_000,  reason: 'random jitter added per request' },
  'batchSize':        { min: 1,   max: 50,      reason: 'MediaWiki revisions API hard limit is 50 titles per request' },
  'maxRetries':       { min: 0,   max: 20,      reason: 'retry attempts per request failure' },
  'retryBaseDelayMs': { min: 50,  max: 30_000,  reason: 'initial retry back-off delay' },
  'retryMaxDelayMs':  { min: 100, max: 300_000, reason: 'ceiling for exponential back-off (5 min max)' },
  'maxPages':         { min: 1,   max: 10_000_000, reason: 'maximum pages to collect / enumerate per target run' },
  'concurrency':      { min: 1,   max: 32,         reason: 'maximum concurrent pipeline executions (1 = sequential)' },
  'maxRetries_html':  { min: 0,   max: 20,         reason: 'HTML scraper retry attempts per request failure' },
});

/**
 * Validates and clamps numeric configuration values to their valid ranges.
 * Logs a `warn`-level message for every value that required clamping so operators
 * can identify misconfigured fields without the scrape silently misbehaving.
 *
 * @remarks
 * All clamping is non-destructive — the original config object is not mutated.
 * Only numeric fields listed in {@link CLAMP_RULES} are checked; unknown fields
 * are passed through unchanged.
 *
 * @example
 * ```ts
 * const safe = ConfigClamp.apply({ batchSize: 999, rateLimitMs: -1 }, 'aonprd');
 * // [warn] ConfigClamp — aonprd.batchSize: 999 → 50 (MediaWiki hard limit is 50)
 * // [warn] ConfigClamp — aonprd.rateLimitMs: -1 → 0 (minimum gap between requests)
 * ```
 *
 * @category Configuration
 * @since 2.0.0
 * @see {@link CLAMP_RULES}
 * @group Config
 */
export class ConfigClamp {
  private constructor() { /* static-only */ }

  /**
   * Applies all registered clamp rules to a config-shaped object.
   * Returns a new object with clamped values; logs a warning per violation.
   *
   * @param config - Raw config values (may be from JSON or CLI).
   * @param targetId - Human-readable context shown in warning logs (e.g. target name).
   * @returns A shallow copy with out-of-range values replaced by their clamped equivalents.
   *
   * @category Configuration
   * @since 2.0.0
   * @see {@link CLAMP_RULES}
   * @group Config
   */
  public static apply<T extends Record<string, unknown>>(config: T, targetId: string): T {
    const result = { ...config };

    for (const [field, rules] of Object.entries(CLAMP_RULES)) {
      const key = field.replace(/_html$/, ''); // normalise aliased keys
      const raw = result[key];
      if (typeof raw !== 'number') continue;
      if (!Number.isFinite(raw)) {
        log.warn('apply', `${targetId}.${key}: ${String(raw)} is not a finite number — using ${String(rules.min)}`, { field: key, raw, clamped: rules.min });
        (result as Record<string, unknown>)[key] = rules.min;
        continue;
      }
      const clamped = Math.max(rules.min, Math.min(rules.max, raw));
      if (clamped !== raw) {
        log.warn(
          'apply',
          `${targetId}.${key}: ${String(raw)} → ${String(clamped)} (${rules.reason}, range ${String(rules.min)}–${String(rules.max)})`,
          { field: key, raw, clamped },
        );
        (result as Record<string, unknown>)[key] = clamped;
      }
    }

    return result;
  }

  /**
   * Convenience overload: clamp a mediawiki target config by name.
   *
   * @category Configuration
   * @since 2.0.0
   * @see {@link ConfigClamp.apply}
   * @group Config
   */
  public static mediawiki<T extends Record<string, unknown>>(config: T, targetId: string): T {
    return ConfigClamp.apply(config, targetId);
  }

  /**
   * Convenience overload: clamp an HTML target config by name.
   *
   * @category Configuration
   * @since 2.0.0
   * @see {@link ConfigClamp.apply}
   * @group Config
   */
  public static html<T extends Record<string, unknown>>(config: T, targetId: string): T {
    return ConfigClamp.apply(config, targetId);
  }

  /**
   * Convenience overload: clamp a crawler target config by name.
   *
   * @category Configuration
   * @since 2.0.0
   * @see {@link ConfigClamp.apply}
   * @group Config
   */
  public static crawler<T extends Record<string, unknown>>(config: T, targetId: string): T {
    return ConfigClamp.apply(config, targetId);
  }
}
