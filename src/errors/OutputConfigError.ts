import { BaseError } from './BaseError.js';
import type { BaseErrorOptionsInterface } from './BaseError.js';

/**
 * Thrown when an output config block fails validation or is semantically invalid at runtime.
 *
 * @remarks
 * Uses error code `OUTPUT_CONFIG`. Always non-retryable because output config failures
 * are structural — they require a config edit, not a retry.
 * Thrown by {@link OutputConfig} when the output block is missing required fields,
 * uses an unsupported format, or specifies incompatible options (e.g. `mode: stream`
 * with `canonicalize: true`).
 *
 * @example
 * ```ts
 * throw OutputConfigError.create('stream mode is incompatible with canonicalize', {
 *   metadata: { path: './graphs/aonprd.jsonld', mode: 'stream' },
 * });
 * ```
 *
 * @category Configuration
 * @since 2.2.0
 * @see {@link OutputConfig}
 * @group Core
 */
export class OutputConfigError extends BaseError {
  /**
   * @param message - Human-readable description of the output config failure.
   * @param options - Optional cause and metadata.
   */
  private constructor(message: string, options: BaseErrorOptionsInterface = {}) {
    super(message, { code: 'OUTPUT_CONFIG', retryable: false, ...options });
  }

  /**
   * Creates an OutputConfigError instance.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional cause and metadata.
   * @returns A new OutputConfigError.
   */
  public static create(message: string, options: BaseErrorOptionsInterface = {}): OutputConfigError {
    return new OutputConfigError(message, options);
  }
}
