/**
 * output-provenance — emits PROV-O sidecar quads for the current record into
 * a dedicated provenance named graph in `services.dataset`.
 *
 * Encoding: named-graph (RDF-star variant is deferred to a follow-up).
 * No-ops when `services.output.provenance?.enabled !== true`.
 *
 * Subject IRI: `<instancesBase>/run/<sha1(recordPath:recordLine)[:8]>`
 * Graph IRI:   `<instancesBase>/provenance` (or `services.output.provenance.graph`
 *              when it is a full http(s):// IRI).
 */

import { createHash } from 'node:crypto';

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRecordState } from '../../state/SquashageRecordState.js';

const RDF_TYPE       = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PROV_NS        = 'http://www.w3.org/ns/prov#';
const PROV_Activity  = `${PROV_NS}Activity`;
const PROV_wasGenBy  = `${PROV_NS}wasGeneratedBy`;
const PROV_value     = `${PROV_NS}value`;
const PROV_atTime    = `${PROV_NS}atTime`;
const PROV_reason    = `${PROV_NS}reason`;
const XSD_NS         = 'http://www.w3.org/2001/XMLSchema#';
const XSD_decimal    = `${XSD_NS}decimal`;
const XSD_dateTime   = `${XSD_NS}dateTime`;

const DEFAULT_INCLUDE: ReadonlyArray<string> = ['classifier', 'confidence', 'reasons', 'timestamp'];

type Output = 'written' | 'skipped';

interface ResolvedConfigInterface {
  readonly enabled: boolean;
  readonly graph:   string | undefined;
  readonly include: ReadonlyArray<string>;
}

class OutputProvenanceNodeImpl extends ScalarNode<SquashageRecordState, Output, SquashageServices> {
  public readonly name    = 'output-provenance';
  public readonly outputs = ['written', 'skipped'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { written: { type: 'object' }, skipped: { type: 'object' } };
  }

  protected override async executeOne(
    state:   SquashageRecordState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const cfg = OutputProvenanceNodeImpl.resolveConfig(context.services);
    if (cfg === null) return NodeOutputBuilder.of('skipped');
    if (state.classification === null) return NodeOutputBuilder.of('skipped');

    const factory   = context.services.factory;
    const dataset   = context.services.dataset;
    const runBase   = context.services.prefixes.instances.base;
    const subject   = factory.namedNode(
      OutputProvenanceNodeImpl.deriveRecordIri(runBase, state.recordPath, state.recordLine),
    );
    const graphNode = factory.namedNode(
      OutputProvenanceNodeImpl.resolveGraphIri(runBase, cfg.graph),
    );

    dataset.add(factory.quad(
      subject,
      factory.namedNode(RDF_TYPE),
      factory.namedNode(PROV_Activity),
      graphNode,
    ));

    const include = cfg.include;
    if (include.includes('classifier')) {
      const engineNode = factory.namedNode(
        `${runBase.endsWith('/') ? runBase : `${runBase}/`}classifier/${state.classification.engine}`,
      );
      dataset.add(factory.quad(subject, factory.namedNode(PROV_wasGenBy), engineNode, graphNode));
    }
    if (include.includes('confidence')) {
      const conf = state.classification.confidence ?? 1.0;
      dataset.add(factory.quad(
        subject,
        factory.namedNode(PROV_value),
        factory.literal(conf.toString(), factory.namedNode(XSD_decimal)),
        graphNode,
      ));
    }
    if (include.includes('timestamp')) {
      dataset.add(factory.quad(
        subject,
        factory.namedNode(PROV_atTime),
        factory.literal(context.services.runStartTime, factory.namedNode(XSD_dateTime)),
        graphNode,
      ));
    }
    if (include.includes('reasons')) {
      const reasons = state.classification.reasons.join(',');
      dataset.add(factory.quad(
        subject,
        factory.namedNode(PROV_reason),
        factory.literal(reasons),
        graphNode,
      ));
    }
    return NodeOutputBuilder.of('written');
  }

  private static resolveConfig(services: SquashageServices): ResolvedConfigInterface | null {
    const raw = (services.output as Record<string, unknown>)['provenance'];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const cfg = raw as Record<string, unknown>;
    if (cfg['enabled'] !== true) return null;
    const include = Array.isArray(cfg['include'])
      ? (cfg['include'] as string[])
      : DEFAULT_INCLUDE;
    const graph = typeof cfg['graph'] === 'string' ? cfg['graph'] : undefined;
    return { enabled: true, graph, include };
  }

  private static deriveRecordIri(runBase: string, recordPath: string, recordLine: number): string {
    const key  = `${recordPath}:${String(recordLine)}`;
    const hash = createHash('sha1').update(key).digest('hex').slice(0, 8);
    const base = runBase.endsWith('/') ? runBase : `${runBase}/`;
    return `${base}run/${hash}`;
  }

  private static resolveGraphIri(runBase: string, graph: string | undefined): string {
    if (graph === undefined || graph.length === 0) {
      const base = runBase.endsWith('/') ? runBase : `${runBase}/`;
      return `${base}provenance`;
    }
    if (graph.startsWith('http://') || graph.startsWith('https://')) return graph;
    const base = runBase.endsWith('/') ? runBase : `${runBase}/`;
    return `${base}${graph}`;
  }
}

export const outputProvenanceNode = new OutputProvenanceNodeImpl();
