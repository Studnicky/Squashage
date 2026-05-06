/**
 * @fileoverview Built-in `output:provenance` task for the Squashage pipeline.
 *
 * @remarks
 * Emits PROV-O metadata quads into a dedicated sidecar named graph for the
 * current record. The task is a no-op when
 * `targets.<id>.output.provenance.enabled !== true`.
 *
 * When enabled, the task emits the following quads into the configured named
 * graph (keyed by `output.provenance.graph`):
 *
 * ```
 * <run/{recordId}> rdf:type prov:Activity .
 * <run/{recordId}> prov:wasGeneratedBy <classifier:{engineName}> .
 * <run/{recordId}> prov:value "0.95"^^xsd:decimal .
 * <run/{recordId}> prov:atTime "2026-05-06T..."^^xsd:dateTime .
 * <run/{recordId}> prov:reason "source.target=aonprd,..." .
 * ```
 *
 * The `include` array in the provenance config controls which metadata
 * categories are emitted. All four are included by default:
 * `["classifier", "confidence", "reasons", "timestamp"]`.
 *
 * The timestamp is the run's frozen start time (`state.context.runStartTime`),
 * not `new Date()` per record, ensuring deterministic output across replays.
 *
 * The task is registered under the name `output:provenance` at module load
 * time. Include it in a target's `pipeline` array after `squash:*`/plugin
 * emit tasks and before `rdfjs:finalize`.
 *
 * @module
 * @since 0.5.0
 * @category Tasks
 */

import { createHash } from 'node:crypto';

import type { NextFnInterface, TaskFnInterface } from '../types/Pipeline.js';
import type { PipelineStateInterface }           from '../types/PipelineState.js';
import { TaskRegistry }    from '../registry/TaskRegistry.js';
import { Logger }          from '../modules/logger/logger.js';
import { ExternalSchemaError } from '../errors/ExternalSchemaError.js';
import { RDF, XSD, PROV } from '../rdf/Vocab.js';

// Pre-declare vocabulary terms via the callable form of NamespaceBuilder so that
// noUncheckedIndexedAccess does not widen to `NamedNode | undefined`.
const PROV_Activity        = PROV('Activity');
const PROV_wasGeneratedBy  = PROV('wasGeneratedBy');
const PROV_value           = PROV('value');
const PROV_atTime          = PROV('atTime');
const PROV_reason          = PROV('reason');
const RDF_type             = RDF('type');
const XSD_decimal          = XSD('decimal');
const XSD_dateTime         = XSD('dateTime');

const logger = Logger.forComponent('provenanceEmit');

/** Name under which `output:provenance` is registered in the {@link TaskRegistry}. */
export const TASK_NAME = 'output:provenance' as const;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Parsed provenance config from `targets.<id>.output.provenance`.
 *
 * @internal
 */
interface ProvenanceConfigInterface {
  readonly enabled: boolean;
  readonly graph?: string | undefined;
  readonly include: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default metadata categories emitted when `include` is absent. */
const DEFAULT_INCLUDE: ReadonlyArray<string> = ['classifier', 'confidence', 'reasons', 'timestamp'];

/**
 * Resolves the provenance config from the context output config.
 * Returns `null` when provenance is not enabled.
 *
 * @internal
 */
const resolveProvenanceConfig = (ctx: PipelineStateInterface['context']): ProvenanceConfigInterface | null => {
  if (ctx === undefined) return null;
  const outputCfg = ctx.output as unknown as Record<string, unknown>;
  const raw = outputCfg['provenance'];
  if (raw === null || typeof raw !== 'object') return null;
  const cfg = raw as Record<string, unknown>;
  if (cfg['enabled'] !== true) return null;
  const includeRaw = cfg['include'];
  const include: ReadonlyArray<string> = Array.isArray(includeRaw)
    ? (includeRaw as string[])
    : DEFAULT_INCLUDE;
  return {
    enabled: true,
    graph:   typeof cfg['graph'] === 'string' ? cfg['graph'] : undefined,
    include,
  };
};

/**
 * Derives a stable record-subject IRI from the record's source path.
 *
 * Uses a SHA-1 of the record path (truncated to 8 hex chars) to ensure
 * the IRI is stable across runs while remaining short. The `runBase`
 * provides the namespace.
 *
 * @internal
 */
const deriveRecordIri = (runBase: string, recordPath: string, recordLine: number): string => {
  const key  = `${recordPath}:${recordLine.toString()}`;
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 8);
  const base = runBase.endsWith('/') ? runBase : `${runBase}/`;
  return `${base}run/${hash}`;
};

