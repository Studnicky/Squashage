/**
 * @fileoverview AJV-backed schema classification engine for the Squashage pipeline.
 *
 * @remarks
 * Provides {@link AjvClassifier}, a deterministic engine that runs a record
 * against an ordered set of pre-compiled AJV {@link ValidateFunction} references
 * and emits one {@link ClassificationProposalInterface} per validator that
 * returns `true`. The engine does not compile schemas itself — the caller is
 * responsible for compiling via `ajv.compile(schema)` and supplying the
 * resulting `ValidateFunction` in an {@link AjvClassEntryInterface}.
 *
 * @module
 * @since 2.2.0
 * @category Classification
 */

import type { ValidateFunction } from 'ajv';

import type { ClassificationProposalInterface } from '../types/PipelineState.js';
import { OutputConfigError } from '../errors/OutputConfigError.js';
import { Logger } from '../modules/logger/logger.js';

const logger = Logger.forComponent('AjvClassifier');

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * One entry in the ordered set of AJV class validators managed by {@link AjvClassifier}.
 *
 * @remarks
 * The `validate` function **must** be pre-compiled by the caller via
 * `ajv.compile(schema)`. The engine never re-compiles; it only calls the
 * function and reads its boolean return value.
 *
 * @example
 * ```ts
 * const entry: AjvClassEntryInterface = {
 *   className: 'feat',
 *   priority:  10,
 *   validate:  ajv.compile({ type: 'object', required: ['level'] }),
 * };
 * ```
 *
 * @category Classification
 * @since 2.2.0
 * @see {@link AjvClassifier}
 * @group Types
 */
export interface AjvClassEntryInterface {
  /** Ontology class id proposed when `validate` returns `true` (e.g. `"feat"`). */
  readonly className: string;
  /** Ordering hint forwarded verbatim into the emitted proposal. */
  readonly priority:  number;
  /** Pre-compiled AJV validator; supplied by the orchestrator-side factory. */
  readonly validate:  ValidateFunction;
}

// ── AjvClassifier ─────────────────────────────────────────────────────────────

/**
 * Engine that runs a record against an ordered set of pre-compiled AJV
 * validators and emits one proposal per validator that returns `true`.
 *
 * @remarks
 * The engine iterates entries once per {@link classify} call. For each entry
 * whose `validate(record)` returns `true`, it pushes a
 * {@link ClassificationProposalInterface} with:
 * - `source:     'classify:schema'`
 * - `className:  entry.className`
 * - `priority:   entry.priority`
 * - `confidence: 1`
 * - `reasons:    [\`schema:${entry.className} matched\`]`
 *
 * The engine does NOT depend on the AJV runtime — only on the
 * `ValidateFunction` type imported from `ajv`. No AJV instance is stored or
 * created at construction time.
 *
 * @example
 * ```ts
 * const engine = new AjvClassifier([
 *   { className: 'feat',  priority: 10, validate: ajv.compile(featSchema) },
 *   { className: 'spell', priority:  5, validate: ajv.compile(spellSchema) },
 * ]);
 * const proposals = engine.classify({ _type: 'feat', level: 1 });
 * // → [{ source: 'classify:schema', className: 'feat', priority: 10, confidence: 1, reasons: ['schema:feat matched'] }]
 * ```
 *
 * @category Classification
 * @since 2.2.0
 * @see {@link AjvClassEntryInterface}
 * @see {@link ClassificationProposalInterface}
 * @group Core
 */
export class AjvClassifier {
  readonly #entries: ReadonlyArray<AjvClassEntryInterface>;

  /**
   * @param entries - Ordered AJV class entries. The caller is responsible for
   *   compiling schemas via `ajv.compile(...)` and supplying the resulting
   *   `ValidateFunction` references. The engine does NOT compile.
   * @throws {OutputConfigError} When `entries` is empty.
   */
  constructor(entries: ReadonlyArray<AjvClassEntryInterface>) {
    if (entries.length === 0) {
      throw OutputConfigError.create('AjvClassifier requires at least one entry', {
        metadata: { task: 'classify:schema' },
      });
    }
    this.#entries = entries;
    logger.debug('constructor', `AjvClassifier initialised with ${entries.length.toString()} entr${entries.length === 1 ? 'y' : 'ies'}`, { count: entries.length });
  }

  /**
   * Runs all validators against `record` and returns the matching proposals.
   *
   * @remarks
   * Returns an empty array when no validator matches. The proposals are
   * returned in the same order as the `entries` supplied at construction.
   *
   * @param record - The value to validate (typically a parsed JSON record).
   * @returns All matching proposals; empty when none match.
   */
  public classify(record: unknown): ReadonlyArray<ClassificationProposalInterface> {
    const proposals: ClassificationProposalInterface[] = [];

    for (const entry of this.#entries) {
      if (entry.validate(record)) {
        logger.debug('classify', `Schema matched: ${entry.className}`, { className: entry.className, priority: entry.priority });
        proposals.push({
          source:     'classify:schema',
          className:  entry.className,
          priority:   entry.priority,
          confidence: 1,
          reasons:    [`schema:${entry.className} matched`],
        });
      }
    }

    logger.debug('classify', `Classification complete: ${proposals.length.toString()} proposal(s)`, { count: proposals.length });
    return proposals;
  }
}
