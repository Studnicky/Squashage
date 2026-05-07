import { OutputConfigError } from '../../errors/OutputConfigError.js';

// ── RawPredicate ─────────────────────────────────────────────────────────────

/**
 * A raw length-constraint descriptor used in the `length` predicate.
 *
 * @remarks
 * At least one of `gte`, `lte`, or `eq` must be present for the constraint to
 * be meaningful. An empty constraint object `{}` compiles successfully and matches
 * any string or array regardless of length. When `eq` is supplied alongside
 * `gte`/`lte`, only `eq` is evaluated.
 *
 * @category Classification
 * @since 2.2.0
 * @group Types
 */
export interface RawLengthConstraintInterface {
  /** Length is at least this value (inclusive). */
  readonly gte?: number | undefined;
  /** Length is at most this value (inclusive). */
  readonly lte?: number | undefined;
  /** Length is exactly this value. */
  readonly eq?: number | undefined;
}

/**
 * A raw range-constraint descriptor used in the `range` predicate.
 *
 * @remarks
 * Operates on finite numbers only. Non-numeric or non-finite values resolve to
 * `false` without throwing. Bounds can be combined arbitrarily: `gt` + `lt`
 * forms an open interval; `gte` + `lte` forms a closed interval. Mixed open/
 * closed combinations (`gte` + `lt`, etc.) are legal.
 *
 * @category Classification
 * @since 2.2.0
 * @group Types
 */
export interface RawRangeConstraintInterface {
  /** Value is at least this bound (inclusive). */
  readonly gte?: number | undefined;
  /** Value is at most this bound (inclusive). */
  readonly lte?: number | undefined;
  /** Value is strictly greater than this bound. */
  readonly gt?: number | undefined;
  /** Value is strictly less than this bound. */
  readonly lt?: number | undefined;
}

/**
 * Union of every permitted raw predicate shape.
 *
 * @remarks
 * This is the **closed vocabulary** of predicate operators. Exactly thirteen
 * leaf-operator forms are recognised plus three compositional forms. Any other
 * shape causes {@link Predicate.compile} to throw {@link OutputConfigError}.
 *
 * **Path syntax**: leading `/`, segments separated by `/`. `~1` escapes a
 * literal `/` in a segment name; `~0` escapes a literal `~` (RFC 6901 order
 * — `~1` decoded before `~0`). The empty string `""` is rejected — at least
 * one segment is required. Numeric segments index into arrays; non-integer or
 * negative strings resolve to missing.
 *
 * **Regex**: must already be anchored (`^...$`). The compiler rejects patterns
 * that do not start with `^` or do not end with `$`. No flags are supported.
 *
 * **Deep equality** (`equals`, `notEquals`, `in`, `notIn`): recursive
 * structural comparison handles arrays, plain objects, and primitives. Does not
 * handle `Date`, `Map`, or `Set`.
 *
 * **Composition**: `all` is `true` iff every nested predicate is `true` (empty
 * → `true`). `any` is `true` iff at least one is `true` (empty → `false`).
 * `not` flips its single nested predicate. All three short-circuit.
 *
 * @category Classification
 * @since 2.2.0
 * @group Types
 */
export type RawPredicate =
  | { readonly path: string; readonly equals:    unknown }
  | { readonly path: string; readonly notEquals: unknown }
  | { readonly path: string; readonly in:        ReadonlyArray<unknown> }
  | { readonly path: string; readonly notIn:     ReadonlyArray<unknown> }
  | { readonly path: string; readonly exists:    true }
  | { readonly path: string; readonly missing:   true }
  | { readonly path: string; readonly type:      'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' }
  | { readonly path: string; readonly regex:     string }
  | { readonly path: string; readonly length:    RawLengthConstraintInterface }
  | { readonly path: string; readonly range:     RawRangeConstraintInterface }
  | { readonly all:  ReadonlyArray<RawPredicate> }
  | { readonly any:  ReadonlyArray<RawPredicate> }
  | { readonly not:  RawPredicate };

// ── Internal AST ─────────────────────────────────────────────────────────────

/** Decoded JSON-Pointer path segments. Pre-split at compile time; reused on every evaluation. */
type PathSegmentsType = ReadonlyArray<string>;

/** Valid `type` discriminant tags matching the `RawPredicate` union. */
type TypeTagType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