/**
 * Resolves the provenance named-graph IRI from the config.
 *
 * When `cfg.graph` is a full IRI (starts with `http://` or `https://`),
 * it is used as-is. Otherwise it is treated as a suffix appended to `runBase`.
 *
 * @internal
 */
const resolveGraphIri = (runBase: string, cfg: ProvenanceConfigInterface): string => {
  const suffix = cfg.graph;
  if (suffix === undefined || suffix.length === 0) {
    const base = runBase.endsWith('/') ? runBase : `${runBase}/`;
    return `${base}provenance`;
  }
  if (suffix.startsWith('http://') || suffix.startsWith('https://')) {
    return suffix;
  }
  const base = runBase.endsWith('/') ? runBase : `${runBase}/`;
  return `${base}${suffix}`;
};

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/**
 * Pipeline task function for `output:provenance`.
 *
 * @remarks
 * Emits PROV-O metadata quads into a sidecar named graph. The task is a no-op
 * when provenance is not enabled in the output config. Quads land in
 * `state.context.dataset` under the configured provenance graph IRI.
 *
 * @param next  - Advance function; called after emit (or on no-op).
 * @param state - Per-record pipeline state; `context` must be set.
 * @throws {ExternalSchemaError} When `state.context` is undefined.
 */
const provenanceEmitTask: TaskFnInterface<PipelineStateInterface> = async (
  next:  NextFnInterface,
  state: PipelineStateInterface,
): Promise<void> => {
  logger.debug('execute', 'output:provenance task invoked', { targetId: state.targetId });

  const ctx = state.context;
  if (ctx === undefined) {
    throw ExternalSchemaError.create('output:provenance requires state.context to be set by the orchestrator', {
      metadata: { task: TASK_NAME },
    });
  }

  // Resolve provenance config; no-op when disabled.
  const cfg = resolveProvenanceConfig(ctx);
  if (cfg === null) {
    logger.debug('skip', 'Provenance not enabled; output:provenance is a no-op', { targetId: state.targetId });
    await next();
    return;
  }

  // Determine record locator from context config (populated by orchestrator per-record).
  const recordPath = typeof ctx.config['recordPath'] === 'string' ? ctx.config['recordPath'] : state.source.path;
  const recordLine = typeof ctx.config['recordLine'] === 'number' ? ctx.config['recordLine'] : 0;

  // Derive run base from the instances prefix (deterministic, from PrefixResolver).
  const runBase = ctx.prefixes.instances.base;

  // Derive record subject IRI and provenance graph IRI.
  const subjectIri  = deriveRecordIri(runBase, recordPath, recordLine);
  const graphIri    = resolveGraphIri(runBase, cfg);

  const factory     = ctx.factory;
  const dataset     = ctx.dataset;
  const subject     = factory.namedNode(subjectIri);
  const provGraph   = factory.namedNode(graphIri);

  // Always emit rdf:type prov:Activity.
  dataset.add(factory.quad(subject, RDF_type, PROV_Activity, provGraph));

  // Emit prov:wasGeneratedBy when classification is present and classifier is included.
  if (cfg.include.includes('classifier') && state.classification !== null) {
    const engineName = state.classification.engine;
    const engineNode = factory.namedNode(`${runBase}classifier/${engineName}`);
    dataset.add(factory.quad(subject, PROV_wasGeneratedBy, engineNode, provGraph));
  }

  // Emit prov:value (confidence) when included.
  if (cfg.include.includes('confidence') && state.classification !== null) {
    const confidence = state.classification.confidence ?? 1.0;
    const confLiteral = factory.literal(confidence.toString(), XSD_decimal);
    dataset.add(factory.quad(subject, PROV_value, confLiteral, provGraph));
  }

  // Emit prov:atTime using the frozen run-start time when included.
  if (cfg.include.includes('timestamp')) {
    const timestamp   = ctx.runStartTime ?? new Date().toISOString();
    const timeLiteral = factory.literal(timestamp, XSD_dateTime);
    dataset.add(factory.quad(subject, PROV_atTime, timeLiteral, provGraph));
  }

  // Emit prov:reason (comma-joined reasons) when classification is present and included.
  if (cfg.include.includes('reasons') && state.classification !== null) {
    const reasons        = state.classification.reasons.join(',');
    const reasonLiteral  = factory.literal(reasons);
    dataset.add(factory.quad(subject, PROV_reason, reasonLiteral, provGraph));
  }

  logger.info('execute', 'output:provenance quads emitted', {
    targetId:  state.targetId,
    subjectIri,
    graphIri,
    include:   [...cfg.include],
  });

  await next();
};

TaskRegistry.register(TASK_NAME, provenanceEmitTask);
