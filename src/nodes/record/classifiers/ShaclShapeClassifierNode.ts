/**
 * classify:shacl-shape — validates each record's projected ABox against
 * SHACL NodeShapes and emits one proposal per conforming shape.
 *
 * Shapes are loaded once in the constructor — either from a Turtle file on
 * disk (path mode) or from `services.ontology.shacl()` (ontology mode). The
 * per-record path:
 *
 * 1. Extracts NodeShape descriptors from the shapes graph (subject of an
 *    `rdf:type sh:NodeShape` triple; transitively follows `sh:property` blank
 *    nodes to collect property-shape quads).
 * 2. Resolves a className per shape — from `sh:targetClass` IRI, then from
 *    `services.ontology.classMap()` (schema $id lookup), then the shape IRI's
 *    last fragment as a fallback.
 * 3. Builds a per-shape ABox: clones the shape quads, injects a synthetic
 *    `sh:targetNode` when `sh:targetClass` is absent, projects record
 *    properties via `sh:path` IRIs as typed literals.
 * 4. Runs `rdf-validate-shacl` via `ShaclGate`; emits a proposal for every
 *    shape whose result conforms.
 *
 * The highest-priority conforming shape wins the slot; reasons from every
 * conforming shape are merged.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import type { DatasetCore, NamedNode, Quad } from '@rdfjs/types';
import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import { OutputConfigError } from '../../../errors/OutputConfigError.js';
import type { JsonTologyOntology } from '../../../ontology/JsonTologyOntology.js';
import { Parser } from '../../../rdf/Parser.js';
import type { SquashageServices } from '../../../services/SquashageServices.js';
import { ShaclGate } from '../../../shacl/ShaclGate.js';
import type { ClassificationProposal } from '../../../state/schemas/ClassificationProposal.js';
import type { SquashageRecordState } from '../../../state/SquashageRecordState.js';

const SH = 'http://www.w3.org/ns/shacl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const SH_NODE_SHAPE = `${SH}NodeShape`;
const SH_PROPERTY = `${SH}property`;
const SH_PATH = `${SH}path`;
const SH_TARGET_CLASS = `${SH}targetClass`;
const SH_TARGET_NODE = `${SH}targetNode`;

const DEFAULT_PRIORITY = 45;

export interface ShaclShapeClassifierConfigInterface {
  /** `'ontology'` reads from `services.ontology.shacl()`; any other string is a Turtle file path. */
  readonly shapesFrom: 'ontology' | string;
  /** Numeric priority on every emitted proposal. */
  readonly priority?: number | undefined;
}

interface NodeShapeDescriptorInterface {
  readonly shapeIri:         string;
  readonly targetClassIri:   string | undefined;
  readonly allShapeQuads:    ReadonlyArray<Quad>;
  readonly propertyPathIris: ReadonlyArray<string>;
}

interface ValidationPairInterface {
  readonly shapesDataset: DatasetCore;
  readonly dataDataset:   DatasetCore;
}

type Output = 'proposed' | 'no-match';

export class ShaclShapeClassifierNode extends ScalarNode<SquashageRecordState, Output, SquashageServices> {

  public readonly name    = 'classify:shacl-shape';
  public readonly outputs = ['proposed', 'no-match'] as const;
  readonly #priority: number;
  readonly #ontologyMode: boolean;
  readonly #fileShapes: ReadonlyArray<Quad> | null;

  private constructor(priority: number, ontologyMode: boolean, fileShapes: ReadonlyArray<Quad> | null) {
    super();
    this.#priority     = priority;
    this.#ontologyMode = ontologyMode;
    this.#fileShapes   = fileShapes;
  }