/**
 * Tagged-union AST node produced by the compiler. One variant per operator.
 * The evaluator dispatches over `kind` with a switch statement.
 *
 * @internal
 */
type AstNodeType =
  | { readonly kind: 'equals';    readonly segments: PathSegmentsType; readonly value: unknown }
  | { readonly kind: 'notEquals'; readonly segments: PathSegmentsType; readonly value: unknown }
  | { readonly kind: 'in';        readonly segments: PathSegmentsType; readonly values: ReadonlyArray<unknown> }
  | { readonly kind: 'notIn';     readonly segments: PathSegmentsType; readonly values: ReadonlyArray<unknown> }
  | { readonly kind: 'exists';    readonly segments: PathSegmentsType }
  | { readonly kind: 'missing';   readonly segments: PathSegmentsType }
  | { readonly kind: 'type';      readonly segments: PathSegmentsType; readonly typeTag: TypeTagType }
  | { readonly kind: 'regex';     readonly segments: PathSegmentsType; readonly pattern: RegExp }
  | { readonly kind: 'length';    readonly segments: PathSegmentsType; readonly constraint: RawLengthConstraintInterface }
  | { readonly kind: 'range';     readonly segments: PathSegmentsType; readonly constraint: RawRangeConstraintInterface }
  | { readonly kind: 'all';       readonly nodes: ReadonlyArray<AstNodeType> }
  | { readonly kind: 'any';       readonly nodes: ReadonlyArray<AstNodeType> }
  | { readonly kind: 'not';       readonly node: AstNodeType };

/**
 * Opaque compiled predicate wrapping the internal AST node.
 *
 * @remarks
 * Consumers must treat this as a black box. The only supported operations on a
 * compiled predicate are to pass it back to {@link Predicate.evaluate}. The
 * `_kind` discriminant ensures plain objects are never confused with compiled
 * predicates. The `_node` field is marked `@internal` and is subject to change
 * without notice.
 *
 * @category Classification
 * @since 2.2.0
 * @see {@link Predicate}
 * @group Types
 */
export interface CompiledPredicateInterface {
  /** Discriminant tag — always `'compiled'`. */
  readonly _kind: 'compiled';
  /** @internal AST node — do not access directly. */
  readonly _node: AstNodeType;
}

// ── Path utilities ────────────────────────────────────────────────────────────

/**
 * Splits a raw JSON-Pointer path into decoded segments.
 *
 * @remarks
 * Implements RFC 6901 §3 and §4 with one additional restriction: the empty
 * string root reference is rejected. Validates that all escape sequences are
 * legal (`~0` and `~1` only). Decodes `~1` before `~0` as required by the RFC.
 *
 * @param raw - Path string starting with `/`.
 * @returns Tuple of decoded path segments.
 * @throws {OutputConfigError} When `raw` is empty, does not start with `/`, or
 *   contains an illegal escape sequence such as `~2`.
 *
 * @internal
 */
