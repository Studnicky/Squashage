/**
 * SubjectIriPolicy — compiled subject-IRI policy from `targetConfig.subjectIri`.
 *
 * Reads a JSON Pointer path from the record, applies a sanitize step, and
 * returns a canonical IRI per record. Falls back to a sha1 hash of
 * `recordPath:recordLine` when neither `from` nor `fallback` resolves, so
 * existing behavior is preserved when no `subjectIri` block is configured.
 *
 * JSON Pointer resolution follows RFC 6901 (with `~0` → `~`, `~1` → `/`
 * token unescaping).
 */

import { createHash } from 'node:crypto';

import type { TargetConfigInterface } from '../config/SquashageConfig.js';

// ─── JSON Pointer (RFC 6901) ──────────────────────────────────────────────────

/**
 * Resolve a JSON Pointer against an object.
 *
 * Supports the empty pointer `""` (returns the root object), and handles
 * `~0` → `~` and `~1` → `/` token unescaping per RFC 6901 §3.
 *
 * Returns `undefined` when any segment is absent.
 */
function resolvePointer(obj: Record<string, unknown>, pointer: string): unknown {
  if (pointer === '') return obj;
  if (!pointer.startsWith('/')) return undefined;

  const tokens = pointer.slice(1).split('/');
  let cursor: unknown = obj;

  for (const raw of tokens) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    // RFC 6901: unescape ~1 first, then ~0 (order matters).
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    cursor = (cursor as Record<string, unknown>)[key];
  }

  return cursor;
}

// ─── Sanitize policies ────────────────────────────────────────────────────────

/**
 * Strip protocol and host; keep path + query string.
 *
 * `https://example.org/spells/fireball?v=2` → `/spells/fireball?v=2`
 */
function sanitizeUrlTail(value: string): string {
  try {
    const u = new URL(value);
    return u.pathname + u.search;
  } catch {
    return value;
  }
}

/**
 * Strip protocol; keep host + path (drop query/fragment).
 *
 * `https://example.org/spells/fireball?v=2` → `example.org/spells/fireball`
 */
function sanitizeUrlHostPath(value: string): string {
  try {
    const u = new URL(value);
    return u.host + u.pathname;
  } catch {
    return value;
  }
}

/**
 * Convert to a URL-safe slug: lowercase, collapse non-`[a-z0-9]` runs into a
 * single hyphen, trim leading/trailing hyphens.
 */
function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─── Config shape ─────────────────────────────────────────────────────────────

/** Sanitize strategy names accepted by SubjectIriPolicy. */
export type SubjectIriSanitize = 'url-tail' | 'url-host-path' | 'slug' | 'verbatim';

/** Config shape for a single subject-IRI policy declaration. */
export interface SubjectIriConfigInterface {
  /** JSON Pointer into the record instance to read the candidate IRI value. */
  readonly from: string;
  /** Sanitize strategy applied to the resolved string. */
  readonly sanitize: SubjectIriSanitize;
  /** JSON Pointer used when `from` resolves to `undefined`. */
  readonly fallback?: string | undefined;
}

// ─── Dispatch map ─────────────────────────────────────────────────────────────

type SanitizeFn = (value: string) => string;

const SANITIZE_MAP: Record<SubjectIriSanitize, SanitizeFn> = {
  'url-tail':       sanitizeUrlTail,
  'url-host-path':  sanitizeUrlHostPath,
  'slug':           sanitizeSlug,
  'verbatim':       (v) => v,
};

// ─── Policy class ─────────────────────────────────────────────────────────────

/**
 * Compiled subject-IRI policy.
 *
 * Constructed once per run from `targetConfig.subjectIri`. When no
 * `subjectIri` block is present in the config, the legacy sha1 hash fallback
 * is used so existing behavior is unchanged.
 *
 * Per-class overrides are stored for future use (Phase 7). Call
 * `withOverride(className, config)` to register a per-class policy; the main
 * `resolve()` method will prefer it when `className` matches.
 */
export class SubjectIriPolicy {
  readonly #config:    SubjectIriConfigInterface | null;
  readonly #runBase:   string;
  readonly #overrides: Map<string, SubjectIriConfigInterface>;

