/**
 * @fileoverview SHACL-shape classifier task for the Squashage pipeline.
 *
 * @remarks
 * Provides {@link ShaclShapeClassifier}, a deterministic classifier that validates
 * each record's projected ABox against SHACL shapes and emits one
 * {@link ClassificationProposalInterface} per conforming `sh:NodeShape`.
 *
 * Shape source is configured via {@link ShaclShapeClassifierConfigInterface.shapesFrom}:
 * - `"ontology"` reads from `state.context.jt.shacl()` (auto-emitted shapes from
 *   the target's json-tology integration).
 * - Any other string is treated as a filesystem path to a Turtle shape file,
 *   resolved at construction time and loaded once.
 *
 * ABox construction uses a property-path projection: for each `sh:NodeShape`,
 * the classifier collects `sh:path` values from its `sh:property` shapes and
 * maps corresponding record properties to those IRIs as typed literals. A
 * synthetic `sh:targetNode` is added so `rdf-validate-shacl` has a focus node
 * to evaluate. This avoids the need for a working `jt.toQuads()` implementation.
 *
 * For shapes that carry an explicit `sh:targetClass`, the classifier derives the
 * class name from that IRI. For json-tology shapes (where the NodeShape IRI is
 * the schema `$id` and `sh:targetClass` is absent), the class name is derived
 * from the classMap via the jt integration.
 *
 * @module
 * @since 0.5.0
 * @category Classification
 */

import { readFileSync }         from 'node:fs';
import { resolve }              from 'node:path';

import type { Quad, NamedNode } from '@rdfjs/types';
import { dataFactory }   from '../../rdf/DataFactory.js';
import { Dataset }       from '../../rdf/Dataset.js';
import { ShaclGate }     from '../../shacl/ShaclGate.js';
import { Parser }        from '../../rdf/Parser.js';
import { OutputConfigError } from '../../errors/OutputConfigError.js';
import { Logger }        from '../../modules/logger/logger.js';
import type { TaskFnInterface, NextFnInterface } from '../../types/Pipeline.js';
import type { PipelineStateInterface, ClassificationProposalInterface } from '../../types/PipelineState.js';
import type { JsonTologyOntology } from '../../ontology/JsonTologyOntology.js';

const logger = Logger.forComponent('ShaclShapeClassifier');

// ── SHACL / RDF vocabulary constants ─────────────────────────────────────────

const SH       = 'http://www.w3.org/ns/shacl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD      = 'http://www.w3.org/2001/XMLSchema#';

const SH_NODE_SHAPE   = `${SH}NodeShape`;
const SH_PROPERTY     = `${SH}property`;
const SH_PATH         = `${SH}path`;
const SH_TARGET_CLASS = `${SH}targetClass`;
const SH_TARGET_NODE  = `${SH}targetNode`;

// ── Config interface ──────────────────────────────────────────────────────────

/**
 * Configuration for the {@link ShaclShapeClassifier}.
 *
 * @category Classification
 * @since 0.5.0
 * @group Types
 */
export interface ShaclShapeClassifierConfigInterface {
  /**
   * Shape source selector.
   *
   * @remarks
   * `"ontology"` loads shapes from `state.context.jt.shacl()` (the
   * auto-emitted SHACL graph from the target's json-tology engine). Any other
   * string is interpreted as a filesystem path to a Turtle shape file,
   * resolved at construction time.
   */
  readonly shapesFrom: 'ontology' | string;
  /**
   * Numeric priority written onto every emitted proposal.
   *
   * @defaultValue 45
   */
  readonly priority?: number | undefined;
}

// ── Internal NodeShape descriptor ─────────────────────────────────────────────

/**
 * Internal descriptor for one NodeShape extracted from a shapes graph.
 *
 * @internal
 */
interface NodeShapeDescriptorInterface {
  /** The NodeShape IRI. */
  readonly shapeIri: string;
  /** The `sh:targetClass` IRI, or undefined when absent. */
  readonly targetClassIri: string | undefined;
  /** All quads whose subject is this NodeShape IRI or a referenced blank node. */
  readonly allShapeQuads: ReadonlyArray<Quad>;
  /**
   * `sh:path` IRIs from the shape's property shapes — used to build the ABox
   * from the raw record when no explicit ABox projection is available.
   */
  readonly propertyPathIris: ReadonlyArray<string>;
}

