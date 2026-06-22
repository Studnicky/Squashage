/**
 * AONPRD dagonizer plugin — registers classifier nodes and the ontology-backed
 * squash node.
 *
 * Call `register(dispatcher)` once during framework bootstrap to wire in all
 * AONPRD-owned nodes. Framework builtins (json-read, record-health-gate,
 * record-quarantine, output-provenance, classify:source, etc.) are registered
 * by SquashageRun and must not be re-registered here.
 *
 * DAG loading is handled by PluginLoader — do NOT load or register DAGs here.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NodeStateInterface }              from '@studnicky/dagonizer';

import type { SquashageDagonizer }              from '../../src/dispatcher/SquashageDagonizer.js';
import { DiscriminatorClassifierNode }          from '../../src/nodes/record/classifiers/DiscriminatorClassifierNode.js';
import { UrlPatternClassifierNode }             from '../../src/nodes/record/classifiers/UrlPatternClassifierNode.js';
import { StructuralClassifierNode }             from '../../src/nodes/record/classifiers/StructuralClassifierNode.js';
import { ClassifyConflictNode }                 from '../../src/nodes/record/classifyConflict.js';
import { OntologyProjectionNode }               from '../../src/nodes/record/ontologyProjection.js';
import { JsonTologyOntology }                               from '../../src/ontology/JsonTologyOntology.js';
import type { JsonTologySchemaInputInterface }              from '../../src/ontology/JsonTologyOntology.js';
import { loadCoreSchemaInputs, loadExtractedSchemaInputs } from '../../src/ontology/coreSchemas.js';
import { aonprdPluginConfig }                   from './aonprd.plugin.config.js';

const PLUGIN_DIR: string = dirname(fileURLToPath(import.meta.url));

export async function buildOntology(): Promise<JsonTologyOntology> {
  const { baseIRI, schemas } = aonprdPluginConfig.ontology;

  const [coreInputs, extractedInputs] = await Promise.all([
    loadCoreSchemaInputs(),
    loadExtractedSchemaInputs(PLUGIN_DIR),
  ]);

  const leafInputs: JsonTologySchemaInputInterface[] = await Promise.all(
    schemas.map(async (entry) => {
      const absPath = resolvePath(PLUGIN_DIR, entry.schemaPath);
      const text    = await readFile(absPath, 'utf8');
      const schema  = JSON.parse(text) as Record<string, unknown> & { readonly '$id': string };
      return { schemaPath: entry.schemaPath, schema };
    }),
  );

  return JsonTologyOntology.create({
    baseIRI,
    schemas: [...coreInputs, ...leafInputs, ...extractedInputs],
  });
}

export async function register(dispatcher: SquashageDagonizer<NodeStateInterface>): Promise<void> {
  // ── ontology + squash node ──────────────────────────────────────────────────
  const ontology = await buildOntology();
  // Expose the ontology on services so framework builtins that read
  // `services.ontology` (ontology-emit, classify:shacl-shape) get the value.
  dispatcher.squashageServices.ontology = ontology;
  dispatcher.registerNode(new OntologyProjectionNode(ontology));

  // ── classifier nodes ────────────────────────────────────────────────────────
  dispatcher.registerNode(new DiscriminatorClassifierNode(aonprdPluginConfig.discriminator));
  dispatcher.registerNode(new UrlPatternClassifierNode(aonprdPluginConfig.urlPattern));
  dispatcher.registerNode(new StructuralClassifierNode(aonprdPluginConfig.structural));
  dispatcher.registerNode(new ClassifyConflictNode(aonprdPluginConfig.conflict));
}
