/**
 * @fileoverview Fixture plugin for the `build-classify-cascade` integration test suite.
 *
 * @remarks
 * Registers one minimal pipeline task used by the integration test:
 *
 * - `fixture:squash` — reads `state.classification.type` and emits one quad
 *   per record into the shared `state.context.dataset`:
 *   `<https://example.org/{type}/{id}> rdf:type <https://example.org/{type}>`
 *
 * Records that land a non-null classification emit a quad; records quarantined
 * by `classify:conflict` (unknown policy) have `state.classification === null`
 * and emit nothing.
 *
 * @module tests/fixtures/squashage/build-classify-cascade/plugin
 * @category TestFixture
 * @since 2.2.0
 */

import { TaskRegistry }  from '../../../../src/registry/TaskRegistry.js';
import { dataFactory }   from '../../../../src/rdf/DataFactory.js';
import type { NextFnInterface }         from '../../../../src/types/Pipeline.js';
import type { PipelineStateInterface }  from '../../../../src/types/PipelineState.js';

// ---------------------------------------------------------------------------
// Shared IRIs
// ---------------------------------------------------------------------------

const RDF_TYPE = dataFactory.namedNode(
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
);

// ---------------------------------------------------------------------------
// Task: fixture:squash
// ---------------------------------------------------------------------------

/**
 * Emits one quad per record based on `state.classification.type`.
 *
 * @remarks
 * When `state.classification` is non-null (record was classified), emits:
 * `<https://example.org/{type}/{id}> rdf:type <https://example.org/{type}>`
 *
 * When `state.classification` is null (record was quarantined by
 * `classify:conflict`), emits nothing and calls `next()`.
 *
 * @param next  - Advance function; called unconditionally.
 * @param state - Mutable pipeline state.
 */
const squashTask = async (
  next:  NextFnInterface,
  state: PipelineStateInterface,
): Promise<void> => {
  const ctx            = state.context;
  const classification = state.classification;

  if (ctx !== undefined && classification !== null) {
    const id      = typeof state.input['id'] === 'string' ? state.input['id'] : 'unknown';
    const type    = classification.type;
    const subject = dataFactory.namedNode(`https://example.org/${type}/${id}`);
    const object  = dataFactory.namedNode(`https://example.org/${type}`);

    ctx.dataset.add(dataFactory.quad(subject, RDF_TYPE, object));
  }

  await next();
};

// ---------------------------------------------------------------------------
// Exports and registration
// ---------------------------------------------------------------------------

/** Name under which the squash fixture task is registered. */
export const SQUASH_TASK_NAME = 'fixture:squash' as const;

/**
 * Registers the cascade fixture squash task in the global {@link TaskRegistry}.
 *
 * @remarks
 * Safe to call multiple times — `TaskRegistry.register` overwrites existing
 * entries, so repeated calls are idempotent.
 */
export function registerFixtureTasks(): void {
  TaskRegistry.register(SQUASH_TASK_NAME, squashTask);
}
