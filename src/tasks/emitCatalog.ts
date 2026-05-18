/**
 * @fileoverview Built-in `catalog:emit` task for the Squashage pipeline.
 *
 * @remarks
 * Generates an OASIS XML Catalog 1.1 file from the output report produced by
 * `rdfjs:finalize` or `rdfjs:stream`. The catalog is only emitted when
 * `output.catalog.enabled === true` AND `output.bucketing.enabled === true`
 * (schema cross-validation enforces this pairing; the task also guards at
 * runtime).
 *
 * The catalog filename defaults to `<targetId>.catalog.xml` (e.g.
 * `aonprd.catalog.xml`) and is written atomically to the bucket directory
 * (`output.path` when bucketing is on). Override via `output.catalog.filename`.
 *
 * Entry assembly:
 * - One `<uri>` per non-null, non-quarantine bucket in the output report.
 * - Optional `<uri name="<defaultGraphCatalogIri>">` when
 *   `bucketing.defaultGraphCatalogIri` is set and a default-graph bucket exists.
 * - Optional `<rewriteURI>` entries from `catalog.rewriteRoots`.
 *
 * The task self-registers under the name `catalog:emit` at module load time;
 * a side-effect import of this file is sufficient.
 *
 * @module tasks/emitCatalog
 * @since 0.7.0
 * @category Tasks
 */

import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { join, relative }                 from 'node:path';

import type { NextFnInterface, TaskFnInterface } from '../types/Pipeline.js';
import type { PipelineStateInterface }           from '../types/PipelineState.js';
import type { BucketReportInterface }            from '../output/Bucketer.js';

import { TaskRegistry }      from '../registry/TaskRegistry.js';
import { Logger }            from '../modules/logger/logger.js';
import { ExternalSchemaError } from '../errors/ExternalSchemaError.js';
import { OasisCatalog }      from '../output/OasisCatalog.js';
import type { CatalogEntryInterface } from '../output/OasisCatalog.js';
import { OutputReport, OUTPUT_REPORT_FILENAME } from '../output/OutputReport.js';
import { readFile }                  from 'node:fs/promises';

const logger = Logger.forComponent('emitCatalog');

/** Name under which `catalog:emit` is registered in the {@link TaskRegistry}. */
export const TASK_NAME = 'catalog:emit' as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Atomically writes data to `destPath` using a `.tmp` → rename pattern.
 */
