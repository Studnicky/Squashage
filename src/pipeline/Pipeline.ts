import type { NextFnInterface, TaskFnInterface, PipelineConfigInterface } from '../types/Pipeline.js';
import { TaskRegistry } from '../registry/TaskRegistry.js';
import { Logger } from '../modules/logger/logger.js';

export { type NextFnInterface, type TaskFnInterface, type PipelineConfigInterface };

/**
 * Ordered async middleware queue that passes shared state through each task in sequence.
 *
 * @remarks
 * Tasks are called in insertion order; each task receives a `next` function it must call
 * to advance the queue. Shared `state` is mutable across tasks.
 *
 * An optional per-run {@link TaskRegistry} instance may be supplied as the second
 * constructor argument. When present, {@link Pipeline.addTaskByName} resolves task
 * names against that instance rather than the global default registry. This enables
 * per-target isolation: two concurrent runs can each carry their own registry whose
 * task maps do not overlap.
 *
 * @example Without registry (back-compat):
 * ```ts
 * const pipeline = new Pipeline<MyState>({ name: 'scrape' });
 * pipeline.addTasks([taskA, taskB]);
 * const result = await pipeline.execute({ url: 'https://example.com' });
 * ```
 *
 * @example With per-run registry:
 * ```ts
 * const registry = new TaskRegistry();
 * registry.register('classify:rules', classifyTask);
 * const pipeline = new Pipeline<PipelineStateInterface>({ name: 'run' }, registry);
 * pipeline.addTaskByName('json:read');
 * pipeline.addTaskByName('classify:rules');
 * ```
 *
 * @category Pipeline
 * @since 2.0.0
 * @see {@link TaskFnInterface}
 * @group Core
 */
export class Pipeline<TState extends Record<string, unknown>> {
  readonly #name:     string;
  readonly #queue:    TaskFnInterface<TState>[] = [];
  readonly #log:      Logger;
  readonly #registry: TaskRegistry | undefined;

  /**
   * Creates a Pipeline instance.
   *
   * @param config   - Optional name used for logging (defaults to `"Pipeline"`).
   * @param registry - Optional per-run registry instance. When supplied,
   *   {@link Pipeline.addTaskByName} resolves names against this instance; when
   *   omitted it falls back to `TaskRegistry.get(name)` (global default).
   */
  public constructor(config: PipelineConfigInterface = {}, registry?: TaskRegistry) {
    this.#name     = config.name ?? 'Pipeline';
    this.#log      = Logger.forComponent(this.#name);
    this.#registry = registry;
  }

  /**
   * Creates a Pipeline instance.
   *
   * @param config   - Optional pipeline name configuration.
   * @param registry - Optional per-run registry instance.
   * @returns A new Pipeline instance.
   *
   * @deprecated Prefer `new Pipeline(config, registry)`. `Pipeline.create` is
   *   retained for back-compat with existing call sites.
   */
  public static create<TState extends Record<string, unknown>>(
    config:   PipelineConfigInterface = {},
    registry?: TaskRegistry,
  ): Pipeline<TState> {
    return new Pipeline<TState>(config, registry);
  }

  /**
   * Appends a single task to the pipeline queue.
   *
   * @param task - Task function to add.
   * @returns `this` for fluent chaining.
   */
  addTask(task: TaskFnInterface<TState>): this {
    this.#queue.push(task);
    return this;
  }

  /**
   * Appends multiple tasks to the pipeline queue in order.
   *
   * @param tasks - Array of task functions to add.
   * @returns `this` for fluent chaining.
   */
  addTasks(tasks: ReadonlyArray<TaskFnInterface<TState>>): this {
    for (const task of tasks) this.addTask(task);
    return this;
  }

  /**
   * Resolves a task by name and appends it to the pipeline queue.
   *
   * @remarks
   * When a per-run `registry` was supplied to the constructor, this method looks
   * up `name` on that instance. Otherwise it falls back to the static
   * `TaskRegistry.get(name)` surface (global default registry). This enables
   * per-run isolation: tasks registered on a custom instance are invisible to
   * other concurrent pipelines that rely only on the global default registry.
   *
   * @param name - Registered task name (conventionally `"target:operation"`).
   * @returns `this` for fluent chaining.
   * @throws {ExternalSchemaError} When no task is registered under `name`.
   */
  addTaskByName(name: string): this {
    const task = this.#registry !== undefined
      ? this.#registry.get(name)
      : TaskRegistry.get(name);
    return this.addTask(task as unknown as TaskFnInterface<TState>);
  }

  /**
   * Runs all queued tasks in order, passing shared state through each one.
   *
   * @param state - Initial state object mutated and returned by the pipeline.
   * @returns The same `state` object after all tasks have run.
   */
  async execute(state: TState): Promise<TState> {
    this.#log.debug('execute', `Running ${this.#queue.length.toString()} tasks`);

    const run = async (index: number): Promise<void> => {
      const task = this.#queue[index];
      if (task === undefined) return;
      await task((): Promise<void> => run(index + 1), state);
    };

    await run(0);
    return state;
  }
}
