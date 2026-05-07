/**
 * @fileoverview Built-in `json:read` task for the Squashage pipeline.
 *
 * @remarks
 * Reads a single input JSON or JSONL record identified by the
 * orchestrator-supplied `state.context.config.recordPath` (and optionally
 * `state.context.config.recordLine` for JSONL). Populates `state.input` from
 * the parsed record. On any parse failure, missing file, or non-object record,
 * writes a quarantine record under `projection/` via {@link QuarantineWriter}
 * and short-circuits without calling `next`.
 *
 * The task self-registers under the name `json:read` at module load time; no
 * explicit registration call is required by the caller — a side-effect import
 * of this file is sufficient.
 *
 * @module
 * @since 2.1.0
 * @category Tasks
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import type { NextFnInterface, TaskFnInterface } from '../types/Pipeline.js';
import type { PipelineStateInterface, InputSourceInterface } from '../types/PipelineState.js';
import { TaskRegistry } from '../registry/TaskRegistry.js';
import { QuarantineWriter } from '../quarantine/QuarantineWriter.js';
import { Logger } from '../modules/logger/logger.js';
import { ExternalSchemaError } from '../errors/ExternalSchemaError.js';

const logger = Logger.forComponent('jsonRead');

/** Name under which `json:read` is registered in the {@link TaskRegistry}. */
export const TASK_NAME = 'json:read' as const;

/**
 * Replaces `state.input` on a {@link PipelineStateInterface} despite the field being readonly.
 *
 * @param state - Mutable pipeline state reference.
 * @param input - Replacement record object.
 */
const replaceInput = (state: PipelineStateInterface, input: Readonly<Record<string, unknown>>): void => {
  (state as unknown as { input: Readonly<Record<string, unknown>> }).input = input;
};

/**
 * Computes the SHA-1 id for a quarantine record from the source path and
 * record line index.
 *
 * @param sourcePath - Filesystem path of the originating file.
 * @param recordLine - 0-based line index within the file (0 for single-file JSON).
 * @returns Hex-encoded SHA-1 digest.
 */
const computeQuarantineId = (sourcePath: string, recordLine: number): string =>
  createHash('sha1').update(`${sourcePath}#${recordLine}`).digest('hex');

/**
 * Reads the file at `recordPath` and returns its raw text content.
 *
 * @param recordPath - Absolute path to the JSON or JSONL file.
 * @returns Raw UTF-8 file content.
 * @throws {ExternalSchemaError} When the file cannot be read (e.g. ENOENT).
 */
const readRecordFile = async (recordPath: string): Promise<string> => {
  try {
    return await readFile(recordPath, 'utf8');
  } catch (err) {
    throw ExternalSchemaError.create(`json:read: cannot read file: ${recordPath}`, {
      cause: err instanceof Error ? err : undefined,
      metadata: { recordPath },
    });
  }
};

/**
 * Extracts a single record from raw file content.
 *
 * @remarks
 * For JSONL files (`recordLine >= 0` on a multi-line file), selects the
 * line at index `recordLine`. For plain JSON files (single record), the entire
 * content is parsed as one record.
 *
 * @param rawText - Raw UTF-8 content of the file.
 * @param recordLine - 0-based line index; `0` for single-JSON-file reads.
 * @returns Parsed JSON value.
 * @throws {SyntaxError} When the extracted text is not valid JSON.
 */
const extractRecord = (rawText: string, recordLine: number): unknown => {
  // Prefer whole-document parse: handles single-object JSON whether compact or
  // pretty-printed. This path succeeds for any `.json` file regardless of
  // indentation. Falls back to JSONL-line extraction when the whole-document
  // parse fails (e.g. a two-record JSONL file where line 0 is requested).
  if (recordLine === 0) {
    try {
      return JSON.parse(rawText.trim());
    } catch {
      // Fall through to JSONL line extraction below.
    }
  }
  const lines = rawText.split('\n').filter((l) => l.trim().length > 0);
  return JSON.parse(lines[recordLine] ?? '');
};

/**
 * Validates that a parsed JSON value is a non-null plain object.
 *
 * @param value - Parsed JSON value to check.
 * @returns `true` when value is a non-null, non-array object.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Writes a projection quarantine record and logs the failure.
 *
 * @param state     - Current pipeline state (provides target, source, input, classification).
 * @param outDir    - Output base directory from `state.context.outDir`.
 * @param id        - Pre-computed SHA-1 quarantine id.
 * @param errorName - Name of the triggering error or reason string.
 * @param message   - Human-readable failure message.
 * @param stack     - Optional error stack trace.
 */