function splitPath(raw: string): PathSegmentsType {
  if (raw === '') {
    throw OutputConfigError.create(
      'Predicate path must not be empty — the root reference "" is rejected. Use "/field" for a top-level field.',
      { metadata: { path: raw } },
    );
  }
  if (!raw.startsWith('/')) {
    throw OutputConfigError.create(
      `Predicate path must start with "/"; got: ${JSON.stringify(raw)}`,
      { metadata: { path: raw } },
    );
  }
  // RFC 6901 §3: strip leading "/" then split on remaining "/".
  const parts = raw.slice(1).split('/');
  return parts.map((segment) => {
    // RFC 6901 §4: only ~0 and ~1 are defined escape sequences.
    if (/~(?![01])/.test(segment)) {
      throw OutputConfigError.create(
        `Invalid escape in path segment "${segment}": only ~0 (encodes "~") and ~1 (encodes "/") are defined.`,
        { metadata: { path: raw, segment } },
      );
    }
    // §4: decode ~1 first, then ~0 (order matters).
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}

// ── Path resolution ───────────────────────────────────────────────────────────

/** Sentinel returned when a path resolves to a missing location in the record. */
const MISSING_SENTINEL = Object.freeze({ found: false as const });

/** Result of resolving a JSON-Pointer path against a value. */
type ResolveResultType = { readonly found: true; readonly value: unknown } | typeof MISSING_SENTINEL;

/**
 * Resolves a pre-split JSON-Pointer path against a value.
 *
 * @remarks
 * Numeric segments index into arrays. A segment is considered numeric only when
 * it is a non-negative integer whose `String(idx)` round-trip matches the original
 * string — this rejects `"01"`, `"-1"`, `"1.5"`, and any other non-canonical form.
 * Negative indices are rejected (no Python-style wrapping). Fractional segments
 * resolve to missing.
 *
 * @param segments - Pre-decoded path segments from {@link splitPath}.
 * @param root - The value to traverse.
 * @returns `{ found: true; value }` or `MISSING_SENTINEL`.
 *
 * @internal
 */
function resolvePath(segments: PathSegmentsType, root: unknown): ResolveResultType {
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      return MISSING_SENTINEL;
    }
    if (Array.isArray(current)) {
      const idx = Number(segment);
      // Reject non-integers, negatives, and non-canonical strings ("01", "1.0", etc.).
      if (!Number.isInteger(idx) || idx < 0 || String(idx) !== segment) {
        return MISSING_SENTINEL;
      }
      if (idx >= current.length) {
        return MISSING_SENTINEL;
      }
      current = current[idx];
    } else if (typeof current === 'object') {
      const rec = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(rec, segment)) {
        return MISSING_SENTINEL;
      }
      current = rec[segment];
    } else {
      // Primitive — cannot descend further.
      return MISSING_SENTINEL;
    }
  }
  return { found: true, value: current };
}

// ── Deep equality ─────────────────────────────────────────────────────────────

/**
 * Recursive deep-structural equality for plain JSON-compatible values.
 *
 * @remarks
 * Handles primitives, `null`, plain objects (by own enumerable keys), and
 * arrays (by index). Does not handle `Date`, `Map`, `Set`, or other exotic
 * objects — predicate constants should be plain JSON values.
 *
 * @param a - Left-hand operand.
 * @param b - Right-hand operand.
 * @returns `true` when `a` and `b` are structurally identical.
 *
 * @internal
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (Array.isArray(b)) return false;

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

// ── Compiler ─────────────────────────────────────────────────────────────────

/**
 * Compiles a single {@link RawPredicate} into an {@link AstNodeType}.
 *
 * @remarks
 * Recursively compiles compositional nodes. For `regex`, validates anchoring
 * and constructs the `RegExp` object. For leaf operators, splits the path
 * into segments. Unknown operator keys throw {@link OutputConfigError}.
 *
 * @param raw - Raw predicate from config.
 * @returns Compiled AST node.
 * @throws {OutputConfigError} On unknown operator, invalid path, or unanchored regex.
 *
 * @internal
 */
function compileNode(raw: RawPredicate): AstNodeType {
  // Compositional forms — no `path` key.
  if ('all' in raw) {
    const allRaw = raw as { all: ReadonlyArray<RawPredicate> };
    return { kind: 'all', nodes: allRaw.all.map(compileNode) };
  }
  if ('any' in raw) {
    const anyRaw = raw as { any: ReadonlyArray<RawPredicate> };
    return { kind: 'any', nodes: anyRaw.any.map(compileNode) };
  }
  if ('not' in raw) {
    const notRaw = raw as { not: RawPredicate };
    return { kind: 'not', node: compileNode(notRaw.not) };
  }

  // All remaining forms require a `path` key.
  if (!('path' in raw)) {
    throw OutputConfigError.create(
      'Unrecognized predicate shape: no "path", "all", "any", or "not" key found.',
      { metadata: { raw: raw as unknown as Record<string, unknown> } },
    );
  }

  const pathRaw = (raw as { path: string }).path;
  const segments = splitPath(pathRaw);
  const r = raw as Record<string, unknown>;

  if ('equals'    in r) return { kind: 'equals',    segments, value:      r['equals'] };
  if ('notEquals' in r) return { kind: 'notEquals', segments, value:      r['notEquals'] };
  if ('in'        in r) return { kind: 'in',        segments, values:     r['in'] as ReadonlyArray<unknown> };
  if ('notIn'     in r) return { kind: 'notIn',     segments, values:     r['notIn'] as ReadonlyArray<unknown> };
  if ('exists'    in r) return { kind: 'exists',    segments };
  if ('missing'   in r) return { kind: 'missing',   segments };

  if ('type' in r) {
    return { kind: 'type', segments, typeTag: r['type'] as TypeTagType };
  }

  if ('regex' in r) {
    const pattern = r['regex'] as string;
    if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
      throw OutputConfigError.create(
        `Predicate "regex" must be anchored: pattern must start with "^" and end with "$". Got: ${JSON.stringify(pattern)}`,
        { metadata: { path: pathRaw, regex: pattern } },
      );
    }
    return { kind: 'regex', segments, pattern: new RegExp(pattern) };
  }

  if ('length' in r) {
    return { kind: 'length', segments, constraint: r['length'] as RawLengthConstraintInterface };
  }
  if ('range'  in r) {
    return { kind: 'range',  segments, constraint: r['range']  as RawRangeConstraintInterface };
  }

  // No recognised operator key was found.
  const unknownKeys = Object.keys(r).filter((k) => k !== 'path');
  throw OutputConfigError.create(
    `Unknown predicate operator(s): ${unknownKeys.map((k) => JSON.stringify(k)).join(', ')}. ` +
    'Allowed operators: equals, notEquals, in, notIn, exists, missing, type, regex, length, range.',
    { metadata: { path: pathRaw, unknownKeys } },
  );
}

