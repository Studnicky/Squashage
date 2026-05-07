import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Pipeline } from '../../../src/pipeline/Pipeline.js';

interface State extends Record<string, unknown> {
  log: string[];
}

describe('Pipeline', () => {
  it('returns state unchanged when no tasks are queued', async () => {
    const p = new Pipeline<State>();
    const state: State = { log: [] };
    const result = await p.execute(state);
    assert.deepEqual(result.log, []);
  });

  it('runs a single task that calls next()', async () => {
    const p = new Pipeline<State>();
    p.addTask(async (next, state) => {
      state.log.push('a');
      await next();
    });
    const state: State = { log: [] };
    await p.execute(state);
    assert.deepEqual(state.log, ['a']);
  });

  it('runs queued tasks in declaration order', async () => {
    const p = new Pipeline<State>();
    p.addTasks([
      async (next, state) => { state.log.push('a'); await next(); },
      async (next, state) => { state.log.push('b'); await next(); },
      async (next, state) => { state.log.push('c'); await next(); },
    ]);
    const state: State = { log: [] };
    await p.execute(state);
    assert.deepEqual(state.log, ['a', 'b', 'c']);
  });

  it('halts the chain when a task does NOT call next()', async () => {
    const p = new Pipeline<State>();
    p.addTask(async (_next, state) => { state.log.push('a'); });   // no next()
    p.addTask(async (next,  state) => { state.log.push('b'); await next(); });
    const state: State = { log: [] };
    await p.execute(state);
    assert.deepEqual(state.log, ['a']);
  });

  it('propagates errors thrown from a task', async () => {
    const p = new Pipeline<State>();
    p.addTask(async () => { throw new Error('boom'); });
    await assert.rejects(p.execute({ log: [] }), /boom/);
  });
});

import { TaskRegistry } from '../../../src/registry/TaskRegistry.js';
import { ExternalSchemaError } from '../../../src/errors/ExternalSchemaError.js';

describe('Pipeline — per-run registry', () => {
  it('addTaskByName resolves a task that exists ONLY on the custom registry, not on the static default', async () => {
    const registry = new TaskRegistry();
    const log: string[] = [];
    const privateTask = async (next: () => Promise<void>, state: State): Promise<void> => {
      state.log.push('private');
      await next();
    };

    // Register the task on the custom instance only — NOT on the static default.
    registry.register('private:task', privateTask);
    assert.equal(TaskRegistry.has('private:task'), false, 'Static default must not see private:task');

    // Build a Pipeline backed by the custom registry.
    const p = new Pipeline<State>({ name: 'isolated' }, registry);
    p.addTaskByName('private:task');

    const state: State = { log };
    await p.execute(state);

    assert.deepEqual(state.log, ['private']);
  });

  it('addTaskByName falls back to the static default when no registry is supplied', async () => {
    const noop = async (next: () => Promise<void>, state: State): Promise<void> => {
      state.log.push('static');
      await next();
    };
    TaskRegistry.register('static:task', noop);

    try {
      const p = new Pipeline<State>({ name: 'no-registry' });
      p.addTaskByName('static:task');

      const state: State = { log: [] };
      await p.execute(state);

      assert.deepEqual(state.log, ['static']);
    } finally {
      TaskRegistry.reset();
    }
  });

  it('addTaskByName throws ExternalSchemaError for unknown name on custom registry', () => {
    const registry = new TaskRegistry();
    const p = new Pipeline<State>({}, registry);
    assert.throws(
      () => p.addTaskByName('does:not:exist'),
      (err: unknown) => err instanceof ExternalSchemaError,
    );
  });
});
