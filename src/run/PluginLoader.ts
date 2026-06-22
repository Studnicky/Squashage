/**
 * PluginLoader — discovers and loads squashage plugins from the plugins/ directory.
 *
 * Mirrors the ripperoni PluginLoader pattern: one call to `registerPluginsFromEntry`
 * dynamically imports the plugin's `index.js`, calls its `register(dispatcher)` hook
 * (which registers nodes), then loads all `*.dag.jsonld` files from the plugin
 * directory in topological order (leaves first, dependents last).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve }                          from 'node:path';
import { DAGDocument }                            from '@studnicky/dagonizer';
import type { DAGType }                           from '@studnicky/dagonizer';
import type { NodeStateInterface }                from '@studnicky/dagonizer';
import { Logger }                                 from '../modules/logger/logger.js';

import type { SquashageDagonizer }                from '../dispatcher/SquashageDagonizer.js';

const log = Logger.forComponent('PluginLoader');

/** Callable shape the plugin `index.js` must export as `register`. */
interface PluginRegisterExportInterface {
  readonly register: (dispatcher: SquashageDagonizer<NodeStateInterface>) => void | Promise<void>;
}

export class PluginLoader {
  private constructor() { /* static-only */ }

  /**
   * DAG name prefixes whose references are framework-owned and should NOT be
   * treated as plugin namespaces. A DAG scatter body `{ dag: "squashage:record" }`
   * refers to a framework (or plugin-override) DAG, not another plugin to load.
   */
  static readonly BUILTIN_PREFIXES: ReadonlyArray<string> = ['squashage:'];

  /**
   * Loads `plugins/<pluginNamespace>/index.js`, calls its exported
   * `register(dispatcher)` to wire classifier nodes, then collects all
   * `*.dag.jsonld` files from that directory in topological order and
   * returns them for the caller to register after all framework nodes
   * have been registered.
   *
   * Returns the plugin's DAGs (sorted in registration order) when the plugin
   * directory was found, or `null` when `pluginsDir/<pluginNamespace>/` does
   * not exist.
   *
   * DAGs must be registered AFTER the framework bundle (which registers the
   * framework nodes they reference).  Call `dispatcher.registerDAG(dag)` for
   * each returned DAG after `dispatcher.registerBundle(bundle)`.
   *
   * @param dispatcher      - The run's dagonizer dispatcher.
   * @param pluginsDir      - Absolute path to the top-level plugins/ directory.
   * @param pluginNamespace - The plugin subdirectory name (e.g. `'aonprd'`).
   * @returns Sorted plugin DAGs to register after the framework bundle, or
   *          `null` when no plugin with that namespace exists.
   */
  static async registerPluginsFromEntry(
    dispatcher:      SquashageDagonizer<NodeStateInterface>,
    pluginsDir:      string,
    pluginNamespace: string,
  ): Promise<ReadonlyArray<DAGType> | null> {
    const pluginDir = join(pluginsDir, pluginNamespace);
    log.info('registerPluginsFromEntry', 'loading plugin', { pluginsDir, pluginNamespace, pluginDir, exists: existsSync(pluginDir) });
    if (!existsSync(pluginDir)) return null;

    // Dynamically import the plugin's entry point. Under ESM with tsx/ts-node,
    // `index.ts` is importable directly. In compiled dist/, `index.js` is used.
    const entryTs  = resolve(pluginDir, 'index.ts');
    const entryJs  = resolve(pluginDir, 'index.js');
    const entry    = existsSync(entryTs) ? entryTs : entryJs;
    log.info('registerPluginsFromEntry', 'importing plugin entry', { entry });

    const mod = await import(entry) as PluginRegisterExportInterface;
    log.info('registerPluginsFromEntry', 'calling register()', { hasRegister: typeof mod.register === 'function' });
    await mod.register(dispatcher);
    log.info('registerPluginsFromEntry', 'register() complete', { squashNode: dispatcher.getNode('squash') !== undefined });

    // Collect all *.dag.jsonld files from the plugin directory.
    const dagFiles = readdirSync(pluginDir)
      .filter((f) => f.endsWith('.dag.jsonld'))
      .map((f)    => join(pluginDir, f));

    const dags: DAGType[] = dagFiles.map((f) => DAGDocument.load(readFileSync(f, 'utf-8')));

    // Return in topological order: leaves first, dependents last.
    return PluginLoader.pluginDagsInRegistrationOrder(dags);
  }

  /**
   * Topological sort of plugin DAGs: leaves (no inbound references from peers)
   * first, dependents last.
   *
   * A DAG is a "dependent" if any of its `ScatterNode.body.dag` or
   * `EmbeddedDAGNode.dag` values match the name of another DAG in the same
   * set (ignoring builtin-prefixed references).
   *
   * @param dags - The full set of DAGs from one plugin directory.
   * @returns A new array in registration order.
   */
  static pluginDagsInRegistrationOrder(dags: ReadonlyArray<DAGType>): DAGType[] {
    if (dags.length <= 1) return [...dags];

    const names = new Set(dags.map((d) => d.name));

    // Collect peer DAG references for each dag (excluding builtin-prefixed).
    const peerDependencies = new Map<string, Set<string>>();
    for (const dag of dags) {
      const deps = new Set<string>();
      for (const node of dag.nodes) {
        if (node['@type'] === 'ScatterNode') {
          const body = node.body;
          if ('dag' in body) {
            const ref = body.dag;
            if (!PluginLoader.BUILTIN_PREFIXES.some((p) => ref.startsWith(p)) && names.has(ref)) {
              deps.add(ref);
            }
          }
        } else if (node['@type'] === 'EmbeddedDAGNode') {
          const ref = (node as Record<string, unknown>)['dag'] as string | undefined;
          if (ref !== undefined && !PluginLoader.BUILTIN_PREFIXES.some((p) => ref.startsWith(p)) && names.has(ref)) {
            deps.add(ref);
          }
        }
      }
      peerDependencies.set(dag.name, deps);
    }

    // Kahn's algorithm: BFS topological sort.
    const inDegree  = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const dag of dags) {
      inDegree.set(dag.name, 0);
      dependents.set(dag.name, []);
    }

    for (const [name, deps] of peerDependencies) {
      for (const dep of deps) {
        // name depends on dep → dep is a prerequisite → dep must come first.
        // Edge direction: dep → name (dep enables name).
        dependents.get(dep)!.push(name);
        inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
      }
    }

    const queue  = dags.filter((d) => (inDegree.get(d.name) ?? 0) === 0);
    const sorted: DAGType[] = [];
    const dagByName = new Map(dags.map((d) => [d.name, d]));

    while (queue.length > 0) {
      const dag = queue.shift()!;
      sorted.push(dag);
      for (const depName of dependents.get(dag.name) ?? []) {
        const newDegree = (inDegree.get(depName) ?? 1) - 1;
        inDegree.set(depName, newDegree);
        if (newDegree === 0) {
          const depDag = dagByName.get(depName);
          if (depDag !== undefined) queue.push(depDag);
        }
      }
    }

    // If cycle detected (sorted.length < dags.length), fall back to original order.
    return sorted.length === dags.length ? sorted : [...dags];
  }
}