// ── Evaluator ─────────────────────────────────────────────────────────────────

/**
 * Evaluates a compiled AST node against a record.
 *
 * @remarks
 * Dispatches over `node.kind` with a switch statement. Leaf operators perform
 * no heap allocations on the hot path — path segments are pre-split and
 * `RegExp` objects are pre-built. Compositional nodes short-circuit.
 *
 * @param node - Compiled AST node.
 * @param record - Record being evaluated.
 * @returns `true` when the predicate is satisfied.
 *
 * @internal
 */
function evaluateNode(node: AstNodeType, record: unknown): boolean {
  switch (node.kind) {

    case 'all': {
      for (const child of node.nodes) {
        if (!evaluateNode(child, record)) return false;
      }
      return true;
    }

    case 'any': {
      for (const child of node.nodes) {
        if (evaluateNode(child, record)) return true;
      }
      return false;
    }

    case 'not': {
      return !evaluateNode(node.node, record);
    }

    case 'equals': {
      const res = resolvePath(node.segments, record);
      return res.found && deepEqual(res.value, node.value);
    }

    case 'notEquals': {
      const res = resolvePath(node.segments, record);
      return res.found && !deepEqual(res.value, node.value);
    }

    case 'in': {
      const res = resolvePath(node.segments, record);
      if (!res.found) return false;
      return node.values.some((v) => deepEqual(res.value, v));
    }

    case 'notIn': {
      const res = resolvePath(node.segments, record);
      if (!res.found) return false;
      return !node.values.some((v) => deepEqual(res.value, v));
    }

    case 'exists': {
      return resolvePath(node.segments, record).found;
    }

    case 'missing': {
      return !resolvePath(node.segments, record).found;
    }

    case 'type': {
      const res = resolvePath(node.segments, record);
      if (!res.found) return false;
      const v = res.value;
      switch (node.typeTag) {
        case 'null':    return v === null;
        case 'array':   return Array.isArray(v);
        case 'object':  return typeof v === 'object' && v !== null && !Array.isArray(v);
        case 'string':  return typeof v === 'string';
        case 'number':  return typeof v === 'number';
        case 'boolean': return typeof v === 'boolean';
        default:        return false;
      }
    }

    case 'regex': {
      const res = resolvePath(node.segments, record);
      if (!res.found) return false;
      if (typeof res.value !== 'string') return false;
      return node.pattern.test(res.value);
    }

    case 'length': {
      const res = resolvePath(node.segments, record);
      if (!res.found) return false;
      const v = res.value;
      if (typeof v !== 'string' && !Array.isArray(v)) return false;
      const len = v.length;
      const c = node.constraint;
      // `eq` takes precedence over `gte`/`lte` when all three are supplied.
      if (c.eq !== undefined) return len === c.eq;
      if (c.gte !== undefined && len < c.gte) return false;
      if (c.lte !== undefined && len > c.lte) return false;
      return true;
    }

    case 'range': {
      const res = resolvePath(node.segments, record);
      if (!res.found) return false;
      const v = res.value;
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
      const c = node.constraint;
      if (c.gt  !== undefined && !(v >  c.gt))  return false;
      if (c.gte !== undefined && !(v >= c.gte)) return false;
      if (c.lt  !== undefined && !(v <  c.lt))  return false;
      if (c.lte !== undefined && !(v <= c.lte)) return false;
      return true;
    }

  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Deterministic, closed-vocabulary predicate engine for the classification cascade.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated. The engine operates
 * in two phases:
 *
 * 1. **Compile** — call {@link Predicate.compile} once at startup for each
 *    predicate in config. The compiler validates the raw shape, splits
 *    JSON-Pointer paths into segment arrays, and pre-builds `RegExp` objects.
 *    Throws {@link OutputConfigError} on invalid input so misconfigured
 *    rulesets fail fast before any records are processed.
 *
 * 2. **Evaluate** — call {@link Predicate.evaluate} on the hot path, once per
 *    record per predicate. The evaluator walks the pre-built AST via a
 *    `switch` over `node.kind`. No heap allocations occur for leaf operators.
 *    Compositional nodes (`all`, `any`) short-circuit at the first conclusive
 *    child.
 *
 * **Closed vocabulary**: exactly thirteen leaf operators are accepted (`equals`,
 * `notEquals`, `in`, `notIn`, `exists`, `missing`, `type`, `regex`, `length`,
 * `range`) plus three compositional forms (`all`, `any`, `not`). Any unknown
 * operator key causes {@link Predicate.compile} to throw immediately.
 *
 * **Internal representation**: the compiler produces a tagged-union AST where
 * each node carries a `kind` discriminant plus pre-computed artifacts
 * (decoded segments, pre-built `RegExp`). The AST is wrapped in an opaque
 * {@link CompiledPredicateInterface} so consumers cannot depend on the shape.
 *
 * @example
 * ```ts
 * const compiled = Predicate.compile({
 *   all: [
 *     { path: '/_type', equals: 'feat' },
 *     { path: '/level', type: 'number' },
 *     { not: { path: '/rarity', equals: 'rare' } },
 *   ],
 * });
 *
 * const matches = Predicate.evaluate(compiled, {
 *   _type: 'feat',
 *   level: 1,
 *   rarity: 'common',
 * });
 * // → true
 * ```
 *
 * @category Classification
 * @since 2.2.0
 * @see {@link RawPredicate}
 * @see {@link CompiledPredicateInterface}
 * @group Core
 */
export class Predicate {
  private constructor() { /* static-only */ }

  /**
   * Compiles a raw predicate descriptor into an opaque compiled form.
   *
   * @remarks
   * Performs full structural validation and pre-computes all expensive
   * operations (path splitting, `RegExp` construction). Call once at startup
   * per config predicate; the result is safe to reuse across many records and
   * across concurrent pipeline runs.
   *
   * @param raw - Raw predicate from the classification config.
   * @returns A compiled predicate ready for repeated evaluation.
   * @throws {OutputConfigError} When `raw` has an unknown operator, an invalid
   *   path (empty string, missing leading `/`, illegal escape), or an
   *   unanchored `regex` pattern.
   *
   * @example
   * ```ts
   * const compiled = Predicate.compile({ path: '/status', in: ['active', 'pending'] });
   * ```
   */
  public static compile(raw: RawPredicate): CompiledPredicateInterface {
    return { _kind: 'compiled', _node: compileNode(raw) };
  }

  /**
   * Evaluates a compiled predicate against a record.
   *
   * @remarks
   * Runs on the hot path — once per record per predicate in the cascade.
   * No heap allocations occur for leaf operators: path segments are pre-split
   * and `RegExp` objects are pre-built during compilation. Composition nodes
   * (`all`, `any`) short-circuit at the first conclusive child result.
   *
   * @param compiled - A compiled predicate from {@link Predicate.compile}.
   * @param record - The record to evaluate (typically `PipelineStateInterface.input`
   *   or any JSON-compatible value).
   * @returns `true` when the record satisfies the predicate; `false` otherwise.
   *
   * @example
   * ```ts
   * const result = Predicate.evaluate(compiled, { status: 'active', score: 42 });
   * ```
   */
  public static evaluate(compiled: CompiledPredicateInterface, record: unknown): boolean {
    return evaluateNode(compiled._node, record);
  }
}
