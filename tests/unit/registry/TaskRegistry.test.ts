import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import { TaskRegistry } from '../../../src/registry/TaskRegistry.js';
import { ExternalSchemaError } from '../../../src/errors/ExternalSchemaError.js';

describe('TaskRegistry', () => {
  afterEach(() => { TaskRegistry.reset(); });

  it('register() adds a task; has() returns true; get() returns it', () => {
    const task = async (_next: () => Promise<void>, _state: Record<string, unknown>): Promise<void> => { /* noop */ };
    TaskRegistry.register('myTask', task);
    assert.equal(TaskRegistry.has('myTask'), true);
    assert.equal(TaskRegistry.get('myTask'), task);
  });

  it('register() same name twice overwrites silently; get() returns the second task', () => {
    const taskA = async (_next: () => Promise<void>, _state: Record<string, unknown>): Promise<void> => { /* noop A */ };
    const taskB = async (_next: () => Promise<void>, _state: Record<string, unknown>): Promise<void> => { /* noop B */ };
    TaskRegistry.register('dupTask', taskA);
    TaskRegistry.register('dupTask', taskB);
    assert.equal(TaskRegistry.get('dupTask'), taskB);
  });

  it('get() unknown name throws ExternalSchemaError', () => {
    assert.throws(
      () => TaskRegistry.get('unknownTask'),
      (err: unknown) => err instanceof ExternalSchemaError,
    );
  });

  it('reset() clears all registrations', () => {
    const task = async (_next: () => Promise<void>, _state: Record<string, unknown>): Promise<void> => { /* noop */ };
    TaskRegistry.register('toBeCleared', task);
    assert.equal(TaskRegistry.has('toBeCleared'), true);
    TaskRegistry.reset();
    assert.equal(TaskRegistry.has('toBeCleared'), false);
  });

  it('loadAll([]) resolves without error', async () => {
    await assert.doesNotReject(TaskRegistry.loadAll([]));
  });

  it('load() with a nonexistent path throws ExternalSchemaError', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'squashage-registry-'));
    try {
      await assert.rejects(
        TaskRegistry.load('does-not-exist-plugin.js', tmpDir),
        (err: unknown) => err instanceof ExternalSchemaError,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('load() throws ExternalSchemaError on a missing file', async () => {
    await assert.rejects(
      TaskRegistry.load('does-not-exist.mjs', '/tmp'),
      (err: unknown) => err instanceof Error && err.constructor.name === 'ExternalSchemaError',
    );
  });
});

describe('TaskRegistry — instance isolation', () => {
  afterEach(() => { TaskRegistry.reset(); });

  it('new TaskRegistry() creates an isolated instance; registering on it does not affect the static default', () => {
    const noop = async (_next: () => Promise<void>, _state: Record<string, unknown>): Promise<void> => { /* noop */ };
    const instance = new TaskRegistry();
    instance.register('instance:only', noop);

    // Static default must not see the instance registration.
    assert.equal(TaskRegistry.has('instance:only'), false);
    assert.throws(
      () => TaskRegistry.get('instance:only'),
      (err: unknown) => err instanceof ExternalSchemaError,
    );

    // Instance must see its own registration.
    assert.equal(instance.has('instance:only'), true);
    assert.equal(instance.get('instance:only'), noop);
  });

  it('static TaskRegistry.register() populates the default and is visible via static .get(), but a fresh instance does not see it', () => {
    const noop = async (_next: () => Promise<void>, _state: Record<string, unknown>): Promise<void> => { /* noop */ };
    TaskRegistry.register('default:only', noop);

    // Static surface sees it.
    assert.equal(TaskRegistry.has('default:only'), true);
    assert.equal(TaskRegistry.get('default:only'), noop);

    // A fresh instance is empty — it does not inherit from the default.
    const fresh = new TaskRegistry();
    assert.equal(fresh.has('default:only'), false);
    assert.throws(
      () => fresh.get('default:only'),
      (err: unknown) => err instanceof ExternalSchemaError,
    );
  });

  it('instance.reset() clears only that instance; static default is unaffected', () => {
    const noop = async (_next: () => Promise<void>, _state: Record<string, unknown>): Promise<void> => { /* noop */ };
    const instance = new TaskRegistry();
    instance.register('inst:task', noop);
    TaskRegistry.register('default:task', noop);

    instance.reset();

    // Instance is cleared.
    assert.equal(instance.has('inst:task'), false);

    // Static default is unaffected.
    assert.equal(TaskRegistry.has('default:task'), true);
  });

  it('two instances are isolated from each other', () => {
    const taskA = async (_next: () => Promise<void>, _state: Record<string, unknown>): Promise<void> => { /* A */ };
    const taskB = async (_next: () => Promise<void>, _state: Record<string, unknown>): Promise<void> => { /* B */ };

    const regA = new TaskRegistry();
    const regB = new TaskRegistry();

    regA.register('shared:name', taskA);
    regB.register('shared:name', taskB);

    // Each instance resolves to its own task function.
    assert.equal(regA.get('shared:name'), taskA);
    assert.equal(regB.get('shared:name'), taskB);

    // Neither instance can see the other's registration under a different name.
    regA.register('a:exclusive', taskA);
    assert.equal(regA.has('a:exclusive'), true);
    assert.equal(regB.has('a:exclusive'), false);
  });
});
