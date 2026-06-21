/**
 * rdfjs-finalize — splits the run's dataset into four separate output files:
 *
 *   1. Success graph   — every quad NOT in the PROV graph and NOT in any
 *      `urn:graph:<target>/ontology` graph. Written to `services.output.path`.
 *   2. Ontology sidecar — every quad in `urn:graph:<target>/ontology`, written
 *      to `<output.path-stem>.ontology.<ext>`. Skipped when the partition is
 *      empty (no ontology engine configured or ontology-emit was skipped).
 *   3. PROV-O graph    — every quad in the `urn:squashage:prov:<runId>` graph,
 *      written to `<output.path-stem>.prov.<ext>` as a sibling file.
 *   4. Failed-records dump — already written incrementally by
 *      `record-quarantine`; we just summarise the count.
 *
 * The success graph and ontology sidecar are serialized via the existing
 * `FileOutput` writer (atomic write, format resolution, SHACL validation).
 * The PROV graph uses a minimal N-Quads serializer for now; future work can
 * route it through FileOutput too.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

import type { DatasetCore, Quad } from '@rdfjs/types';
import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import { Dataset } from '../../rdf/Dataset.js';
import { Serializer } from '../../rdf/Serializer.js';
import { FileOutput } from '../../output/FileOutput.js';
import type { OutputConfigInterface } from '../../config/OutputConfig.js';
import type { SquashageRunState } from '../../state/SquashageRunState.js';
import { ontologyGraphIri } from './ontologyEmit.js';

type Output = 'written' | 'empty';

class RdfjsFinalizeNodeImpl extends ScalarNode<SquashageRunState, Output, SquashageServices> {
  public readonly name    = 'rdfjs-finalize';
  public readonly outputs = ['written', 'empty'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return {
      written: { type: 'object' },
      empty:   { type: 'object' },
    };
  }

  private static isProvQuad(quad: Quad): boolean {
    return quad.graph.termType === 'NamedNode'
      && quad.graph.value.startsWith('urn:squashage:prov:');
  }

  private static isOntologyQuad(quad: Quad, target: string): boolean {
    return quad.graph.termType === 'NamedNode'
      && quad.graph.value === ontologyGraphIri(target);
  }

  /**
   * Sidecar-only partition for the streaming path.
   * The success graph is already on disk; we only need prov + ontology from
   * the dataset (which holds TBox/SHACL/PROV quads, not per-record ABox quads).
   */
  private static partitionDatasetForSidecars(dataset: DatasetCore, target: string): {
    provQuads:     Quad[];
    ontologyQuads: Quad[];
  } {
    const provQuads:     Quad[] = [];
    const ontologyQuads: Quad[] = [];
    for (const quad of dataset) {
      const q = quad as Quad;
      if (RdfjsFinalizeNodeImpl.isProvQuad(q))                  provQuads.push(q);
      else if (RdfjsFinalizeNodeImpl.isOntologyQuad(q, target)) ontologyQuads.push(q);
      // Success quads in dataset on the streaming path are unexpected but harmless
      // to ignore — they would only be present for the small number of records that
      // fell through to the batched path (e.g. on error before writer was opened).
    }
    return { provQuads, ontologyQuads };
  }

  /**
   * Extract success quads from the dataset (batched path only).
   */
  private static extractSuccessQuads(dataset: DatasetCore, target: string): Quad[] {
    const successQuads: Quad[] = [];
    for (const quad of dataset) {
      const q = quad as Quad;
      if (!RdfjsFinalizeNodeImpl.isProvQuad(q) && !RdfjsFinalizeNodeImpl.isOntologyQuad(q, target)) {
        successQuads.push(q);
      }
    }
    return successQuads;
  }

  private static sidecarPath(outputPath: string, infix: string): string {
    const ext  = extname(outputPath);
    const stem = outputPath.slice(0, outputPath.length - ext.length);
    return `${stem}.${infix}${ext.length > 0 ? ext : '.nq'}`;
  }

  private static async writeNquadsSidecar(quads: ReadonlyArray<Quad>, path: string): Promise<number> {
    if (quads.length === 0) return 0;
    await mkdir(dirname(path), { recursive: true });
    const { data } = await Serializer.serialize([...quads], { format: 'nquads' });
    await writeFile(path, data, 'utf8');
    return quads.length;
  }

  private static async writeOntologySidecar(
    quads:      ReadonlyArray<Quad>,
    path:       string,
    baseConfig: OutputConfigInterface,
    runDir:     string,
  ): Promise<number> {
    if (quads.length === 0) return 0;
    const sidecarConfig: OutputConfigInterface = { ...baseConfig, path };
    const fileOutput = new FileOutput(sidecarConfig, runDir);
    await fileOutput.open();
    await fileOutput.writeBatch(Dataset.from(quads as Quad[]));
    await fileOutput.close();
    return quads.length;
  }

  private static async writePrefixesSidecar(
    outputPath: string,
    prefixes:   { instances?: { prefix: string; base: string }; graphs?: { prefix: string; base: string }; vocabulary?: { prefix: string; base: string } } | undefined,
  ): Promise<void> {
    const map: Record<string, string> = {
      rdf:  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
      rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
      owl:  'http://www.w3.org/2002/07/owl#',
      xsd:  'http://www.w3.org/2001/XMLSchema#',
      sh:   'http://www.w3.org/ns/shacl#',
      prov: 'http://www.w3.org/ns/prov#',
      skos: 'http://www.w3.org/2004/02/skos/core#',
      dct:  'http://purl.org/dc/terms/',
      core: 'https://noocodec.dev/squashage/core/',
    };
    if (prefixes?.instances)  map[prefixes.instances.prefix]  = prefixes.instances.base;
    if (prefixes?.graphs)     map[prefixes.graphs.prefix]     = prefixes.graphs.base;
    if (prefixes?.vocabulary) map[prefixes.vocabulary.prefix] = prefixes.vocabulary.base;

    const path = RdfjsFinalizeNodeImpl.sidecarPath(outputPath, 'prefixes').replace(/\.[^.]+$/, '.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(map, null, 2), 'utf8');
  }

  protected override async executeOne(
    _state:  SquashageRunState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const log = context.services.logger.forComponent('rdfjs-finalize');

    // Close the streaming writer if it was opened by ontologyProjection.
    // This flushes and finalises the success-graph file before we write sidecars.
    // Guard against both null and undefined: test fixtures may supply partial
    // service mocks that omit the recordWriter slot entirely.
    let streamedQuadCount = 0;
    const recordWriter = context.services.recordWriter ?? null;
    if (recordWriter !== null) {
      await recordWriter.close();
      log.info('executeOne', 'streaming writer closed');
      streamedQuadCount = context.services.recordSummaries
        .filter((r) => r.outcome === 'squashed').length;
    }

    const { provQuads, ontologyQuads } = RdfjsFinalizeNodeImpl.partitionDatasetForSidecars(
      context.services.dataset,
      context.services.target,
    );

    // Streaming path: the success graph is already on disk.  Only sidecars remain.
    const isStreaming = recordWriter !== null;

    if (!isStreaming) {
      // Batched path (JSON-LD or no records): read success quads from dataset.
      const successQuads = RdfjsFinalizeNodeImpl.extractSuccessQuads(
        context.services.dataset,
        context.services.target,
      );

      if (successQuads.length === 0 && provQuads.length === 0 && ontologyQuads.length === 0) {
        log.info('executeOne', 'no quads in dataset; nothing to write');
        return NodeOutputBuilder.of('empty');
      }

      const runDir = join(context.services.outDir, context.services.target);
      const fileOutput = new FileOutput(
        context.services.output,
        runDir,
        context.services.prefixes,
      );
      await fileOutput.open();
      await fileOutput.writeBatch(Dataset.from(successQuads));
      const report = await fileOutput.close();

      const ontologyPath = RdfjsFinalizeNodeImpl.sidecarPath(context.services.output.path, 'ontology');
      const ontologyCount = await RdfjsFinalizeNodeImpl.writeOntologySidecar(
        ontologyQuads,
        ontologyPath,
        context.services.output,
        runDir,
      );

      const provCount = await RdfjsFinalizeNodeImpl.writeNquadsSidecar(
        provQuads,
        RdfjsFinalizeNodeImpl.sidecarPath(context.services.output.path, 'prov'),
      );

      await RdfjsFinalizeNodeImpl.writePrefixesSidecar(
        context.services.output.path,
        context.services.prefixes,
      );

      log.info('executeOne', 'finalize complete (batched)', {
        successQuads:   successQuads.length,
        ontologyQuads:  ontologyCount,
        provQuads:      provCount,
        successPath:    report.path,
        failedRecords:  context.services.recordSummaries.filter((r) => r.outcome === 'quarantined').length,
      });

      return NodeOutputBuilder.of('written');
    }

    // Streaming path: success graph already written; write ontology + prov sidecars only.
    if (provQuads.length === 0 && ontologyQuads.length === 0 && streamedQuadCount === 0) {
      log.info('executeOne', 'no quads produced; nothing to write');
      return NodeOutputBuilder.of('empty');
    }

    const runDir = join(context.services.outDir, context.services.target);

    const ontologyPath = RdfjsFinalizeNodeImpl.sidecarPath(context.services.output.path, 'ontology');
    const ontologyCount = await RdfjsFinalizeNodeImpl.writeOntologySidecar(
      ontologyQuads,
      ontologyPath,
      context.services.output,
      runDir,
    );

    const provCount = await RdfjsFinalizeNodeImpl.writeNquadsSidecar(
      provQuads,
      RdfjsFinalizeNodeImpl.sidecarPath(context.services.output.path, 'prov'),
    );

    await RdfjsFinalizeNodeImpl.writePrefixesSidecar(
      context.services.output.path,
      context.services.prefixes,
    );

    log.info('executeOne', 'finalize complete (streaming)', {
      streamedRecords: streamedQuadCount,
      ontologyQuads:   ontologyCount,
      provQuads:       provCount,
      successPath:     context.services.output.path,
      failedRecords:   context.services.recordSummaries.filter((r) => r.outcome === 'quarantined').length,
    });

    return NodeOutputBuilder.of('written');
  }
}

export const rdfjsFinalizeNode = new RdfjsFinalizeNodeImpl();
