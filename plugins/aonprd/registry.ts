/**
 * aonprd worker registry module.
 *
 * Default export satisfying `RegistryModuleInterface`. Loaded by `DagHost`
 * inside each worker thread via dynamic import. `instantiate(servicesConfig)`
 * builds a full `SquashageServices` bag, registers all framework nodes and the
 * aonprd classifier nodes, loads the plugin DAGs, and returns the bundle.
 *
 * `servicesConfig` is the opaque JSON object passed from the main process via
 * `WorkerThreadContainer.servicesConfig`. Shape: `WorkerServicesConfigType`.
 *
 * Constraint: workers run in dataset mode only. `output.mode` is forced to
 * `'dataset'` so `ontologyProjection` writes quads to `state.squashedQuads`
 * rather than trying to open a file stream in the worker thread. The main
 * process gather strategy reads quads back from the state snapshot.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DAGDocument } from '@studnicky/dagonizer';
import type { JsonObjectType } from '@studnicky/dagonizer/entities';
import type { RegistryBundleInterface } from '@studnicky/dagonizer/contracts';
import type { RegistryModuleInterface } from '@studnicky/dagonizer/contracts';
import type { NodeStateInterface } from '@studnicky/dagonizer';

import { SquashageDagonizer }      from '../../src/dispatcher/SquashageDagonizer.js';
import { SquashageServices }       from '../../src/services/SquashageServices.js';
import type { SquashageRunConfigInterface } from '../../src/config/SquashageConfig.js';
import { SquashageRecordState }    from '../../src/state/SquashageRecordState.js';

import { jsonReadNode }              from '../../src/nodes/record/jsonRead.js';
import { sourceClassifierNode }      from '../../src/nodes/record/classifiers/SourceClassifierNode.js';
import { recordHealthGateNode }      from '../../src/nodes/record/recordHealthGate.js';
import { recordQuarantineNode }      from '../../src/nodes/record/recordQuarantine.js';
import { outputProvenanceNode }      from '../../src/nodes/record/outputProvenance.js';
import { OntologyProjectionNode }    from '../../src/nodes/record/ontologyProjection.js';

import { DiscriminatorClassifierNode } from '../../src/nodes/record/classifiers/DiscriminatorClassifierNode.js';
import { UrlPatternClassifierNode }    from '../../src/nodes/record/classifiers/UrlPatternClassifierNode.js';
import { StructuralClassifierNode }    from '../../src/nodes/record/classifiers/StructuralClassifierNode.js';
import { ClassifyConflictNode }        from '../../src/nodes/record/classifyConflict.js';
import { aonprdPluginConfig }          from './aonprd.plugin.config.js';
import { buildOntology }               from './index.js';

// ─── WorkerServicesConfigType ─────────────────────────────────────────────────

/**
 * Shape of the `servicesConfig` JSON blob passed from the main process to the
 * worker via `WorkerThreadContainer.servicesConfig`. Every field is a plain
 * JSON-serialisable value.
 */
interface WorkerServicesConfigType {
  readonly targetConfig: SquashageRunConfigInterface;
  readonly target:       string;
  readonly schemasBase:  string;
  readonly outDir:       string;
  readonly runStartTime: string;
}

// ─── DAG directory ────────────────────────────────────────────────────────────

/** Absolute path to `plugins/aonprd/`. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

// ─── Registry module default export ──────────────────────────────────────────

const aonprdRegistry: RegistryModuleInterface<SquashageServices> = {
  async instantiate(
    servicesConfig: JsonObjectType,
  ): Promise<RegistryBundleInterface<SquashageServices>> {
    const cfg = servicesConfig as unknown as WorkerServicesConfigType;

    // Build the services bag. Workers always operate in dataset mode; force the
    // output config to 'dataset' so ontologyProjection writes to state.squashedQuads
    // (returned to the main process via the state snapshot) rather than attempting
    // to open a streaming file handle in the worker thread.
    const services = await SquashageServices.forTarget({
      targetConfig: cfg.targetConfig,
      target:       cfg.target,
      schemasBase:  cfg.schemasBase,
      outDir:       cfg.outDir,
      output:       { ...cfg.targetConfig.output, mode: 'dataset' },
      sampleSource: undefined,
      runStartTime: cfg.runStartTime,
    });

    // Build a local dispatcher so we can call register() on it; its nodes map
    // is then handed to the bundle.
    const dispatcher = new SquashageDagonizer<NodeStateInterface>({ services });

    // Register aonprd classifier nodes (discriminator, url-pattern, structural,
    // classify-conflict). Framework nodes are registered explicitly below.
    dispatcher.registerNode(new DiscriminatorClassifierNode(aonprdPluginConfig.discriminator));
    dispatcher.registerNode(new UrlPatternClassifierNode(aonprdPluginConfig.urlPattern));
    dispatcher.registerNode(new StructuralClassifierNode(aonprdPluginConfig.structural));
    dispatcher.registerNode(new ClassifyConflictNode(aonprdPluginConfig.conflict));

    // Load the aonprd record DAG. The worker only needs the DAGs executed inside
    // the worker (squashage:record). Orchestration DAGs (squashage:run, etc.) run
    // on the main process.
    const recordDag = DAGDocument.load(
      readFileSync(join(PLUGIN_DIR, 'aonprd-record.dag.jsonld'), 'utf-8'),
    );

    // Build the ontology and expose it on services so framework builtins that
    // read `services.ontology` (ontology-emit, classify:shacl-shape) receive
    // the value. Workers always use OntologyProjectionNode — no fallback.
    const ontology = await buildOntology();
    services.ontology = ontology;
    const squashNode = new OntologyProjectionNode(ontology);

    return {
      bundle: {
        nodes: [
          // framework record-scope nodes
          jsonReadNode,
          sourceClassifierNode,
          recordHealthGateNode,
          recordQuarantineNode,
          outputProvenanceNode,
          squashNode,
        ],
        dags: [recordDag],
        stateFactories: {},
      },
      services,
      registryVersion: '0.7.1',
      restoreState: {
        restore: (snapshot: JsonObjectType) => SquashageRecordState.fromSnapshot(snapshot),
      },
    };
  },
};

export default aonprdRegistry;
