/**
 * Named return type aliases per `functionReturnTypeNamingValidator`.
 * Only non-trivial aliases live here — primitives and direct interface
 * re-aliases are forbidden by `canonicalDeclarationsValidator`.
 *
 * @remarks
 * Trivial aliases such as `type FooResult = string` are intentionally omitted.
 * Use the primitive directly for those cases.
 *
 * @module Results
 */

// ─── BaseError ────────────────────────────────────────────────────────────────

/**
 * Return type of {@link BaseError.flatten} — the full error cause chain as a
 * flat array, starting with `this`.
 *
 * @remarks Useful for logging or serialising nested error chains without
 * recursive traversal at the call site.
 * @example `const chain: FlattenResult = error.flatten();`
 * @category Results
 * @since 2.0.0
 * @see {@link BaseError}
 * @group Errors
 */
export type FlattenResult = Error[];

// ─── Schema ───────────────────────────────────────────────────────────────────

/**
 * Return type of schema validation methods — `null` when the input
 * is valid; a human-readable error string describing the first violation otherwise.
 *
 * @remarks The string format is suitable for direct display in CLI error messages.
 * @example `const err: ValidateResult = SquashageConfigSchema.validate(raw);  if (err) throw new SquashageConfigError(err);`
 * @category Results
 * @since 2.0.0
 * @see {@link SquashageConfig}
 * @group Schema
 */
export type ValidateResult = string | null;
