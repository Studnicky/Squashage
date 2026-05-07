/**
 * @fileoverview Built-in `ontology:emit` task for the Squashage pipeline.
 *
 * @remarks
 * Writes auto-derived OWL TBox and SHACL shapes files when the json-tology
 * engine is active on the current target. The task is a no-op when
 * `state.context.jt` is undefined (engine absent or set to the default "map"
 * mode). When `jt` is present, the task reads the emit paths from the target's
 * `ontology.emit.tbox` and `ontology.emit.shacl` config keys, serializes the
 * TBox and SHACL quads to Turtle, and writes them to those paths relative to
 * the run's output directory.
 *
 * The task is registered under the name `ontology:emit` at module load time.
 * Include it in a target's `pipeline` array after `rdfjs:finalize` (or before
 * it; order relative to finalize does not matter since this task reads from
 * `state.context.jt`, not the shared dataset).
 *
 * @module
 * @since 0.5.0
 * @category Tasks
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join }    from 'node:path';

import type { NextFnInterface, TaskFnInterface } from '../types/Pipeline.js';
import type { PipelineStateInterface }           from '../types/PipelineState.js';
import { TaskRegistry }  from '../registry/TaskRegistry.js';
import { Logger }        from '../modules/logger/logger.js';
import { ExternalSchemaError } from '../errors/ExternalSchemaError.js';
import { Serializer }    from '../rdf/Serializer.js';

const logger = Logger.forComponent('ontologyEmit');

/** Name under which `ontology:emit` is registered in the {@link TaskRegistry}. */
export const TASK_NAME = 'ontology:emit' as const;

/**
 * Pipeline task function for `ontology:emit`.
 *
 * @remarks
 * When `state.context.jt` is undefined the task calls `next()` and returns
 * immediately, preserving v0.4.0 behavior for targets that do not opt in to
 * the json-tology engine. When `jt` is present, TBox and SHACL quads are
 * serialized to Turtle and written to the paths configured under
 * `targets.<id>.ontology.emit.tbox` and `.shacl` (resolved relative to the
 * run output directory).
 *
 * @param next  - Advance function; called after both writes succeed (or on no-op).
 * @param state - Pipeline state whose `context` carries the run-wide config and
 *   the optional `jt` ontology instance.
 * @throws {ExternalSchemaError} When `state.context` is undefined.
 */
const ontologyEmitTask: TaskFnInterface<PipelineStateInterface> = async (
  next:  NextFnInterface,
  state: PipelineStateInterface,
): Promise<void> => {
  logger.debug('execute', 'ontology:emit task invoked', { targetId: state.targetId });

  const ctx = state.context;
  if (ctx === undefined) {
    throw ExternalSchemaError.create('ontology:emit requires state.context to be set by the orchestrator', {
      metadata: { task: TASK_NAME },
    });
  }

  // No-op when the json-tology engine is not active for this target.
  if (ctx.jt === undefined) {
    logger.debug('skip', 'No jt instance; ontology:emit is a no-op', { targetId: state.targetId });
    await next();
    return;
  }

  const ontologyConfig = ctx.config['ontology'] as Record<string, unknown> | undefined;
  const emitConfig     = ontologyConfig?.['emit'] as Record<string, unknown> | undefined;
  const tboxRel        = emitConfig?.['tbox']  as string | undefined;
  const shaclRel       = emitConfig?.['shacl'] as string | undefined;

  if (tboxRel === undefined || shaclRel === undefined) {
    logger.warn('skip', 'ontology:emit: emit.tbox or emit.shacl not configured; skipping write', {
      targetId: state.targetId,
      tboxRel,
      shaclRel,
    });
    await next();
    return;
  }

  const tboxPath  = join(ctx.outDir, tboxRel);
  const shaclPath = join(ctx.outDir, shaclRel);

  // Resolve TBox and SHACL quads from the jt instance (lazy, cached internally).
  const [tboxQuads, shaclQuads] = await Promise.all([
    ctx.jt.tbox(),
    ctx.jt.shacl(),
  ]);

  // Use TriG to handle quads with named graphs (json-tology wraps TBox and
  // SHACL output in a named ontology graph).
  logger.debug('serialize', 'Serializing TBox', {
    targetId:  state.targetId,
    path:      tboxPath,
    quadCount: tboxQuads.length,
  });

  const { data: tboxTurtle }  = await Serializer.serialize([...tboxQuads],  { format: 'trig' });

  logger.debug('serialize', 'Serializing SHACL shapes', {
    targetId:  state.targetId,
    path:      shaclPath,
    quadCount: shaclQuads.length,
  });

  const { data: shaclTurtle } = await Serializer.serialize([...shaclQuads], { format: 'trig' });

  // Write TBox and SHACL files, creating parent directories as needed.
  await mkdir(dirname(tboxPath),  { recursive: true });
  await mkdir(dirname(shaclPath), { recursive: true });
  await writeFile(tboxPath,  tboxTurtle,  'utf8');
  await writeFile(shaclPath, shaclTurtle, 'utf8');

  logger.info('write', 'ontology:emit wrote TBox and SHACL files', {
    targetId:    state.targetId,
    tboxPath,
    shaclPath,
    tboxQuads:   tboxQuads.length,
    shaclQuads:  shaclQuads.length,
  });

  await next();
};

TaskRegistry.register(TASK_NAME, ontologyEmitTask);
