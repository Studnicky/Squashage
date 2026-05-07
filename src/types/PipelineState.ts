import type { DataFactory, DatasetCore, NamedNode } from '@rdfjs/types';
import type { GraphBuilder }         from '../rdf/GraphBuilder.js';
import type { NamespaceBuilder }     from '../rdf/Namespaces.js';
import type { OutputConfigInterface } from '../config/OutputConfig.js';
import type { PrefixResolutionInterface } from '../classification/PrefixResolver.js';
import type { JsonTologyOntology }   from '../ontology/JsonTologyOntology.js';

/**
 * Source metadata for a single input JSON record flowing through the pipeline.
 *
 * @remarks
 * Populated by `json:read` from the file path the record was loaded from and
 * from the optional `_source` block embedded in the record itself. Tasks read
 * this to make classification reproducible and to attribute quarantine
 * records back to the record they came from.
 *
 * @category Pipeline
 * @since 2.1.0
 * @see {@link PipelineStateInterface}
 * @group Types
 */
export interface InputSourceInterface {
  /** Upstream target id this record came from (e.g. `"aonprd"`). */
  readonly target:    string;
  /** Filesystem path the record was loaded from, relative to the run's input root. */
  readonly path:      string;
  /** Upstream plugin that produced the record (e.g. `"aonprd:parse"`). */
  readonly plugin?:   string | undefined;
  /** Schema id the record was validated against upstream, if known. */
  readonly schemaId?: string | undefined;
}

/**
 * A classification proposal emitted by one classifier task; the conflict
 * resolver consumes the accumulated array on `state.classifications` to
 * pick the winning class for the record.
 *
 * @category Pipeline
 * @since 0.1.0
 * @see {@link PipelineStateInterface}
 * @group Types
 */
export interface ClassificationProposalInterface {
  /** Identifier of the task that emitted this proposal (e.g. 'classify:rules'). */
  readonly source:     string;
  /** Proposed ontology class id (or 'unknown' / '__validation__' for non-class proposals). */
  readonly className:  string;
  /** Numeric priority; ConflictResolver picks the highest. */
  readonly priority:   number;
  /** Confidence in [0,1]; deterministic classifiers always emit 1.0. */
  readonly confidence: number;
  /** Human-readable evidence reasons preserved verbatim into the final classification. */
  readonly reasons:    ReadonlyArray<string>;
}

/**
 * Result of the classification cascade for a single record.
 *
 * @remarks
 * Populated by `classify:*` tasks. Preserved verbatim into quarantine reports
 * when a downstream task quarantines the record.
 *
 * @category Pipeline
 * @since 2.1.0
 * @see {@link PipelineStateInterface}
 * @group Types
 */
export interface ClassificationEvidenceInterface {
  /** Final ontology class id (e.g. `"feat"`). */
  readonly type:        string;
  /** `0..1` confidence score from the cascade. */
  readonly confidence:  number;
  /** Cascade engine that produced the result (e.g. `"schema+rules"`). */
  readonly engine:      string;
  /** Human-readable evidence reasons in cascade order. */
  readonly reasons:     ReadonlyArray<string>;
  /** Other classes the cascade considered before settling. */
  readonly candidates?: ReadonlyArray<string> | undefined;
}

/**
 * Shared per-run pipeline context populated by the orchestrator before task execution.
 *
 * @remarks
 * Same role as the original {@link PipelineContextInterface}: built-in
 * tasks (`json:read`, `rdfjs:finalize`) read it; plugin tasks may use it but
 * are not required to. Field is optional on {@link PipelineStateInterface}
 * so existing callers keep working.
 *
 * @example
 * ```ts
 * const ctx: PipelineContextInterface = {
 *   target:  'aonprd',
 *   outDir:  './graphs',
 *   config:  { input: './output/aonprd' },
 *   factory: dataFactory,
 *   dataset: store.dataset(),
 *   builder: new GraphBuilder('https://squashage.dev/vocabulary/aonprd#'),
 *   graphs:  { feat: dataFactory.namedNode('https://squashage.dev/graph/aonprd/feat') },
 *   iri:     new NamespaceBuilder('https://squashage.dev/vocabulary/aonprd#'),
 *   output:  outputConfig,
 * };
 * ```
 *
 * @category Pipeline
 * @since 2.1.0
 * @see {@link PipelineStateInterface}
 * @group Types
 */
