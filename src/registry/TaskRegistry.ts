import { resolve } from 'node:path';

import type { TaskFnInterface } from '../types/Pipeline.js';
import { ExternalSchemaError } from '../errors/ExternalSchemaError.js';
import { Logger } from '../modules/logger/logger.js';
import type { PipelineStateInterface } from '../types/PipelineState.js';

const logger = Logger.forComponent('TaskRegistry');

/**
 * Registry mapping task names to pipeline task functions.
 *
 * @remarks
 * Supports two usage modes:
 *
 * **Static (global default)** — The historical API. All static methods delegate
 * to a module-private singleton `defaultRegistry`. Plugins that call
 * `TaskRegistry.register('json:read', fn)` at import time continue to populate
 * this singleton without any changes.
 *
 * **Instance (per-run isolation)** — Construct a fresh `new TaskRegistry()` for
 * each pipeline run. The instance carries its own private task map; registrations
 * on it never affect the default registry or sibling instances. This enables
 * per-target classifiers (task C1 and later) to register target-specific tasks
 * without cross-contamination in concurrent runs.
 *
 * Tasks are registered by name and looked up by the pipeline runner at execution
 * time. Plugins self-register by calling {@link TaskRegistry.register} on import.
 *
 * @example Static usage (back-compat):
 * ```ts
 * TaskRegistry.register('monsters:transform', async (next, state) => { await next(); });
 * await TaskRegistry.load('./plugins/monsters.js');
 * ```
 *
 * @example Instance usage (per-run isolation):
 * ```ts
 * const registry = new TaskRegistry();
 * registry.register('classify:rules', classifyRulesTask);
 * const pipeline = new Pipeline({ name: 'my-run', registry });
 * ```
 *
 * @category Registry
 * @since 2.0.0
 * @see {@link Pipeline}
 * @group Core
 */
export class TaskRegistry {
  // ---------------------------------------------------------------------------
  // Instance state
  // ---------------------------------------------------------------------------

  /** Per-instance task name → TaskFnInterface map. */
  readonly #tasks = new Map<string, TaskFnInterface<PipelineStateInterface>>();

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /**
   * Creates an empty, isolated `TaskRegistry` instance.
   *
   * @remarks
   * The instance has its own private task map. Registrations on it do not affect
   * the static default registry or any other instance.
   */
  public constructor() { /* intentionally empty — #tasks initialised above */ }

  // ---------------------------------------------------------------------------
  // Instance methods
  // ---------------------------------------------------------------------------

  /**
   * Registers a named task on this instance, overwriting any existing task
   * with the same name.
   *
   * @param name - Unique task name (conventionally `"target:operation"`).
   * @param task - Task function to register.
   */
  public register(name: string, task: TaskFnInterface<PipelineStateInterface>): void {
    if (this.#tasks.has(name)) {
      logger.warn('register', `Overwriting existing task: ${name}`, { name });
    }
    this.#tasks.set(name, task);
  }

  /**
   * Retrieves a task by name from this instance.
   *
   * @param name - Task name to look up.
   * @returns The registered task function.
   * @throws {ExternalSchemaError} When no task is registered under `name`.
   */
  public get(name: string): TaskFnInterface<PipelineStateInterface> {
    const task = this.#tasks.get(name);
    if (task === undefined) {
      throw ExternalSchemaError.create(`Task not found: ${name}`, { metadata: { name } });
    }
    return task;
  }

  /**
   * Returns `true` if a task with the given name is registered on this instance.
   *
   * @param name - Task name to check.
   * @returns Whether a task is registered under `name`.
   */
  public has(name: string): boolean {
    const found = this.#tasks.has(name);
    logger.debug('has', `Task lookup: ${name}`, { name, found });
    return found;
  }

  /**
   * Clears all tasks registered on this instance.
   *
   * @remarks
   * Intended for use in tests. Does not affect the static default registry.
   */
  public reset(): void {
    const count = this.#tasks.size;
    this.#tasks.clear();
    logger.debug('reset', `Cleared ${count.toString()} registered tasks`, { count });
  }

