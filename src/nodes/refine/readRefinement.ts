/**
 * read-refinement — reads and validates the refinement JSON file from disk.
 *
 * When `state.refinementPath` is `null`, returns `'missing'` immediately
 * (the `refinement-missing-warn` node handles the passthrough case).
 *
 * On success, populates `state.refinementJson`. The document is validated
 * against the refinement JSON Schema via `services.ajv`; an invalid document
 * is treated as an error.
 *
 * Outputs:
 *   loaded  — refinement parsed and validated; state.refinementJson populated
 *   missing — state.refinementPath is null (no refinement for this class)
 *   error   — file not found, invalid JSON, or schema validation failure
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { NodeInterface } from '@noocodex/dagonizer';
import type { JsonObject } from '@noocodex/dagonizer/types';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRefineState } from '../../state/SquashageRefineState.js';

type Output = 'loaded' | 'missing' | 'error';

const REFINEMENT_SCHEMA_ID = 'https://squashage.dev/schemas/refinement.schema.json';

/**
 * Load the refinement meta-schema from `src/schemas/refinement.schema.json`.
 * Uses a require-derived path so it resolves correctly from any cwd.
 */
function loadRefinementSchema(): Record<string, unknown> {
  const require = createRequire(import.meta.url);
  const schemaPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../schemas/refinement.schema.json',
  );
  return require(schemaPath) as Record<string, unknown>;
}

export const readRefinementNode: NodeInterface<SquashageRefineState, Output, SquashageServices> = {
  name:    'read-refinement',
  outputs: ['loaded', 'missing', 'error'],

  async execute(state, context): Promise<{ output: Output }> {
    const log = context.services.logger.forComponent('read-refinement');

    if (state.refinementPath === null) {
      log.debug('execute', 'no refinement file for class', { className: state.className });
      return { output: 'missing' };
    }

    let text: string;
    try {
      text = await readFile(state.refinementPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('execute', 'failed to read refinement file', {
        refinementPath: state.refinementPath,
        message,
      });
      state.collectError({
        code:        'READ_REFINEMENT_IO',
        message,
        operation:   'read-refinement.execute',
        recoverable: false,
        timestamp:   new Date().toISOString(),
      });
      return { output: 'error' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('execute', 'failed to parse refinement JSON', {
        refinementPath: state.refinementPath,
        message,
      });
      state.collectError({
        code:        'READ_REFINEMENT_PARSE',
        message,
        operation:   'read-refinement.execute',
        recoverable: false,
        timestamp:   new Date().toISOString(),
      });
      return { output: 'error' };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const message = 'refinement is not a JSON object';
      log.error('execute', message, { refinementPath: state.refinementPath });
      state.collectError({
        code:        'READ_REFINEMENT_NOT_OBJECT',
        message,
        operation:   'read-refinement.execute',
        recoverable: false,
        timestamp:   new Date().toISOString(),
      });
      return { output: 'error' };
    }

    // Validate against the refinement JSON Schema.
    // We strip `$schema` from the schema document before adding it to AJV
    // because AJV v8 would otherwise try to load the 2020-12 meta-schema URI
    // as a dependency — which is not registered. The validation logic itself
    // does not need the meta-schema URI to function correctly.
    const ajv = context.services.ajv;
    let validate = ajv.getSchema(REFINEMENT_SCHEMA_ID);
    if (validate === undefined) {
      const rawSchema = loadRefinementSchema();
      const schema: Record<string, unknown> = Object.fromEntries(
        Object.entries(rawSchema).filter(([k]) => k !== '$schema'),
      );
      ajv.addSchema(schema, REFINEMENT_SCHEMA_ID);
      validate = ajv.getSchema(REFINEMENT_SCHEMA_ID);
    }

    if (validate !== undefined && !validate(parsed)) {
      const errs = validate.errors ?? [];
      const summary = errs.map((e) => `${e.instancePath ?? ''} ${e.message ?? ''}`).join('; ');
      const message = `refinement validation failed: ${summary}`;
      log.error('execute', message, { refinementPath: state.refinementPath });
      state.collectError({
        code:        'READ_REFINEMENT_INVALID',
        message,
        operation:   'read-refinement.execute',
        recoverable: false,
        timestamp:   new Date().toISOString(),
      });
      return { output: 'error' };
    }

    state.refinementJson = parsed as JsonObject;
    log.debug('execute', 'refinement loaded', { className: state.className });
    return { output: 'loaded' };
  },
};