// ── ShaclShapeClassifier ──────────────────────────────────────────────────────

/**
 * Deterministic SHACL-shape classifier task.
 *
 * @remarks
 * Validates each record's projected ABox against each loaded NodeShape.
 * For every shape whose constraints all conform, the classifier emits one
 * {@link ClassificationProposalInterface}.
 *
 * Class name derivation:
 * - When the shape carries `sh:targetClass`, the class name is derived from
 *   that IRI's last fragment or path segment.
 * - When used with json-tology (`shapesFrom: 'ontology'`), the NodeShape IRI
 *   is the schema `$id`; the class name is resolved from the jt `classMap()`.
 * - When neither is available, the shape is skipped.
 *
 * Records that fail every shape receive no proposal from this classifier.
 *
 * @example
 * ```ts
 * const classifier = ShaclShapeClassifier.create({
 *   shapesFrom: 'ontology',
 *   priority:   45,
 * });
 * pipeline.use(classifier.execute);
 * ```
 *
 * @category Classification
 * @since 0.5.0
 * @see {@link ShaclShapeClassifierConfigInterface}
 * @group Tasks
 */
export class ShaclShapeClassifier {
  readonly #config:     ShaclShapeClassifierConfigInterface;
  readonly #priority:   number;
  /**
   * Pre-loaded shape quads when `shapesFrom` is a file path; `null` when shapes
   * come from `state.context.jt` (resolved per-execute in ontology mode).
   * A Promise is stored for file-path mode to allow async parsing at startup.
   */
  readonly #fileShapes: Promise<ReadonlyArray<Quad>> | null;

  // ── Static factory ──────────────────────────────────────────────────────────

  /**
   * Builds a {@link ShaclShapeClassifier} from the provided config.
   *
   * @remarks
   * When `shapesFrom` is a filesystem path the file is read and parsed at
   * construction time (once per run). When `shapesFrom === 'ontology'` no file
   * I/O occurs at construction; shapes are resolved from `state.context.jt` on
   * first execute.
   *
   * @param config      - SHACL shape classifier config.
   * @param schemasBase - Base directory for resolving relative file paths. Only
   *   used when `shapesFrom` is a path string; defaults to `process.cwd()`.
   * @returns A fully initialised {@link ShaclShapeClassifier} instance.
   * @throws {OutputConfigError} When the shape file is missing or unparseable.
   */
  public static create(
    config:      ShaclShapeClassifierConfigInterface,
    schemasBase: string = process.cwd(),
  ): ShaclShapeClassifier {
    logger.debug('create', 'Creating ShaclShapeClassifier', {
      shapesFrom: config.shapesFrom,
      priority:   config.priority ?? 45,
    });

    if (config.shapesFrom === 'ontology') {
      return new ShaclShapeClassifier(config, null);
    }

    // File-path mode: read the file synchronously, then parse async via Parser.
    const absPath = resolve(schemasBase, config.shapesFrom);
    let text: string;
    try {
      text = readFileSync(absPath, 'utf-8');
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw OutputConfigError.create(
        `classify:shacl-shape: cannot read shape file at ${absPath}: ${cause?.message ?? String(err)}`,
        { cause, metadata: { shapesFrom: config.shapesFrom, absPath } },
      );
    }

    // Parse async; the Promise is cached and awaited on first execute call.
    const shapesPromise = Parser.parse(text, { format: 'turtle' }).then(result => {
      logger.debug('create', 'Loaded shape file', { absPath, quadCount: result.quads.length });
      return result.quads;
    });

    return new ShaclShapeClassifier(config, shapesPromise);
  }

  // ── Private constructor ─────────────────────────────────────────────────────

  private constructor(
    config:     ShaclShapeClassifierConfigInterface,
    fileShapes: Promise<ReadonlyArray<Quad>> | null,
  ) {
    this.#config     = config;
    this.#priority   = config.priority ?? 45;
    this.#fileShapes = fileShapes;
  }

