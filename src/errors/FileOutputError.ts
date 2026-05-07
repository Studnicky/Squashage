import { BaseError } from './BaseError.js';
import type { BaseErrorOptionsInterface } from './BaseError.js';

/**
 * Thrown when a file-output I/O operation fails during the `FileOutput` lifecycle.
 *
 * @remarks
 * Uses error code `FILE_OUTPUT_ERROR`. Always non-retryable because output failures
 * are structural (permissions, disk-full, SHACL validation) and require user action.
 * Thrown by {@link FileOutput} during `open()`, `writeBatch()`, or `close()` when
 * an unrecoverable I/O or serialization error occurs.
 *
 * The `metadata.stage` field mirrors the `OutputErrorInterface.stage` union so
 * callers can identify which lifecycle phase failed without string-parsing `message`.
 *
 * @example
 * ```ts
 * throw FileOutputError.create('SHACL validation failed', {
 *   metadata: { stage: 'validate', path: './graphs/aonprd.jsonld' },
 * });
 * ```
 *
 * @category Output
 * @since 2.2.0
 * @see {@link FileOutput}
 * @see {@link OutputInterface}
 * @group Core
 */
export class FileOutputError extends BaseError {
  /**
   * @param message - Human-readable description of the output failure.
   * @param options - Optional cause and metadata (include `stage` in metadata).
   */
  private constructor(message: string, options: BaseErrorOptionsInterface = {}) {
    super(message, { code: 'FILE_OUTPUT_ERROR', retryable: false, ...options });
  }

  /**
   * Creates a FileOutputError instance.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Optional cause and metadata.
   * @returns A new FileOutputError.
   */
  public static create(message: string, options: BaseErrorOptionsInterface = {}): FileOutputError {
    return new FileOutputError(message, options);
  }
}