  /**
   * Dynamically imports a plugin file to self-register its tasks.
   *
   * @remarks
   * The plugin's side-effect imports call `TaskRegistry.register(...)` (the
   * static surface), populating the default registry. To load a plugin into
   * this instance instead, call {@link TaskRegistry.register} explicitly after
   * import.
   *
   * @param pluginPath - Path to the plugin module, resolved relative to `baseDir`.
   * @param baseDir - Base directory for resolving `pluginPath` (default `process.cwd()`).
   * @throws {ExternalSchemaError} When the plugin file cannot be found or imported.
   */
  public async load(pluginPath: string, baseDir: string = process.cwd()): Promise<void> {
    const absPath = resolve(baseDir, pluginPath);
    try {
      await import(absPath);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT' || nodeErr.code === 'MODULE_NOT_FOUND' || nodeErr.code === 'ERR_MODULE_NOT_FOUND') {
        throw ExternalSchemaError.create(
          `Plugin file not found: ${absPath}`,
          { cause: nodeErr instanceof Error ? nodeErr : undefined, metadata: { pluginPath, absPath } },
        );
      }
      throw err;
    }
  }

  /**
   * Loads multiple plugin files in sequence.
   *
   * @param paths - Array of plugin paths to load.
   * @param baseDir - Base directory for resolving paths.
   * @throws {ExternalSchemaError} When any plugin file cannot be found or imported.
   */
  public async loadAll(paths: ReadonlyArray<string>, baseDir?: string): Promise<void> {
    for (const p of paths) {
      await this.load(p, baseDir);
    }
  }

  // ---------------------------------------------------------------------------
  // Static surface — delegates to the module-private default registry
  // ---------------------------------------------------------------------------

  /**
   * Registers a named task on the global default registry.
   *
   * @remarks
   * Back-compat wrapper — delegates to `defaultRegistry.register(...)`.
   * Plugins self-register by calling this at module load time.
   *
   * @param name - Unique task name.
   * @param task - Task function to register.
   */
  public static register(name: string, task: TaskFnInterface<PipelineStateInterface>): void {
    defaultRegistry.register(name, task);
  }

  /**
   * Retrieves a task by name from the global default registry.
   *
   * @param name - Task name to look up.
   * @returns The registered task function.
   * @throws {ExternalSchemaError} When no task is registered under `name`.
   */
  public static get(name: string): TaskFnInterface<PipelineStateInterface> {
    return defaultRegistry.get(name);
  }

  /**
   * Returns `true` if a task with the given name is registered in the global default registry.
   *
   * @param name - Task name to check.
   * @returns Whether a task is registered under `name`.
   */
  public static has(name: string): boolean {
    return defaultRegistry.has(name);
  }

  /**
   * Clears all tasks registered in the global default registry.
   *
   * @remarks
   * Intended for use in tests.
   */
  public static reset(): void {
    defaultRegistry.reset();
  }

  /**
   * Dynamically imports a plugin file to self-register its tasks into the
   * global default registry.
   *
   * @param pluginPath - Path to the plugin module, resolved relative to `baseDir`.
   * @param baseDir - Base directory for resolving `pluginPath` (default `process.cwd()`).
   * @throws {ExternalSchemaError} When the plugin file cannot be found or imported.
   */
  public static async load(pluginPath: string, baseDir?: string): Promise<void> {
    await defaultRegistry.load(pluginPath, baseDir);
  }

  /**
   * Loads multiple plugin files in sequence into the global default registry.
   *
   * @param paths - Array of plugin paths to load.
   * @param baseDir - Base directory for resolving paths.
   * @throws {ExternalSchemaError} When any plugin file cannot be found or imported.
   */
  public static async loadAll(paths: ReadonlyArray<string>, baseDir?: string): Promise<void> {
    await defaultRegistry.loadAll(paths, baseDir);
  }
}

// ---------------------------------------------------------------------------
// Module-private default registry (singleton)
// ---------------------------------------------------------------------------

/**
 * Module-private singleton that backs all static `TaskRegistry.*` calls.
 *
 * @remarks
 * Side-effect imports of plugin files (e.g. `src/tasks/index.js`) call
 * `TaskRegistry.register(...)` which delegates here. Per-run registries created
 * via `new TaskRegistry()` are completely independent of this instance.
 */
const defaultRegistry = new TaskRegistry();
