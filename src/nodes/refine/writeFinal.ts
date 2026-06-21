/**
 * write-final — writes `state.finalJson` to the finals directory.
 *
 * Output path for class schemas: `services.schemaPaths.finals/<className>.schema.json`
 * Output path for extracted schemas: `services.schemaPaths.finals/<subdir>/<name>.schema.json`
 *   where subdir is `'primitives'` or `'objects'` (from `state.subdir`).
 *
 * Creates the target directory with `mkdir -p` semantics if absent.
 * Serializes with 2-space indent + trailing newline (stable; already
 * key-sorted by `RefinementApplier.apply`).
 *
 * Sets `state.outcome = 'refined'` if it was not already `'passthrough'`
 * (passthrough is set by `refinement-missing-warn` before this node runs).
 *
 * Outputs:
 *   written — file was written successfully
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRefineState } from '../../state/SquashageRefineState.js';

type Output = 'written';

class WriteFinalNodeImpl extends ScalarNode<SquashageRefineState, Output, SquashageServices> {
  public readonly name    = 'write-final';
  public readonly outputs = ['written'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { written: { type: 'object' } };
  }

  protected override async executeOne(
    state:   SquashageRefineState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const log        = context.services.logger.forComponent('write-final');
    const finalsDir  = context.services.schemaPaths.finals;

    // Extracted schemas (primitives/objects) land in a subdirectory.
    const targetDir  = state.subdir !== undefined
      ? join(finalsDir, state.subdir)
      : finalsDir;

    const filename   = `${state.className}.schema.json`;
    const filePath   = join(targetDir, filename);

    await mkdir(targetDir, { recursive: true });

    // Canonicalise $id: if the draft carried an x-squashage-class IRI, promote
    // it to the schema's $id so json-tology mints correct rdf:type objects.
    // The draft $id encodes the inferred path; the x-squashage-class IRI is the
    // canonical class identity for the ontology in path-form, e.g.
    // "https://2e.aonprd.com/vocab/Feat".  json-tology then mints property IRIs
    // as "<classIri>#<propertyName>" — a single fragment separator per RFC 3987.
    // Extracted primitive/object schemas do not have x-squashage-class — their
    // draft $id is already canonical and is preserved as-is.
    const finalDoc = { ...state.finalJson as Record<string, unknown> };
    const classIri = finalDoc['x-squashage-class'];
    if (typeof classIri === 'string' && classIri.length > 0) {
      finalDoc['$id'] = classIri;
    }

    const text = JSON.stringify(finalDoc, null, 2) + '\n';
    await writeFile(filePath, text, 'utf8');

    if (state.outcome !== 'passthrough') {
      state.outcome = 'refined';
    }

    log.info('executeOne', 'final schema written', {
      className: state.className,
      filePath,
      outcome:   state.outcome,
      subdir:    state.subdir,
    });

    return NodeOutputBuilder.of('written');
  }
}

export const writeFinalNode = new WriteFinalNodeImpl();