async function atomicWrite(data: string, destPath: string): Promise<void> {
  const tmpPath     = `${destPath}.tmp`;
  const partialPath = `${destPath}.partial`;

  await writeFile(tmpPath, data, 'utf8');

  try {
    const fh = await open(tmpPath, 'r+');
    await fh.sync();
    await fh.close();
  } catch {
    // fsync best-effort
  }

  try {
    await rename(tmpPath, destPath);
  } catch (err) {
    try { await rename(tmpPath, partialPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Converts an absolute path to a relative path from a directory, using
 * forward slashes (required by OASIS XML Catalogs).
 */
function toRelativeUri(fromDir: string, absPath: string): string {
  const rel = relative(fromDir, absPath);
  // Normalize to forward slashes
  return `./${rel.replace(/\\/g, '/')}`;
}

// ---------------------------------------------------------------------------
// catalog:emit task
// ---------------------------------------------------------------------------

/**
 * Pipeline task function for `catalog:emit`.
 *
 * @remarks
 * Reads the `output.report.json` written by `rdfjs:finalize` or
 * `rdfjs:stream`, assembles catalog entries from the bucket list, and writes
 * the OASIS XML Catalog file to the bucket directory.
 *
 * @param next  - Advance function supplied by the orchestrator.
 * @param state - Synthetic pipeline state carrying the run-wide context.
 * @throws {ExternalSchemaError} When `state.context` is undefined.
 */
const emitCatalogTask: TaskFnInterface<PipelineStateInterface> = async (
  next:  NextFnInterface,
  state: PipelineStateInterface,
): Promise<void> => {
  logger.debug('execute', 'catalog:emit task invoked', { targetId: state.targetId });

  const ctx = state.context;
  if (ctx === undefined) {
    throw ExternalSchemaError.create('catalog:emit requires state.context to be set by the orchestrator', {
      metadata: { task: TASK_NAME },
    });
  }

  const output     = ctx.output as Record<string, unknown>;
  const catalogCfg = output['catalog'] as Record<string, unknown> | undefined;
  const bucketingCfg = output['bucketing'] as Record<string, unknown> | undefined;

  // Guard: only emit when catalog.enabled=true
  if (catalogCfg?.['enabled'] !== true) {
    logger.debug('execute', 'catalog.enabled is not true — skipping catalog:emit', { targetId: state.targetId });
    await next();
    return;
  }

  // Guard: catalog is only valid with bucketing on
  if (bucketingCfg?.['enabled'] !== true) {
    logger.warn('execute', 'catalog.enabled=true but bucketing.enabled is not true — skipping catalog:emit', {
      targetId: state.targetId,
    });
    await next();
    return;
  }

  // Read the output report from disk (written by rdfjs:finalize / rdfjs:stream)
  const runDir     = join(ctx.outDir, ctx.target);
  const reportPath = join(runDir, OUTPUT_REPORT_FILENAME);

  let report: Awaited<ReturnType<typeof OutputReport.fromJson>>;
  try {
    const reportText = await readFile(reportPath, 'utf8');
    report = OutputReport.fromJson(reportText);
  } catch (err) {
    logger.error('execute', 'Failed to read output report — skipping catalog:emit', {
      targetId:   state.targetId,
      reportPath,
      error:      err instanceof Error ? err.message : String(err),
    });
    await next();
    return;
  }

  const bucketDir = report.path; // bucket root directory when bucketing on

  // Determine catalog filename
  const defaultFilename = `${ctx.target}.catalog.xml`;
  const catalogFilename = typeof catalogCfg['filename'] === 'string'
    ? catalogCfg['filename']
    : defaultFilename;
  const catalogPath = join(bucketDir, catalogFilename);

  // Ensure bucket directory exists
  await mkdir(bucketDir, { recursive: true });

  // Assemble catalog entries
  const entries: CatalogEntryInterface[] = [];

  // Named-graph <uri> entries from buckets
  const buckets = report.buckets ?? [];
  const defaultGraphCatalogIri = typeof bucketingCfg['defaultGraphCatalogIri'] === 'string'
    ? bucketingCfg['defaultGraphCatalogIri']
    : undefined;

  for (const bucket of buckets as BucketReportInterface[]) {
    // Skip empty buckets (null path)
    if (bucket.path === null) continue;

    if (bucket.bucketKey === '__default__') {
      // Default graph: only add if defaultGraphCatalogIri is set
      if (defaultGraphCatalogIri !== undefined) {
        entries.push({
          kind: 'uri',
          name: defaultGraphCatalogIri,
          uri:  toRelativeUri(bucketDir, bucket.path),
        });
      }
      continue;
    }

    if (bucket.bucketKey === '__other__') {
      // Overflow bucket: no IRI to index
      continue;
    }

    // Named-graph bucket
    if (bucket.graphIri !== null) {
      entries.push({
        kind: 'uri',
        name: bucket.graphIri,
        uri:  toRelativeUri(bucketDir, bucket.path),
      });
    }
  }

  // Optional <rewriteURI> entries from catalog.rewriteRoots
  const rewriteRoots = catalogCfg['rewriteRoots'];
  if (Array.isArray(rewriteRoots)) {
    for (const root of rewriteRoots as Array<{ uriStartString: string; rewritePrefix: string }>) {
      if (typeof root.uriStartString === 'string' && typeof root.rewritePrefix === 'string') {
        entries.push({
          kind:           'rewriteURI',
          uriStartString: root.uriStartString,
          rewritePrefix:  root.rewritePrefix,
        });
      }
    }
  }

  // Build and write the catalog
  const prefer = catalogCfg['prefer'] === 'system' ? 'system' as const : 'public' as const;
  const xml = OasisCatalog.build(entries, { prefer });

  await atomicWrite(xml, catalogPath);

  logger.info('execute', 'OASIS catalog written', {
    targetId:      state.targetId,
    catalogPath,
    entryCount:    entries.length,
    bucketCount:   buckets.length,
  });

  await next();
};

TaskRegistry.register(TASK_NAME, emitCatalogTask);

// ---------------------------------------------------------------------------
// Named export for tests
// ---------------------------------------------------------------------------

export const CATALOG_TASK_NAME = TASK_NAME;
