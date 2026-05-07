import { BaseError } from './BaseError.js';
import type { BaseErrorOptionsInterface } from './BaseError.js';

/**
 * Thrown when the squashage config file fails validation or cannot be loaded.
 *
 * @remarks
 * Uses error code `SQUASHAGE_CONFIG`. Always non-retryable because config failures
 * are structural — they require a config edit, not a retry.
 * Thrown by {@link SquashageConfig} when the config JSON is missing, unparseable,
 * or fails AJV schema validation against the root squashage-config schema.
 *
 * @example
 * ```ts
 * throw SquashageConfigError.create(
 *   'Invalid config at ./squashage.config.json:\n  targets must have at least 1 property',
 *   { metadata: { configPath: './squashage.config.json' } },
 * );
 * ```
 *
 * @category Configuration
 * @since 2.2.0
 * @see {@link SquashageConfig}
 * @group Core
 */
export class SquashageConfigError extends BaseError {
  /**
   * @param message - Human-readable description of the config failure.
   * @param options - Optional cause and metadata.
   */
  private constructor(message: string, options: BaseErrorOptionsInterface = {}) {
    super(message, { code: 'SQUASHAGE_CONFIG', retryable: false, ...options });
  }

  /**
   * Creates a SquashageConfigError instance.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional cause and metadata.
   * @returns A new SquashageConfigError.
   */
  public static create(message: string, options: BaseErrorOptionsInterface = {}): SquashageConfigError {
    return new SquashageConfigError(message, options);
  }
}