  private constructor(
    config:  SubjectIriConfigInterface | null,
    runBase: string,
  ) {
    this.#config    = config;
    this.#runBase   = runBase;
    this.#overrides = new Map();
  }

  /**
   * Build a `SubjectIriPolicy` from the target config.
   *
   * @param targetConfig - Validated per-target configuration.
   * @param runBase      - `services.prefixes.instances.base`; prepended to
   *                       relative IRI values.
   */
  static fromTargetConfig(
    targetConfig: TargetConfigInterface,
    runBase: string,
  ): SubjectIriPolicy {
    const raw = (targetConfig as unknown as Record<string, unknown>)['subjectIri'];

    if (raw === undefined || raw === null) {
      return new SubjectIriPolicy(null, runBase);
    }

    const config = raw as SubjectIriConfigInterface;
    return new SubjectIriPolicy(config, runBase);
  }

  /**
   * Register a per-class subject-IRI override.
   *
   * Overrides take precedence over the target-level policy when the record's
   * `className` matches. Stored for Phase 7 consumption.
   *
   * @param className - The classification class name this override applies to.
   * @param override  - Replacement `SubjectIriConfigInterface` for this class.
   */
  withOverride(className: string, override: SubjectIriConfigInterface): this {
    this.#overrides.set(className, override);
    return this;
  }

  /**
   * Derive the subject IRI for one record.
   *
   * Resolution order:
   * 1. Per-class override (if `className` is given and has a registered override).
   * 2. Target-level `from` pointer.
   * 3. Target-level `fallback` pointer.
   * 4. sha1 hash of `recordPath:recordLine` (legacy default, preserves existing output).
   *
   * After resolution, the value is sanitized, then:
   * - If the sanitized value is already an absolute IRI (`http://` or `https://`),
   *   return it unchanged.
   * - Otherwise, prepend `runBase` (ensuring a single trailing `/` separator).
   *
   * @param instance   - The parsed record object.
   * @param recordPath - File path of the source record (for the hash fallback).
   * @param recordLine - Line number within the source file (for the hash fallback).
   * @param className  - Optional classification class name (enables per-class overrides).
   */
  resolve(
    instance:   Record<string, unknown>,
    recordPath: string,
    recordLine: number,
    className?: string | undefined,
  ): string {
    const config = (className !== undefined && this.#overrides.has(className))
      ? this.#overrides.get(className)!
      : this.#config;

    if (config === null) {
      return this.#hashFallback(recordPath, recordLine);
    }

    const resolved = this.#resolveFromConfig(instance, config);
    if (resolved === undefined) {
      return this.#hashFallback(recordPath, recordLine);
    }

    const sanitizeFn = SANITIZE_MAP[config.sanitize];
    const sanitized  = sanitizeFn(resolved);

    return this.#toAbsoluteIri(sanitized);
  }

  // ─── private helpers ───────────────────────────────────────────────────────

  #resolveFromConfig(
    instance: Record<string, unknown>,
    config:   SubjectIriConfigInterface,
  ): string | undefined {
    const primary = resolvePointer(instance, config.from);
    if (typeof primary === 'string' && primary.length > 0) return primary;

    if (config.fallback !== undefined) {
      const fb = resolvePointer(instance, config.fallback);
      if (typeof fb === 'string' && fb.length > 0) return fb;
    }

    return undefined;
  }

  #hashFallback(recordPath: string, recordLine: number): string {
    const key  = `${recordPath}:${String(recordLine)}`;
    const hash = createHash('sha1').update(key).digest('hex').slice(0, 8);
    const base = this.#runBase.endsWith('/') ? this.#runBase : `${this.#runBase}/`;
    return `${base}record/${hash}`;
  }

  #toAbsoluteIri(value: string): string {
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return value;
    }
    const base = this.#runBase.endsWith('/') ? this.#runBase : `${this.#runBase}/`;
    const suffix = value.startsWith('/') ? value.slice(1) : value;
    return `${base}${suffix}`;
  }
}
