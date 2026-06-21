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

import { ScalarNode, NodeOutputBuilder, NodeErrorBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';
import type { JsonObjectType } from '@studnicky/dagonizer/entities';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRefineState } from '../../state/SquashageRefineState.js';

type Output = 'loaded' | 'missing' | 'error';

const REFINEMENT_SCHEMA_ID = 'https://squashage.dev/schemas/refinement.schema.json';

class ReadRefinementNodeImpl extends ScalarNode<SquashageRefineState, Output, SquashageServices> {
  public readonly name    = 'read-refinement';
  public readonly outputs = ['loaded', 'missing', 'error'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return {
      loaded:  { type: 'object' },
      missing: { type: 'object' },
      error:   { type: 'object' },
    };
  }

  /**
   * Load the refinement meta-schema from `src/schemas/refinement.schema.json`.
   * Uses a require-derived path so it resolves correctly from any cwd.
   */
  static loadSchema(): Record<string, unknown> {
    const require = createRequire(import.meta.url);
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../schemas/refinement.schema.json',
    );
    return require(schemaPath) as Record<string, unknown>;
  }

  protected override async executeOne(
    state:   SquashageRefineState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const log = context.services.logger.forComponent('read-refinement');

    if (state.refinementPath === null) {
      log.debug('executeOne', 'no refinement file for class', { className: state.className });
      return NodeOutputBuilder.of('missing');
    }

    let text: string;
    try {
      text = await readFile(state.refinementPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('executeOne', 'failed to read refinement file', {
        refinementPath: state.refinementPath,
        message,
      });
      state.collectError(NodeErrorBuilder.from(
        'READ_REFINEMENT_IO', message, 'read-refinement.executeOne', false, new Date().toISOString(),
      ));
      return NodeOutputBuilder.of('error');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('executeOne', 'failed to parse refinement JSON', {
        refinementPath: state.refinementPath,
        message,
      });
      state.collectError(NodeErrorBuilder.from(
        'READ_REFINEMENT_PARSE', message, 'read-refinement.executeOne', false, new Date().toISOString(),
      ));
      return NodeOutputBuilder.of('error');
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const message = 'refinement is not a JSON object';
      log.error('executeOne', message, { refinementPath: state.refinementPath });
      state.collectError(NodeErrorBuilder.from(
        'READ_REFINEMENT_NOT_OBJECT', message, 'read-refinement.executeOne', false, new Date().toISOString(),
      ));
      return NodeOutputBuilder.of('error');
    }

    // Validate against the refinement JSON Schema.
    // We strip `$schema` from the schema document before adding it to AJV
    // because AJV v8 would otherwise try to load the 2020-12 meta-schema URI
    // as a dependency — which is not registered. The validation logic itself
    // does not need the meta-schema URI to function correctly.
    const ajv = context.services.ajv;
    let validate = ajv.getSchema(REFINEMENT_SCHEMA_ID);
    if (validate === undefined) {
      const rawSchema = ReadRefinementNodeImpl.loadSchema();
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
      log.error('executeOne', message, { refinementPath: state.refinementPath });
      state.collectError(NodeErrorBuilder.from(
        'READ_REFINEMENT_INVALID', message, 'read-refinement.executeOne', false, new Date().toISOString(),
      ));
      return NodeOutputBuilder.of('error');
    }

    state.refinementJson = parsed as JsonObjectType;
    log.debug('executeOne', 'refinement loaded', { className: state.className });
    return NodeOutputBuilder.of('loaded');
  }
}

export const readRefinementNode = new ReadRefinementNodeImpl();
