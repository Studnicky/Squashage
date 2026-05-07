/**
 * @fileoverview Fixture plugin for the `build-trig` integration test suite.
 *
 * @remarks
 * Registers three minimal pipeline tasks used by integration tests in lieu of
 * real classifier and squash plugins:
 *
 * - `fixture:classify` — sets `state.classification` to a fixed stub result so
 *   the pipeline does not depend on a live classification engine.
 * - `fixture:squash` — emits exactly **two quads per record** into the shared
 *   `state.context.dataset`:
 *   1. `<https://example.org/{name}> rdf:type <https://example.org/Thing>`
 *   2. `<https://example.org/{name}> <https://example.org/name> "{name}"^^xsd:string`
 * - `fixture:squash-type-only` — emits only the `rdf:type` triple (no `ex:name`)
 *   so that SHACL shapes requiring `sh:minCount 1` on `ex:name` will fail. Used
 *   exclusively by the SHACL non-conforming test scenario.
 *
 * All IRIs follow the `https://example.org/` base used in the test configs.
 * Registration is idempotent — `TaskRegistry.register` overwrites prior entries.
 *
 * @module tests/fixtures/squashage/build-trig/plugin
 * @category TestFixture
 * @since 0.1.0
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
const EX_THING   = dataFactory.namedNode('https://example.org/Thing');
const EX_NAME    = dataFactory.namedNode('https://example.org/name');
const XSD_STRING = dataFactory.namedNode(
  'http://www.w3.org/2001/XMLSchema#string',
);

// ---------------------------------------------------------------------------
// Task: fixture:classify
// ---------------------------------------------------------------------------

/**
 * Populates `state.classification` with a fixed stub result.
 *
 * @remarks
 * The stub always reports `{ type: 'thing', confidence: 1, engine: 'fixture',
 * reasons: ['fixture'] }` so downstream tasks have a non-null classification
 * without requiring a live classification engine.
 *
 * @param next  - Advance function; called unconditionally.
 * @param state - Mutable pipeline state.
 */
const classifyTask = async (
  next:  NextFnInterface,
  state: PipelineStateInterface,
): Promise<void> => {
  state.classification = {
    type:       'thing',
    confidence: 1,
    engine:     'fixture',
    reasons:    ['fixture'],
  };
  await next();
};

// ---------------------------------------------------------------------------
// Task: fixture:squash
// ---------------------------------------------------------------------------

/**
 * Emits two quads per record into the shared run-wide dataset.
 *
 * @remarks
 * Uses `state.input['name']` to build the subject IRI `https://example.org/{name}`.
 * Emits `rdf:type ex:Thing` and `ex:name "{name}"^^xsd:string`.
 * Falls back to `'unknown'` when `name` is absent or non-string.
 *
 * @param next  - Advance function; called unconditionally.
 * @param state - Mutable pipeline state.
 */
const squashTask = async (
  next:  NextFnInterface,
  state: PipelineStateInterface,
): Promise<void> => {
  const ctx  = state.context;
  const name = typeof state.input['name'] === 'string' ? state.input['name'] : 'unknown';

  if (ctx !== undefined) {
    const subject = dataFactory.namedNode(`https://example.org/${name}`);

    ctx.dataset.add(dataFactory.quad(subject, RDF_TYPE, EX_THING));
    ctx.dataset.add(dataFactory.quad(subject, EX_NAME, dataFactory.literal(name, XSD_STRING)));
  }

  await next();
};

// ---------------------------------------------------------------------------
// Task: fixture:squash-type-only
// ---------------------------------------------------------------------------

/**
 * Emits only the `rdf:type ex:Thing` quad; intentionally omits `ex:name`.
 *
 * @remarks
 * Designed for the SHACL non-conforming scenario: when a shapes file requires
 * `sh:minCount 1` on `ex:name`, this task produces a dataset that fails validation
 * because the emitted resource has a type but no name property.
 *
 * @param next  - Advance function; called unconditionally.
 * @param state - Mutable pipeline state.
 */
const squashTypeOnlyTask = async (
  next:  NextFnInterface,
  state: PipelineStateInterface,
): Promise<void> => {
  const ctx  = state.context;
  const name = typeof state.input['name'] === 'string' ? state.input['name'] : 'unknown';

  if (ctx !== undefined) {
    const subject = dataFactory.namedNode(`https://example.org/${name}`);
    ctx.dataset.add(dataFactory.quad(subject, RDF_TYPE, EX_THING));
    // Intentionally omits the ex:name triple — SHACL will report a violation.
  }

  await next();
};

// ---------------------------------------------------------------------------
// Exports and registration
// ---------------------------------------------------------------------------

/** Name under which the classify fixture task is registered. */
export const CLASSIFY_TASK_NAME   = 'fixture:classify' as const;
/** Name under which the full squash fixture task is registered. */
export const SQUASH_TASK_NAME     = 'fixture:squash' as const;
/** Name under which the type-only squash fixture task is registered. */
export const SQUASH_TYPE_ONLY_NAME = 'fixture:squash-type-only' as const;

/**
 * Registers all fixture tasks in the global {@link TaskRegistry}.
 *
 * @remarks
 * Safe to call multiple times — `TaskRegistry.register` overwrites existing
 * entries so repeated calls are idempotent.
 */
export function registerFixtureTasks(): void {
  TaskRegistry.register(CLASSIFY_TASK_NAME,    classifyTask);
  TaskRegistry.register(SQUASH_TASK_NAME,      squashTask);
  TaskRegistry.register(SQUASH_TYPE_ONLY_NAME, squashTypeOnlyTask);
}
