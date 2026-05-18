/**
 * @fileoverview Built-in `rdfjs:finalize` task for the Squashage pipeline.
 *
 * @remarks
 * Serializes the canonical {@link DatasetCore} on `state.context.dataset` to the
 * configured output file via {@link FileOutput}, then writes the resulting
 * {@link OutputReportInterface} to `<outDir>/<target>/output.report.json`. Runs
 * **once per target run**, NOT per record — the orchestrator strips this task
 * from the per-record `pipeline: [...]` queue and invokes it directly with a
 * synthetic state carrying the run-wide {@link PipelineContextInterface} after
 * the final per-record batch settles. See plan 13 §"Pipeline Lifecycle:
 * Orchestrator-Driven Finalize".
 *
 * Format/named-graph compatibility is checked before instantiating the output:
 * if the target emits non-default-graph quads and the resolved {@link RDFFormat}
 * is triple-only (turtle, ntriples) without `output.graph` set to collapse,
 * the task throws {@link OutputConfigError} with `metadata.stage = 'finalize'`.
 *
 * When `output.format === 'jsonld'`, a compaction context is resolved via
 * {@link FileOutput}'s built-in priority order (inline object → auto-build from
 * quads + `ctx.prefixes` → path-based load).  The `configDir` is derived from
 * `ctx.config.configPath` when present (set by the CLI via {@link RunOptionsInterface}).
 *
 * The task self-registers under the name `rdfjs:finalize` at module load time;
 * a side-effect import of this file is sufficient.
 *
 * @module
 * @since 2.1.0
 * @category Tasks
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join }    from 'node:path';

import type { NextFnInterface, TaskFnInterface } from '../types/Pipeline.js';
import type { PipelineStateInterface } from '../types/PipelineState.js';
import { TaskRegistry } from '../registry/TaskRegistry.js';
import { Logger } from '../modules/logger/logger.js';
import { ExternalSchemaError } from '../errors/ExternalSchemaError.js';
import { OutputConfigError } from '../errors/OutputConfigError.js';
import { FileOutput } from '../output/FileOutput.js';
import { FormatResolver } from '../output/FormatResolver.js';
import { OutputReport, OUTPUT_REPORT_FILENAME } from '../output/OutputReport.js';
import { Formats } from '../rdf/Formats.js';

const logger = Logger.forComponent('rdfjsFinalize');

/** Name under which `rdfjs:finalize` is registered in the {@link TaskRegistry}. */
export const TASK_NAME = 'rdfjs:finalize' as const;

/**
 * Returns the per-target run directory under which the output report and
 * quarantine artifacts land: `<outDir>/<targetId>`.
 */
const runDirFor = (outDir: string, targetId: string): string => join(outDir, targetId);

/**
 * Asserts that the target's named-graph emissions are compatible with the
 * resolved output format. Triple-only formats (turtle, ntriples) cannot
 * serialize quads with non-default graphs unless `output.graph` is set OR
 * bucketing is enabled (each bucket contains exactly one graph).
 *
 * @throws {OutputConfigError} When named-graph quads exist but the format
 *   cannot represent them and neither `graph` nor `bucketing.enabled` is set.
 */
const assertGraphCompatibility = (
  dataset:          { [Symbol.iterator](): Iterator<{ graph: { termType: string } }> },
  format:           string,
  graph:            string | undefined,
  bucketingEnabled: boolean,
): void => {
  if (Formats.supportsQuads(format as Parameters<typeof Formats.supportsQuads>[0])) return;
  if (graph !== undefined && graph.length > 0) return;
  // When bucketing is on, each bucket file contains only one graph — triple-only
  // formats are valid per-bucket even without output.graph.
  if (bucketingEnabled) return;
  for (const quad of dataset) {
    if (quad.graph.termType !== 'DefaultGraph') {
      throw OutputConfigError.create(
        `Named-graph quads cannot be serialized to triple-only format "${format}" without \`output.graph\``,
        { metadata: { stage: 'finalize', format } },
      );
    }
  }
};

/**
 * Pipeline task function for `rdfjs:finalize`.
 *
 * @remarks
 * Drives the FileOutput lifecycle: resolves the format, validates named-graph
 * compatibility, opens a {@link FileOutput} rooted at `<outDir>/<target>`,
 * streams the canonical dataset into it, closes it to obtain the
 * {@link OutputReportInterface}, and persists the report JSON next to the
 * output file (under the run directory). Invokes `next()` on success.
 *
 * The `FileOutput` constructor receives `ctx.prefixes` and the config directory
 * (from `ctx.config.configPath` when set by the CLI) so JSON-LD context
 * auto-build and path resolution work correctly.
 *
 * @param next  - Advance function; supplied by the orchestrator (typically a no-op).
 * @param state - Synthetic pipeline state whose `context` carries the run-wide
 *   factory, dataset, builder, graphs, iri, output, target, outDir, and config.
 * @throws {ExternalSchemaError} When `state.context` is undefined.
 * @throws {OutputConfigError}   When format/graph compatibility fails.
 * @throws {FileOutputError}     When SHACL validation fails or atomic write fails.
 */
const rdfjsFinalizeTask: TaskFnInterface<PipelineStateInterface> = async (
  next:  NextFnInterface,
  state: PipelineStateInterface,
): Promise<void> => {
  logger.debug('execute', 'rdfjs:finalize task invoked', { targetId: state.targetId });

  const ctx = state.context;
  if (ctx === undefined) {
    throw ExternalSchemaError.create('rdfjs:finalize requires state.context to be set by the orchestrator', {
      metadata: { task: TASK_NAME },
    });
  }

  const format = FormatResolver.resolve(ctx.output);
  logger.debug('validate', 'Resolved output format', { format, path: ctx.output.path });

  const bucketingEnabled = (ctx.output as Record<string, unknown>)['bucketing'] !== undefined &&
    ((ctx.output as Record<string, unknown>)['bucketing'] as Record<string, unknown>)['enabled'] === true;

  assertGraphCompatibility(
    ctx.dataset as unknown as { [Symbol.iterator](): Iterator<{ graph: { termType: string } }> },
    format,
    ctx.output.graph,
    bucketingEnabled,
  );

  const runDir = runDirFor(ctx.outDir, ctx.target);

  // Derive configDir from ctx.config.configPath when it was threaded through by the CLI.
  const configPathRaw = ctx.config['configPath'];
  const configDir = typeof configPathRaw === 'string'
    ? dirname(configPathRaw)
    : undefined;

  const output = new FileOutput(ctx.output, runDir, ctx.prefixes, configDir);

  logger.debug('serialize', 'Opening output and writing dataset', {
    targetId:  state.targetId,
    path:      ctx.output.path,
    quadCount: ctx.dataset.size,
  });

  await output.open();
  await output.writeBatch(ctx.dataset);
  const report = await output.close();

  // Persist the output report JSON under the run directory.
  const reportPath = join(runDir, OUTPUT_REPORT_FILENAME);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, OutputReport.toJson(report), 'utf8');

  logger.info('finalize', 'Output written and report persisted', {
    targetId:     state.targetId,
    path:         report.path,
    reportPath,
    quadCount:    report.quadCount,
    graphCount:   report.graphCount,
    bytesWritten: report.bytesWritten,
    durationMs:   report.durationMs,
  });

  await next();
};

TaskRegistry.register(TASK_NAME, rdfjsFinalizeTask);
