import type { InputSourceInterface, PipelineStateInterface } from '../types/PipelineState.js';

export type { PipelineStateInterface };

/**
 * Factory for creating initial PipelineStateInterface objects for graph reconstitution runs.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated.
 * Produced state objects have `output` and `classification` initialised to `null`
 * and are ready to pass into a {@link Pipeline}.
 *
 * @example
 * ```ts
 * const state = PipelineState.fromInput('aonprd', source, record);
 * await pipeline.execute(state);
 * ```
 *
 * @category Registry
 * @since 2.1.0
 * @see {@link PipelineStateInterface}
 * @group Core
 */
export class PipelineState {
  private constructor() { /* static-only */ }

  /**
   * Creates a pipeline state from an input JSON record and its source metadata.
   *
   * @param targetId - Squashage target key from the config.
   * @param source - Source metadata (target, path, optional plugin and schemaId).
   * @param input - Parsed input JSON record (immutable snapshot).
   * @returns Initial pipeline state with `output` and `classification` set to `null`.
   */
  public static fromInput(
    targetId: string,
    source:   InputSourceInterface,
    input:    Readonly<Record<string, unknown>>,
  ): PipelineStateInterface {
    return {
      targetId,
      source,
      input,
      classification:  null,
      classifications: [],
      output:          null,
    };
  }
}
