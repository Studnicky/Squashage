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

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { InducedSchemaInterface } from '../../induction/SchemaInducer.js';
import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageInduceRunState } from '../../state/SquashageInduceRunState.js';

type Output = 'written' | 'skipped';

class WriteDraftsNodeImpl extends ScalarNode<SquashageInduceRunState, Output, SquashageServices> {
  public readonly name    = 'write-drafts';
  public readonly outputs = ['written', 'skipped'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return {
      written: { type: 'object' },
      skipped: { type: 'object' },
    };
  }

  private static async writeSchema(induced: InducedSchemaInterface, dir: string, suffix: string): Promise<void> {
    const filename = `${induced.className}${suffix}`;
    const filePath = join(dir, filename);
    const text     = JSON.stringify(induced.schema, null, 2) + '\n';
    await writeFile(filePath, text, 'utf8');
  }

  protected override async executeOne(
    state:   SquashageInduceRunState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const log = context.services.logger.forComponent('write-drafts');

    const schemaSet = state.inducedSchemas;
    if (
      schemaSet === null ||
      (schemaSet.classes.length === 0 &&
       schemaSet.primitives.length === 0 &&
       schemaSet.objects.length === 0)
    ) {
      log.info('executeOne', 'no induced schemas; skipping write', {});
      return NodeOutputBuilder.of('skipped');
    }

    const outDir        = context.services.schemaPaths.inferred;
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

    // Write class drafts.
    for (const induced of schemaSet.classes) {
      await WriteDraftsNodeImpl.writeSchema(induced, outDir, '.draft.json');
      count++;
    }

    // Write extracted primitive drafts.
    for (const induced of schemaSet.primitives) {
      await WriteDraftsNodeImpl.writeSchema(induced, primitivesDir, '.draft.json');
      count++;
    }

    // Write extracted object drafts.
    for (const induced of schemaSet.objects) {
      await WriteDraftsNodeImpl.writeSchema(induced, objectsDir, '.draft.json');
      count++;
    }

    state.draftsWritten = count;

    log.info('executeOne', 'drafts written', {
      classes:    schemaSet.classes.length,
      primitives: schemaSet.primitives.length,
      objects:    schemaSet.objects.length,
      total:      count,
      outDir,
    });

    return NodeOutputBuilder.of('written');
  }
}

export const writeDraftsNode = new WriteDraftsNodeImpl();
