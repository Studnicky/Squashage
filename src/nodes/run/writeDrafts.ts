/**
 * write-drafts — serializes induced schema documents to disk.
 *
 * Writes one JSON file per induced schema:
 *   - Class schemas     → `<inferredDir>/<className>.draft.json`
 *   - Extracted primitives → `<inferredDir>/primitives/<Name>.draft.json`
 *   - Extracted objects    → `<inferredDir>/objects/<Name>.draft.json`
 *
 * Creates directories with `mkdir -p` semantics before the first write.
 *
 * Byte-stability guarantee: `SchemaInducer.materialize` emits key-sorted
 * objects; `JSON.stringify(schema, null, 2) + '\n'` over a key-sorted document
 * is deterministic. Same dataset + same code → byte-identical draft files.
 *
 * Outputs:
 *   written — at least one draft was written
 *   skipped — state.inducedSchemas is null or all arrays are empty
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NodeInterface } from '@noocodex/dagonizer';

import type { InducedSchemaInterface } from '../../induction/SchemaInducer.js';
import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageInduceRunState } from '../../state/SquashageInduceRunState.js';

type Output = 'written' | 'skipped';

export const writeDraftsNode: NodeInterface<SquashageInduceRunState, Output, SquashageServices> = {
  name:    'write-drafts',
  outputs: ['written', 'skipped'],

  async execute(state, context) {
    const log = context.services.logger.forComponent('write-drafts');

    const schemaSet = state.inducedSchemas;
    if (
      schemaSet === null ||
      (schemaSet.classes.length === 0 &&
       schemaSet.primitives.length === 0 &&
       schemaSet.objects.length === 0)
    ) {
      log.info('execute', 'no induced schemas; skipping write', {});
      return { output: 'skipped' };
    }

    const outDir       = context.services.schemaPaths.inferred;
    const primitivesDir = join(outDir, 'primitives');
    const objectsDir    = join(outDir, 'objects');

    // Ensure all three directories exist.
    await mkdir(outDir, { recursive: true });
    if (schemaSet.primitives.length > 0) {
      await mkdir(primitivesDir, { recursive: true });
    }
    if (schemaSet.objects.length > 0) {
      await mkdir(objectsDir, { recursive: true });
    }

    let count = 0;

    async function writeSchema(induced: InducedSchemaInterface, dir: string, suffix: string): Promise<void> {
      const filename = `${induced.className}${suffix}`;
      const filePath = join(dir, filename);
      const text     = JSON.stringify(induced.schema, null, 2) + '\n';
      await writeFile(filePath, text, 'utf8');
    }

    // Write class drafts.
    for (const induced of schemaSet.classes) {
      await writeSchema(induced, outDir, '.draft.json');
      count++;
    }

    // Write extracted primitive drafts.
    for (const induced of schemaSet.primitives) {
      await writeSchema(induced, primitivesDir, '.draft.json');
      count++;
    }

    // Write extracted object drafts.
    for (const induced of schemaSet.objects) {
      await writeSchema(induced, objectsDir, '.draft.json');
      count++;
    }

    state.draftsWritten = count;

    log.info('execute', 'drafts written', {
      classes:    schemaSet.classes.length,
      primitives: schemaSet.primitives.length,
      objects:    schemaSet.objects.length,
      total:      count,
      outDir,
    });

    return { output: 'written' };
  },
};
