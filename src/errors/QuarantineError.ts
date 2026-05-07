import { BaseError } from './BaseError.js';
import type { BaseErrorOptionsInterface } from './BaseError.js';

/**
 * Thrown when a quarantine record cannot be written to disk due to an I/O failure.
 *
 * @remarks
 * Uses error code `QUARANTINE_ERROR`. Always non-retryable because I/O failures
 * during quarantine writes are structural (permissions, disk-full, etc.).
 * Thrown by {@link QuarantineWriter.write} when `node:fs/promises.writeFile` rejects.
 * The caller decides whether to swallow the error or propagate it.
 *
 * @example
 * ```ts
 * throw QuarantineError.create('Failed to write quarantine record', { cause: err, metadata: { path } });
 * ```
 *
 * @category Quarantine
 * @since 2.1.0
 * @see {@link QuarantineWriter}
 * @group Core
 */
export class QuarantineError extends BaseError {
  /**
   * @param message - Human-readable description of the I/O failure.
   * @param options - Optional cause and metadata.
   */
  private constructor(message: string, options: BaseErrorOptionsInterface = {}) {
    super(message, { code: 'QUARANTINE_ERROR', retryable: false, ...options });
  }

  /**
   * Creates a QuarantineError instance.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional cause and metadata.
   * @returns A new QuarantineError.
   */
  public static create(message: string, options: BaseErrorOptionsInterface = {}): QuarantineError {
    return new QuarantineError(message, options);
  }
}