export interface PipelineContextInterface {
  /** Squashage target identifier from the config. */
  readonly target:  string;
  /** Output base directory; reports and quarantine records land under `<outDir>/<target>/...`. */
  readonly outDir:  string;
  /** Per-target configuration object as supplied by the loaded squashage config. */
  readonly config:  Record<string, unknown>;
  /** Run-wide RDF/JS factory (singleton from `src/rdf/DataFactory.ts`; v0.x backed by `@rdfjs/data-model`). */
  readonly factory: DataFactory;
  /** Run-wide canonical dataset every plugin contributes to. */
  readonly dataset: DatasetCore;
  /** Builder for emitting quads with prefix/IRI conventions. */
  readonly builder: GraphBuilder;
  /** Named-graph IRIs by lane key, from `targets[].graphs`. */
  readonly graphs:  Readonly<Record<string, NamedNode>>;
  /** IRI builder for the target (Proxy returning a NamedNode per property). */
  readonly iri:     NamespaceBuilder;
  /** Resolved output config (merged with CLI overrides). */
  readonly output:  OutputConfigInterface;
  /** Resolved prefix→base pairs (instances, graphs, vocabulary) for this run. */
  readonly prefixes: PrefixResolutionInterface;
  /**
   * Optional json-tology ontology instance for the current target.
   *
   * @remarks
   * Present when `targets.<id>.ontology.engine === "json-tology"` is configured.
   * Built by the orchestrator at context-construction time. Plugin tasks may use
   * `ctx.jt.toQuads(schemaId, instance)` for typed ABox projection instead of
   * hand-writing quads.
   *
   * @since 0.5.0
   */
  readonly jt?: JsonTologyOntology;
  /**
   * ISO 8601 timestamp frozen at the moment the orchestrator constructed this
   * context (i.e. once per target run, not per record).
   *
   * @remarks
   * Used by `output:provenance` to stamp all provenance quads with a single,
   * deterministic run-start time. Preserving determinism across two identical
   * runs requires that the timestamp is fixed before record processing begins.
   *
   * @since 0.5.0
   */
  readonly runStartTime?: string | undefined;
}

/**
 * Shared mutable state passed through every task in a single pipeline run.
 *
 * @remarks
 * `output` keeps its role as the per-record result slot — for Squashage this
 * is the projection report (classification + emitted quad count), not the
 * canonical RDF document. Canonical RDF lives on `context.dataset`. Tasks may
 * attach arbitrary extra keys via the `Record<string, unknown>` index
 * signature for inter-task communication.
 *
 * @example
 * ```ts
 * const state: PipelineStateInterface = {
 *   targetId:       'aonprd',
 *   source:         { target: 'aonprd', path: 'feat-power-attack.json' },
 *   input:          { _type: 'feat', name: 'Power Attack', level: 1 },
 *   classification: null,
 *   output:         null,
 * };
 * ```
 *
 * @category Pipeline
 * @since 2.1.0
 * @see {@link PipelineContextInterface}
 * @group Types
 */
export interface PipelineStateInterface extends Record<string, unknown> {
  /** Squashage target identifier from the config. */
  readonly targetId:       string;
  /** Source metadata for the record flowing through the pipeline. */
  readonly source:         InputSourceInterface;
  /** Parsed input JSON record. */
  readonly input:          Readonly<Record<string, unknown>>;
  /** Classification result; `null` until a `classify:*` task populates it. */
  classification:          ClassificationEvidenceInterface | null;
  /** Per-record classification proposals; populated additively by classifier tasks. */
  classifications:         ReadonlyArray<ClassificationProposalInterface>;
  /** Per-record projection report; `null` until `squash:*` writes it. */
  output:                  Record<string, unknown> | null;
  /** Per-run context populated by the orchestrator. */
  context?:                PipelineContextInterface;
}