  /** Build from config; reads + parses the Turtle file synchronously when `shapesFrom` is a path. */
  static async forConfig(
    config:      ShaclShapeClassifierConfigInterface,
    schemasBase: string,
  ): Promise<ShaclShapeClassifierNode> {
    const priority = config.priority ?? DEFAULT_PRIORITY;
    if (config.shapesFrom === 'ontology') {
      return new ShaclShapeClassifierNode(priority, true, null);
    }
    const absPath = resolvePath(schemasBase, config.shapesFrom);
    let text: string;
    try { text = readFileSync(absPath, 'utf-8'); }
    catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw OutputConfigError.create(
        `classify:shacl-shape: cannot read shape file at ${absPath}: ${cause?.message ?? String(err)}`,
        { cause, metadata: { shapesFrom: config.shapesFrom, absPath } },
      );
    }
    const { quads } = await Parser.parse(text, { format: 'turtle' });
    return new ShaclShapeClassifierNode(priority, false, quads);
  }

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { proposed: { type: 'object' }, 'no-match': { type: 'object' } };
  }

  protected override async executeOne(
    state:   SquashageRecordState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const ontology = context.services.ontology;
    if (this.#ontologyMode && ontology === null) return NodeOutputBuilder.of('no-match');

    const allShapeQuads: ReadonlyArray<Quad> = this.#fileShapes !== null
      ? this.#fileShapes
      : await ontology!.shacl();
    if (allShapeQuads.length === 0) return NodeOutputBuilder.of('no-match');

    const shapes = ShaclShapeClassifierNode.extractNodeShapes(allShapeQuads);
    if (shapes.length === 0) return NodeOutputBuilder.of('no-match');

    const matches: Array<{ className: string; targetClassIri: string }> = [];
    for (const shape of shapes) {
      const className = ShaclShapeClassifierNode.resolveClassName(shape, ontology);
      if (className === undefined) continue;

      const { shapesDataset, dataDataset } = await ShaclShapeClassifierNode.buildValidationPair(shape, state.input, context.services);
      let conforms = false;
      try {
        const report = await ShaclGate.run(shapesDataset, dataDataset);
        conforms = report.conforms;
      } catch { /* swallow per-shape validator errors; treat as non-conformance */ }

      if (conforms) {
        matches.push({
          className,
          targetClassIri: shape.targetClassIri ?? `urn:shape:${className}`,
        });
      }
    }

    if (matches.length === 0) return NodeOutputBuilder.of('no-match');

    const winner = matches[0] as { className: string; targetClassIri: string };
    const reasons = matches.flatMap((m) => [
      `shacl:targetClass=${m.targetClassIri}`,
      `shacl:conforms=true (${m.className})`,
    ]);
    const proposal: ClassificationProposal = {
      source:     'classify:shacl-shape',
      className:  winner.className,
      priority:   this.#priority,
      confidence: 1,
      reasons,
    };
    state.proposals['classify:shacl-shape'] = proposal;
    return NodeOutputBuilder.of('proposed');
  }

  private static lastSegment(iri: string): string {
    const hashIdx = iri.indexOf('#');
    if (hashIdx !== -1) {
      const fragment = iri.slice(hashIdx + 1);
      if (fragment.length > 0) return fragment;
    }
    const segment = iri.split('/').pop();
    return segment ?? '';
  }

  private static extractNodeShapes(quads: ReadonlyArray<Quad>): ReadonlyArray<NodeShapeDescriptorInterface> {
    const bySubject = new Map<string, Quad[]>();
    for (const q of quads) {
      const key = q.subject.value;
      const bucket = bySubject.get(key);
      if (bucket !== undefined) bucket.push(q as Quad);
      else bySubject.set(key, [q as Quad]);
    }

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

      for (const q of directQuads) {
        if (q.predicate.value === SH_TARGET_CLASS) targetClassIri = q.object.value;
        if (q.predicate.value === SH_PROPERTY) {
          const propBnId = q.object.value;
          const propQuads = bySubject.get(propBnId) ?? [];
          for (const pq of propQuads) {
            allShapeQuads.push(pq);
            if (pq.predicate.value === SH_PATH) propertyPathIris.push(pq.object.value);
          }
        }
      }

      descriptors.push({ shapeIri, targetClassIri, allShapeQuads, propertyPathIris });
    }
    return descriptors;
  }

  private static resolveClassName(
    shape:    NodeShapeDescriptorInterface,
    ontology: JsonTologyOntology | null,
  ): string | undefined {
    if (shape.targetClassIri !== undefined) return ShaclShapeClassifierNode.lastSegment(shape.targetClassIri);
    if (ontology !== null) {
      const classMap = ontology.classMap();
      for (const [className] of Object.entries(classMap)) {
        const schema = ontology.schemaForClassName(className);
        if (schema !== undefined && schema.$id === shape.shapeIri) return className;
      }
    }
    const derived = ShaclShapeClassifierNode.lastSegment(shape.shapeIri);
    return derived.length > 0 ? derived : undefined;
  }

  private static async buildValidationPair(
    shape:    NodeShapeDescriptorInterface,
    record:   Readonly<Record<string, unknown>>,
    services: SquashageServices,
  ): Promise<ValidationPairInterface> {
    const { Dataset } = await import('../../../rdf/Dataset.js');
    const factory = services.factory;
    const RECORD_IRI = 'urn:record:0';
    const recordNode = factory.namedNode(RECORD_IRI) as NamedNode;
    const defaultGraph = factory.defaultGraph();
    const shapeNode = factory.namedNode(shape.shapeIri) as NamedNode;

    const shapeQuads: Quad[] = [...shape.allShapeQuads];
    if (shape.targetClassIri === undefined) {
      shapeQuads.push(factory.quad(
        shapeNode,
        factory.namedNode(SH_TARGET_NODE) as NamedNode,
        recordNode,
        defaultGraph,
      ) as unknown as Quad);
    }
    const shapesDataset = Dataset.from(shapeQuads as Iterable<Quad>);

    const dataQuads: Quad[] = [];
    if (shape.targetClassIri !== undefined) {
      dataQuads.push(factory.quad(
        recordNode,
        factory.namedNode(RDF_TYPE) as NamedNode,
        factory.namedNode(shape.targetClassIri) as NamedNode,
        defaultGraph,
      ) as unknown as Quad);
    }

    for (const pathIri of shape.propertyPathIris) {
      const key = ShaclShapeClassifierNode.lastSegment(pathIri);
      if (key.length === 0) continue;
      const value = record[key];
      if (value === undefined || value === null) continue;

      let literal: ReturnType<typeof factory.literal>;
      if (typeof value === 'number') {
        const isInt = Number.isInteger(value);
        literal = factory.literal(
          String(value),
          factory.namedNode(isInt ? `${XSD}integer` : `${XSD}decimal`) as NamedNode,
        );
      } else if (typeof value === 'boolean') {
        literal = factory.literal(String(value), factory.namedNode(`${XSD}boolean`) as NamedNode);
      } else {
        literal = factory.literal(String(value));
      }

      dataQuads.push(factory.quad(
        recordNode,
        factory.namedNode(pathIri) as NamedNode,
        literal,
        defaultGraph,
      ) as unknown as Quad);
    }

    const dataDataset = Dataset.from(dataQuads as Iterable<Quad>);
    return { shapesDataset, dataDataset };
  }
}
