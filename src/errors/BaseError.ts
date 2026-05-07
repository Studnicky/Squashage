import type { FlattenResult } from '../types/Results.js';
// Ported from @noocodec/cogitator/src/errors/BaseError.ts.
// Stripped of redact/JsonObject machinery not needed here. Same shape, same
// protected constructor, same code-derivation rule, same flatten()/serialize()/toJson() surface.

import type { BaseErrorOptionsInterface, BaseErrorJsonType } from '../types/BaseError.js';

export type { BaseErrorOptionsInterface, BaseErrorJsonType };

/**
 * Base class for all squashage domain errors.
 *
 * @remarks
 * Provides a structured `code`, optional `cause`, `metadata`, and `retryable` flag,
 * as well as JSON serialization via `toJson()` and `serialize()`.
 * Error codes are auto-derived from the class name as SCREAMING_SNAKE_CASE unless overridden.
 *
 * @example
 * ```ts
 * throw new SquashageConfigError('Invalid config', { metadata: { path: './squashage.config.json' } });
 * const flat = error.flatten(); // [SquashageConfigError, cause, ...]
 * ```
 *
 * @category Errors
 * @since 2.0.0
 * @see {@link SquashageConfigError}
 * @group Core
 */
export class BaseError extends Error {
  /** SCREAMING_SNAKE_CASE error code, auto-derived from the class name unless overridden. */
  public readonly code:      string;
  /** Underlying error that caused this one, if any. */
  public override readonly cause: Readonly<Error> | undefined;
  /** Arbitrary structured metadata attached to the error. */
  public readonly metadata:  Readonly<Record<string, unknown>> | undefined;
  /** Whether the operation that produced this error can be retried. */
  public readonly retryable: boolean;

  /**
   * @param message - Human-readable error description.
   * @param options - Optional code, cause, metadata, and retryable flag.
   */
  protected constructor(message: string, options: BaseErrorOptionsInterface = {}) {
    super(message);
    this.name      = this.constructor.name;
    this.cause     = options.cause;
    this.metadata  = options.metadata;
    this.retryable = options.retryable ?? false;
    this.code      = options.code ?? BaseError.toCode(this.constructor.name);
  }

  /**
   * Returns a human-readable string for any thrown value.
   *
   * @param error - Any caught value.
   * @returns Serialized BaseError JSON, plain Error message, or `String(error)`.
   */
  public static format(error: unknown): string {
    if (error instanceof BaseError) return error.serialize();
    if (error instanceof Error)     return error.message;
    return String(error);
  }

  /**
   * Serializes this error to a plain JSON-safe object.
   *
   * @param options - Pass `{ stack: false }` to omit stack traces.
   * @returns A structured representation of the error including cause chain.
   */
  public toJson(options: Readonly<{ stack?: boolean }> = {}): BaseErrorJsonType {
    const includeStack = options.stack !== false;
    const json: Record<string, unknown> = {
      code:      this.code,
      message:   this.message,
      name:      this.name,
      retryable: this.retryable,
    };
    if (includeStack && this.stack !== undefined) json['stack'] = this.stack;
    if (this.metadata !== undefined)              json['metadata'] = this.metadata;
    if (this.cause !== undefined) {
      if (this.cause instanceof BaseError) {
        json['cause'] = this.cause.toJson(options);
      } else {
        const causeObj: Record<string, unknown> = { message: this.cause.message, name: this.cause.name };
        if (includeStack && this.cause.stack !== undefined) causeObj['stack'] = this.cause.stack;
        json['cause'] = causeObj;
      }
    }
    return json as unknown as BaseErrorJsonType;
  }

  /**
   * Returns a pretty-printed JSON string of this error.
   *
   * @param space - JSON indentation spaces (default 2). Clamped to 0–10.
   * @param options - Pass `{ stack: false }` to omit stack traces from the output.
   * @returns JSON string representation of `toJson()`.
   */
  public serialize(space: number = 2, options: Readonly<{ stack?: boolean }> = {}): string {
    const indent = Math.min(Math.max(Math.floor(space), 0), 10);
    return JSON.stringify(this.toJson(options), null, indent);
  }

  /**
   * Returns the full error cause chain as a flat array, starting with `this`.
   *
   * @returns Array of errors from outermost to root cause.
   */
  public flatten(): FlattenResult {
    const chain: Error[] = [this];
    let current: Error | undefined = this.cause;
    while (current instanceof Error) {
      chain.push(current);
      current = 'cause' in current && current.cause instanceof Error ? current.cause : undefined;
    }
    return chain;
  }

  private static toCode(name: string): string {
    return name
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .toUpperCase();
  }
}
