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

import type { Quad, NamedNode }                  from '@rdfjs/types';
import type { NextFnInterface, TaskFnInterface } from '../types/Pipeline.js';
import type { PipelineStateInterface }           from '../types/PipelineState.js';
import { TaskRegistry }    from '../registry/TaskRegistry.js';
import { Logger }          from '../modules/logger/logger.js';
import { ExternalSchemaError } from '../errors/ExternalSchemaError.js';
import { RDF, XSD, PROV } from '../rdf/Vocab.js';
import { RdfStar }         from '../rdf/RdfStar.js';

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
  readonly encoding: 'named-graph' | 'rdf-star';
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
  const encodingRaw = cfg['encoding'];
  const encoding: 'named-graph' | 'rdf-star' =
    encodingRaw === 'rdf-star' ? 'rdf-star' : 'named-graph';
  return {
    enabled: true,
    graph:   typeof cfg['graph'] === 'string' ? cfg['graph'] : undefined,
    include,
    encoding,
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
// RDF-star helper
// ---------------------------------------------------------------------------

/**
 * Emits provenance quads using RDF-star quoted triples.
 *
 * @remarks
 * Instead of a sidecar named graph, provenance metadata is attached directly
 * to the winning `rdf:type` assertion via a quoted triple as the subject.
 *
 * For each record, the task:
 * 1. Finds the `rdf:type` quad for the record subject in `state.context.dataset`.
 * 2. Constructs a quoted triple: `<< subject rdf:type classIri >>`.
 * 3. Emits provenance quads where the SUBJECT is that quoted triple:
 *    `<< subject rdf:type class >> prov:wasGeneratedBy <classifier:engine> .`
 *
 * All quoted-triple provenance quads land in the default graph (no named graph
 * is required; the quoted triple itself carries the context).
 *
 * @internal
 */
const emitQuotedTripleProvenance = (
  state:   PipelineStateInterface,
  cfg:     ProvenanceConfigInterface,
): void => {
  const ctx     = state.context!;
  const factory = ctx.factory;
  const dataset = ctx.dataset;
  const runBase = ctx.prefixes.instances.base;

  // Collect all rdf:type quads in the dataset whose subjects are NamedNodes
  // from the instances namespace. The shared dataset accumulates quads from
  // all records processed so far. We identify the CURRENT record's rdf:type
  // quad by finding type quads that do NOT yet have provenance quoted-triple
  // quads attached to them (i.e., the quoted-triple form of that type quad is
  // not yet a subject of any quad in the dataset).
  //
  // This approach works correctly for sequential pipeline execution (the default)
  // because output:provenance fires immediately after the squash task for each
  // record, before the next record begins.
  const RDF_TYPE_IRI = RDF_type.value;

  // Build the set of quoted-triple keys that already have provenance attached.
  // A quoted triple is "already provenance-stamped" when at least one quad exists
  // with that quoted triple as its subject.
  const stampedSubjectKeys = new Set<string>();
  for (const q of dataset) {
    if (q.subject.termType === 'Quad') {
      const inner = q.subject as Quad;
      stampedSubjectKeys.add(`${inner.subject.value}|${inner.predicate.value}|${inner.object.value}`);
    }
  }

  // Find the first rdf:type quad whose subject is an instances-namespace NamedNode
  // and that is NOT yet quoted in any provenance quad.
  let typeQuad: Quad | undefined;
  for (const q of dataset) {
    if (
      q.predicate.value === RDF_TYPE_IRI
      && q.subject.termType === 'NamedNode'
      && q.object.termType === 'NamedNode'
      && q.subject.value.startsWith(runBase)
    ) {
      const key = `${q.subject.value}|${RDF_TYPE_IRI}|${q.object.value}`;
      if (!stampedSubjectKeys.has(key)) {
        typeQuad = q as Quad;
        break;
      }
    }
  }

  if (typeQuad === undefined) {
    logger.warn('emitQuotedTripleProvenance', 'No un-stamped rdf:type quad found in dataset; skipping RDF-star provenance', {
      targetId: state.targetId,
      runBase,
    });
    return;
  }

  // Construct the quoted triple from the rdf:type quad's subject and object.
  // The subject and object are guaranteed NamedNodes by the filter above and by
  // Squashage's own quad-emission convention (class IRIs are always NamedNodes).
  const quotedSubject = typeQuad.subject as NamedNode;
  const quotedObject  = typeQuad.object  as NamedNode;
  const quoted        = RdfStar.quoteQuad(quotedSubject, RDF_type, quotedObject);

  // Emit prov:wasGeneratedBy when classification is present and classifier is included.
  if (cfg.include.includes('classifier') && state.classification !== null) {
    const engineName = state.classification.engine;
    const engineNode = factory.namedNode(`${runBase}classifier/${engineName}`);
    dataset.add(factory.quad(quoted, PROV_wasGeneratedBy, engineNode));
  }

  // Emit prov:value (confidence) when included.
  if (cfg.include.includes('confidence') && state.classification !== null) {
    const confidence  = state.classification.confidence ?? 1.0;
    const confLiteral = factory.literal(confidence.toString(), XSD_decimal);
    dataset.add(factory.quad(quoted, PROV_value, confLiteral));
  }

  // Emit prov:atTime using the frozen run-start time when included.
  if (cfg.include.includes('timestamp')) {
    const timestamp   = ctx.runStartTime ?? new Date().toISOString();
    const timeLiteral = factory.literal(timestamp, XSD_dateTime);
    dataset.add(factory.quad(quoted, PROV_atTime, timeLiteral));
  }

  // Emit prov:reason (comma-joined reasons) when classification is present and included.
  if (cfg.include.includes('reasons') && state.classification !== null) {
    const reasons       = state.classification.reasons.join(',');
    const reasonLiteral = factory.literal(reasons);
    dataset.add(factory.quad(quoted, PROV_reason, reasonLiteral));
  }

  logger.info('emitQuotedTripleProvenance', 'RDF-star provenance quads emitted', {
    targetId: state.targetId,
    include:  [...cfg.include],
    quotedSubject: quotedSubject.value,
    quotedObject:  quotedObject.value,
  });
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

  if (cfg.encoding === 'rdf-star') {
    // RDF-star mode: emit quoted-triple-subject provenance quads.
    emitQuotedTripleProvenance(state, cfg);
  } else {
    // Named-graph mode (default): emit PROV-O sidecar quads into a dedicated named graph.

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
      const confidence  = state.classification.confidence ?? 1.0;
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
      const reasons       = state.classification.reasons.join(',');
      const reasonLiteral = factory.literal(reasons);
      dataset.add(factory.quad(subject, PROV_reason, reasonLiteral, provGraph));
    }

    logger.info('execute', 'output:provenance quads emitted', {
      targetId:  state.targetId,
      subjectIri,
      graphIri,
      include:   [...cfg.include],
    });
  }

  await next();
};

TaskRegistry.register(TASK_NAME, provenanceEmitTask);