const quarantine = async (
  state:     PipelineStateInterface,
  outDir:    string,
  id:        string,
  errorName: string,
  message:   string,
  stack?:    string,
): Promise<void> => {
  logger.warn('quarantine', `Quarantining record: ${message}`, {
    targetId: state.targetId,
    id,
    error: errorName,
  });

  const qw = QuarantineWriter.forRun(outDir, state.targetId);
  await qw.write({
    id,
    target:         state.targetId,
    bucket:         'projection',
    source:         state.source,
    input:          isPlainObject(state.input) ? state.input : null,
    classification: state.classification,
    error:          stack !== undefined ? { name: errorName, message, stack } : { name: errorName, message },
    timestamp:      new Date().toISOString(),
  });
};

/**
 * Pipeline task function for `json:read`.
 *
 * @remarks
 * Reads the record identified by `state.context.config.recordPath` (required)
 * and `state.context.config.recordLine` (optional; 0-based, defaults to `0`).
 * On success, populates `state.input` and calls `await next()`.
 * On any failure (missing file, malformed JSON, non-object record), writes a
 * quarantine record to `projection/` and returns without calling `next`.
 *
 * If `state.input` is already non-empty and `recordPath` is absent, the task
 * acts as a pass-through and calls `next()` directly — supporting orchestrators
 * that pre-populate `state.input` before pipeline execution.
 *
 * @param next  - Advance function that chains to the next task.
 * @param state - Mutable pipeline state for this record.
 */
const jsonReadTask: TaskFnInterface<PipelineStateInterface> = async (
  next:  NextFnInterface,
  state: PipelineStateInterface,
): Promise<void> => {
  logger.debug('execute', 'json:read task invoked', { targetId: state.targetId });

  const ctx = state.context;
  if (ctx === undefined) {
    throw ExternalSchemaError.create('json:read requires state.context to be set by the orchestrator', {
      metadata: { task: TASK_NAME },
    });
  }

  const recordPath = ctx.config['recordPath'];
  const recordLine = typeof ctx.config['recordLine'] === 'number' ? ctx.config['recordLine'] : 0;

  // Pass-through: orchestrator pre-populated state.input and supplied no recordPath.
  if (recordPath === undefined && Object.keys(state.input).length > 0) {
    logger.debug('execute', 'state.input already populated; passing through', { targetId: state.targetId });
    await next();
    return;
  }

  if (typeof recordPath !== 'string' || recordPath.length === 0) {
    throw ExternalSchemaError.create('json:read requires context.config.recordPath to be a non-empty string', {
      metadata: { task: TASK_NAME, received: typeof recordPath },
    });
  }

  const quarantineId = computeQuarantineId(recordPath, recordLine);

  // Read the file.
  let rawText: string;
  try {
    rawText = await readRecordFile(recordPath);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    await quarantine(state, ctx.outDir, quarantineId, e.name, e.message, e.stack);
    return;
  }

  // Parse the record.
  logger.debug('parse', 'Parsing record from file', { recordPath, recordLine });

  let parsed: unknown;
  try {
    parsed = extractRecord(rawText, recordLine);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    await quarantine(
      state, ctx.outDir, quarantineId,
      e.name,
      `json:read: malformed JSON at ${recordPath}:${recordLine.toString()} — ${e.message}`,
      e.stack,
    );
    return;
  }

  // Validate that the record is a plain object.
  if (!isPlainObject(parsed)) {
    await quarantine(
      state, ctx.outDir, quarantineId,
      'TypeError',
      'json:read: record is not an object',
    );
    return;
  }

  // Validate _source.target matches state.source.target when both present.
  const embedded = parsed['_source'];
  if (
    isPlainObject(embedded) &&
    typeof embedded['target'] === 'string' &&
    embedded['target'] !== state.source.target
  ) {
    await quarantine(
      state, ctx.outDir, quarantineId,
      'TargetMismatchError',
      `json:read: _source.target "${embedded['target']}" does not match state.source.target "${state.source.target}"`,
    );
    return;
  }

  // Merge _source fields into source (plugin, schemaId from _source if present).
  if (isPlainObject(embedded)) {
    const mergedSource: InputSourceInterface = {
      target:   state.source.target,
      path:     state.source.path,
      plugin:   typeof embedded['plugin']   === 'string' ? embedded['plugin']   : state.source.plugin,
      schemaId: typeof embedded['schemaId'] === 'string' ? embedded['schemaId'] : state.source.schemaId,
    };
    (state as unknown as { source: InputSourceInterface }).source = mergedSource;
  }

  // Populate state.input.
  replaceInput(state, parsed);

  logger.info('execute', 'Record loaded and input populated', {
    targetId:   state.targetId,
    recordPath,
    recordLine,
  });

  await next();
};

TaskRegistry.register(TASK_NAME, jsonReadTask);