  // ── Execute ────────────────────────────────────────────────────────────────

  /**
   * Pipeline task function bound to this instance.
   *
   * @remarks
   * Per-record flow:
   * 1. When `shapesFrom === 'ontology'` and `state.context.jt` is absent,
   *    calls `next()` immediately (no-op).
   * 2. Loads the shapes graph (from file cache or `jt.shacl()`).
   * 3. Extracts NodeShape descriptors.
   * 4. For each NodeShape, resolves a class name, builds a targeted ABox,
   *    and validates it with {@link ShaclGate.run}.
   * 5. Conforming shapes produce one proposal; non-conforming shapes are skipped.
   *
   * @param next  - Pipeline continuation; always called after classification.
   * @param state - Mutable pipeline state for the current record.
   */
  public readonly execute: TaskFnInterface<PipelineStateInterface> = async (
    next: NextFnInterface,
    state: PipelineStateInterface,
  ): Promise<void> => {
    logger.debug('execute', 'Running SHACL shape classification', { targetId: state.targetId });

    // Guard: ontology mode with no jt -> no-op.
    if (this.#config.shapesFrom === 'ontology' && state.context?.jt === undefined) {
      logger.debug('execute', 'shapesFrom=ontology but state.context.jt absent, no-op', {
        targetId: state.targetId,
      });
      await next();
      return;
    }

    // Resolve shape quads (file-parsed promise or jt.shacl()).
    let allShapeQuads: ReadonlyArray<Quad>;
    if (this.#fileShapes !== null) {
      allShapeQuads = await this.#fileShapes;
    } else {
      allShapeQuads = await state.context!.jt!.shacl();
    }

    if (allShapeQuads.length === 0) {
      logger.debug('execute', 'Shape graph is empty, no-op', { targetId: state.targetId });
      await next();
      return;
    }

    const jt = state.context?.jt;

    // Extract NodeShape descriptors from the shapes graph.
    const shapes = ShaclShapeClassifier.#extractNodeShapes(allShapeQuads);

    if (shapes.length === 0) {
      logger.debug('execute', 'No NodeShapes found, no-op', { targetId: state.targetId });
      await next();
      return;
    }

    const proposals: ClassificationProposalInterface[] = [];

    for (const shape of shapes) {
      // Resolve className for this shape.
      const className = ShaclShapeClassifier.#resolveClassName(shape, jt);
      if (className === undefined) {
        // Cannot derive a className; skip this shape.
        continue;
      }

      // Build a targeted ABox: record properties projected via the shape's
      // property paths, plus a sh:targetNode pointing to the record subject.
      const { shapesDataset, dataDataset } =
        ShaclShapeClassifier.#buildValidationPair(shape, state.input);

      let report: Awaited<ReturnType<typeof ShaclGate.run>> | undefined;
      try {
        report = await ShaclGate.run(shapesDataset, dataDataset);
      } catch (err) {
        logger.debug('execute', 'SHACL validation threw for shape', {
          targetId: state.targetId,
          shapeIri: shape.shapeIri,
          error:    err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const targetClassIri = shape.targetClassIri ?? `urn:shape:${className}`;

      if (report.conforms) {
        proposals.push({
          source:     'classify:shacl-shape',
          className,
          priority:   this.#priority,
          confidence: 1,
          reasons: [
            `shacl:targetClass=${targetClassIri}`,
            'shacl:conforms=true',
          ],
        });

        logger.debug('execute', 'Shape conforms, emitting proposal', {
          targetId: state.targetId,
          className,
          shapeIri: shape.shapeIri,
        });
      }
    }

    if (proposals.length > 0) {
      logger.debug('execute', `Appending ${proposals.length.toString()} SHACL proposal(s)`, {
        count: proposals.length,
      });
      (state as unknown as { classifications: ReadonlyArray<ClassificationProposalInterface> }).classifications = [
        ...state.classifications,
        ...proposals,
      ];
    }

    await next();
  };

  // ── Private static helpers ─────────────────────────────────────────────────

  /**
   * Extracts all NodeShape descriptors from a flat array of shape quads.
   *
   * @remarks
   * A NodeShape is identified by a quad `<shapeIri> rdf:type sh:NodeShape`.
   * Each descriptor collects the direct quads on the NodeShape subject and
   * transitively follows blank-node `sh:property` references to gather
   * property-shape quads (needed for path extraction).
   *
   * @internal
   */
  static #extractNodeShapes(quads: ReadonlyArray<Quad>): ReadonlyArray<NodeShapeDescriptorInterface> {
    // Build a reverse index: subject IRI/BNode-id -> quads.
    const bySubject = new Map<string, Quad[]>();
    for (const q of quads) {
      const key = q.subject.value;
      const bucket = bySubject.get(key);
      if (bucket !== undefined) {
        bucket.push(q as Quad);
      } else {
        bySubject.set(key, [q as Quad]);
      }
    }

    // First pass: collect all NodeShape subject values.
    const shapeIris = new Set<string>();
    for (const q of quads) {
      if (q.predicate.value === RDF_TYPE && q.object.value === SH_NODE_SHAPE) {
        shapeIris.add(q.subject.value);
      }
    }

    const descriptors: NodeShapeDescriptorInterface[] = [];

    for (const shapeIri of shapeIris) {
      let targetClassIri: string | undefined;
      const directQuads = bySubject.get(shapeIri) ?? [];
      const allShapeQuads: Quad[] = [...directQuads];
      const propertyPathIris: string[] = [];

      // Follow sh:property -> blank-node chains to collect property-shape quads.
      for (const q of directQuads) {
        if (q.predicate.value === SH_TARGET_CLASS) {
          targetClassIri = q.object.value;
        }

        if (q.predicate.value === SH_PROPERTY) {
          const propBnId = q.object.value;
          const propQuads = bySubject.get(propBnId) ?? [];
          for (const pq of propQuads) {
            allShapeQuads.push(pq);
            if (pq.predicate.value === SH_PATH) {
              propertyPathIris.push(pq.object.value);
            }
          }
        }
      }

      descriptors.push({ shapeIri, targetClassIri, allShapeQuads, propertyPathIris });
    }

    return descriptors;
  }

  /**
   * Resolves a class name string for a given NodeShape descriptor.
   *
   * @remarks
   * Resolution order:
   * 1. `sh:targetClass` IRI fragment/segment.
   * 2. For ontology mode: `jt.classMap()` lookup using the shape IRI (schema
   *    `$id`) to find a registered schema whose class IRI matches.
   *    Actually, jt.classMap() maps className -> classIri; we need to find
   *    the schema whose $id matches the shape IRI, then derive the className
   *    from the classMap.
   * 3. The NodeShape IRI's last fragment/segment as a fallback.
   *
   * @internal
   */
  static #resolveClassName(
    shape: NodeShapeDescriptorInterface,
    jt:    JsonTologyOntology | undefined,
  ): string | undefined {
    // 1. sh:targetClass present -> use fragment/segment.
    if (shape.targetClassIri !== undefined) {
      return ShaclShapeClassifier.#lastSegment(shape.targetClassIri);
    }

    // 2. Ontology mode: the shapeIri is a schema $id; look for the corresponding
    //    className in the classMap. The classMap maps className -> classIri.
    //    We find the className by checking jt.schemaForClassName() for each entry.
    if (jt !== undefined) {
      const classMap = jt.classMap();
      for (const [className] of Object.entries(classMap)) {
        const schema = jt.schemaForClassName(className);
        if (schema !== undefined && schema.$id === shape.shapeIri) {
          return className;
        }
      }
    }

    // 3. Fallback: derive from the NodeShape IRI itself.
    const derived = ShaclShapeClassifier.#lastSegment(shape.shapeIri);
    return derived.length > 0 ? derived : undefined;
  }

  /**
   * Builds a validation pair: a shapes dataset augmented with `sh:targetNode`
   * and a data dataset projected from the record's properties via the shape's
   * property paths.
   *
   * @remarks
   * Since json-tology SHACL shapes lack `sh:targetClass` and `sh:targetNode`,
   * we inject a synthetic `sh:targetNode <urn:record:0>` into a clone of the
   * shape quads and project the record's properties using the shape's property
   * path IRIs as predicates.
   *
   * For shapes that already carry `sh:targetClass`, the ABox is built with a
   * `rdf:type <targetClass>` triple on the record subject, which satisfies
   * the `sh:targetClass` focus-node selector.
   *
   * @internal
   */
  static #buildValidationPair(
    shape:  NodeShapeDescriptorInterface,
    record: Readonly<Record<string, unknown>>,
  ): { shapesDataset: ReturnType<typeof Dataset.from>; dataDataset: ReturnType<typeof Dataset.from> } {
    const RECORD_IRI = 'urn:record:0';
    const recordNode = dataFactory.namedNode(RECORD_IRI) as NamedNode;
    const defaultGraph = dataFactory.defaultGraph();
    const shapeNode    = dataFactory.namedNode(shape.shapeIri) as NamedNode;

    // Clone the shape quads and inject sh:targetNode if no sh:targetClass is set.
    const shapeQuads: Quad[] = [...shape.allShapeQuads];

    if (shape.targetClassIri === undefined) {
      // Inject sh:targetNode pointing to the synthetic record subject.
      shapeQuads.push(
        dataFactory.quad(
          shapeNode,
          dataFactory.namedNode(SH_TARGET_NODE) as NamedNode,
          recordNode,
          defaultGraph,
        ) as unknown as Quad,
      );
    }

    const shapesDataset = Dataset.from(shapeQuads as Iterable<Quad>);

    // Build the ABox for the record.
    const dataQuads: Quad[] = [];

    if (shape.targetClassIri !== undefined) {
      // Add rdf:type so sh:targetClass focus-node selection works.
      dataQuads.push(
        dataFactory.quad(
          recordNode,
          dataFactory.namedNode(RDF_TYPE) as NamedNode,
          dataFactory.namedNode(shape.targetClassIri) as NamedNode,
          defaultGraph,
        ) as unknown as Quad,
      );
    }

    // Project record properties via the shape's property path IRIs.
    for (const pathIri of shape.propertyPathIris) {
      // Derive the property key from the path IRI's last segment.
      const key = ShaclShapeClassifier.#lastSegment(pathIri);
      if (key.length === 0) continue;

      const value = record[key];
      if (value === undefined || value === null) continue;

      // Emit a typed literal based on the JS type.
      let literal: ReturnType<typeof dataFactory.literal>;
      if (typeof value === 'number') {
        const isInt = Number.isInteger(value);
        literal = dataFactory.literal(
          String(value),
          dataFactory.namedNode(isInt ? `${XSD}integer` : `${XSD}decimal`) as NamedNode,
        );
      } else if (typeof value === 'boolean') {
        literal = dataFactory.literal(String(value), dataFactory.namedNode(`${XSD}boolean`) as NamedNode);
      } else {
        literal = dataFactory.literal(String(value));
      }

      dataQuads.push(
        dataFactory.quad(
          recordNode,
          dataFactory.namedNode(pathIri) as NamedNode,
          literal,
          defaultGraph,
        ) as unknown as Quad,
      );
    }

    const dataDataset = Dataset.from(dataQuads as Iterable<Quad>);
    return { shapesDataset, dataDataset };
  }

  /**
   * Returns the last `#`-fragment or `/`-segment from an IRI string.
   *
   * @remarks
   * For `https://example.org/vocabulary#Feat` returns `"Feat"`.
   * For `https://example.org/Person` returns `"Person"`.
   * A `#` fragment takes priority over a `/` segment when the IRI contains `#`.
   *
   * @internal
   */
  static #lastSegment(iri: string): string {
    const hashIdx = iri.indexOf('#');
    if (hashIdx !== -1) {
      const fragment = iri.slice(hashIdx + 1);
      if (fragment.length > 0) return fragment;
    }
    const segment = iri.split('/').pop();
    return segment !== undefined ? segment : '';
  }
}
