/**
 * @fileoverview Unit tests for the squashage CLI {@link buildCli} factory.
 *
 * @remarks
 * These are pure Commander parsing tests — no subprocess spawning, no actual
 * filesystem I/O, and no pipeline execution. The goal is to verify that:
 *
 * 1. `buildCli()` returns a Commander {@link Command} with `build`, `classify`,
 *    and `inspect` subcommands visible in `--help` output.
 * 2. The `build` subcommand recognises `--target`, `--config`, `--in`, `--out`,
 *    `--format`, and `--dry-run` flags and maps them to the expected option shapes.
 * 3. The `classify` subcommand recognises `--target`, `--config`, and `--in`.
 * 4. The `inspect` subcommand recognises `--file` and `--config`.
 * 5. Missing required options cause Commander to emit an error rather than
 *    silently ignoring them.
 *
 * Full end-to-end pipeline execution is covered by the I1 integration test.
 *
 * @category CLI
 * @since 0.1.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCli } from '../../../src/cli/cli.js';

// ---------------------------------------------------------------------------
// --help surface
// ---------------------------------------------------------------------------

describe('buildCli() — help output', () => {
  it('contains build, classify, and inspect in --help', async () => {
    const cli = buildCli();
    cli.exitOverride();
    let helpText = '';
    cli.configureOutput({ writeOut: (s: string) => { helpText += s; } });
    try {
      await cli.parseAsync(['node', 'squashage', '--help']);
    } catch {
      // Commander throws after printing help with exitOverride active.
    }
    assert.match(helpText, /build/);
    assert.match(helpText, /classify/);
    assert.match(helpText, /inspect/);
  });
});

// ---------------------------------------------------------------------------
// build — option recognition
// ---------------------------------------------------------------------------

describe('buildCli() — build subcommand', () => {
  it('parses --target and --config', async () => {
    let capturedOpts: Record<string, unknown> = {};
    const cli = buildCli();
    cli.exitOverride();
    const buildCmd = cli.commands.find(c => c.name() === 'build');
    assert.ok(buildCmd !== undefined, 'build subcommand must exist');
    buildCmd.exitOverride();
    buildCmd.action((opts: Record<string, unknown>) => { capturedOpts = opts; });

    await cli.parseAsync([
      'node', 'squashage', 'build',
      '--target', 'aonprd',
      '--config', '/tmp/sq.json',
    ]);

    assert.equal(capturedOpts['target'], 'aonprd');
    assert.equal(capturedOpts['config'], '/tmp/sq.json');
  });

  it('parses --out flag', async () => {
    let capturedOpts: Record<string, unknown> = {};
    const cli = buildCli();
    cli.exitOverride();
    const buildCmd = cli.commands.find(c => c.name() === 'build');
    assert.ok(buildCmd !== undefined);
    buildCmd.exitOverride();
    buildCmd.action((opts: Record<string, unknown>) => { capturedOpts = opts; });

    await cli.parseAsync([
      'node', 'squashage', 'build',
      '--target', 'x',
      '--config', '/tmp/fake.json',
      '--out', '/tmp/out.trig',
    ]);

    assert.equal(capturedOpts['out'], '/tmp/out.trig');
  });

  it('parses --format flag', async () => {
    let capturedOpts: Record<string, unknown> = {};
    const cli = buildCli();
    cli.exitOverride();
    const buildCmd = cli.commands.find(c => c.name() === 'build');
    assert.ok(buildCmd !== undefined);
    buildCmd.exitOverride();
    buildCmd.action((opts: Record<string, unknown>) => { capturedOpts = opts; });

    await cli.parseAsync([
      'node', 'squashage', 'build',
      '--target', 'x',
      '--config', '/tmp/fake.json',
      '--format', 'turtle',
    ]);

    assert.equal(capturedOpts['format'], 'turtle');
  });

  it('parses --dry-run flag', async () => {
    let capturedOpts: Record<string, unknown> = {};
    const cli = buildCli();
    cli.exitOverride();
    const buildCmd = cli.commands.find(c => c.name() === 'build');
    assert.ok(buildCmd !== undefined);
    buildCmd.exitOverride();
    buildCmd.action((opts: Record<string, unknown>) => { capturedOpts = opts; });

    await cli.parseAsync([
      'node', 'squashage', 'build',
      '--target', 'x',
      '--config', '/tmp/fake.json',
      '--dry-run',
    ]);

    assert.equal(capturedOpts['dryRun'], true);
  });

  it('parses --in flag', async () => {
    let capturedOpts: Record<string, unknown> = {};
    const cli = buildCli();
    cli.exitOverride();
    const buildCmd = cli.commands.find(c => c.name() === 'build');
    assert.ok(buildCmd !== undefined);
    buildCmd.exitOverride();
    buildCmd.action((opts: Record<string, unknown>) => { capturedOpts = opts; });

    await cli.parseAsync([
      'node', 'squashage', 'build',
      '--target', 'x',
      '--config', '/tmp/fake.json',
      '--in', '/data/input',
    ]);

    assert.equal(capturedOpts['in'], '/data/input');
  });

  it('applies default config path when --config is omitted', async () => {
    let capturedOpts: Record<string, unknown> = {};
    const cli = buildCli();
    cli.exitOverride();
    const buildCmd = cli.commands.find(c => c.name() === 'build');
    assert.ok(buildCmd !== undefined);
    buildCmd.exitOverride();
    buildCmd.action((opts: Record<string, unknown>) => { capturedOpts = opts; });

    await cli.parseAsync([
      'node', 'squashage', 'build',
      '--target', 'x',
    ]);

    assert.equal(capturedOpts['config'], './squashage.config.json');
  });

  it('throws when --target is missing', async () => {
    const cli = buildCli();
    cli.exitOverride();
    const buildCmd = cli.commands.find(c => c.name() === 'build');
    assert.ok(buildCmd !== undefined);
    buildCmd.exitOverride();

    await assert.rejects(
      async () => cli.parseAsync(['node', 'squashage', 'build', '--config', '/tmp/x.json']),
      /required option/i,
    );
  });
});

// ---------------------------------------------------------------------------
// classify — option recognition
// ---------------------------------------------------------------------------

describe('buildCli() — classify subcommand', () => {
  it('parses --target, --config, and --in', async () => {
    let capturedOpts: Record<string, unknown> = {};
    const cli = buildCli();
    cli.exitOverride();
    const classifyCmd = cli.commands.find(c => c.name() === 'classify');
    assert.ok(classifyCmd !== undefined, 'classify subcommand must exist');
    classifyCmd.exitOverride();
    classifyCmd.action((opts: Record<string, unknown>) => { capturedOpts = opts; });

    await cli.parseAsync([
      'node', 'squashage', 'classify',
      '--target', 'aonprd',
      '--config', '/tmp/sq.json',
      '--in', '/data/records',
    ]);

    assert.equal(capturedOpts['target'], 'aonprd');
    assert.equal(capturedOpts['config'], '/tmp/sq.json');
    assert.equal(capturedOpts['in'], '/data/records');
  });
});

// ---------------------------------------------------------------------------
// inspect — option recognition
// ---------------------------------------------------------------------------

describe('buildCli() — inspect subcommand', () => {
  it('parses --file and --config', async () => {
    let capturedOpts: Record<string, unknown> = {};
    const cli = buildCli();
    cli.exitOverride();
    const inspectCmd = cli.commands.find(c => c.name() === 'inspect');
    assert.ok(inspectCmd !== undefined, 'inspect subcommand must exist');
    inspectCmd.exitOverride();
    inspectCmd.action((opts: Record<string, unknown>) => { capturedOpts = opts; });

    await cli.parseAsync([
      'node', 'squashage', 'inspect',
      '--file', '/tmp/record.json',
      '--config', '/tmp/sq.json',
    ]);

    assert.equal(capturedOpts['file'], '/tmp/record.json');
    assert.equal(capturedOpts['config'], '/tmp/sq.json');
  });

  it('throws when --file is missing', async () => {
    const cli = buildCli();
    cli.exitOverride();
    const inspectCmd = cli.commands.find(c => c.name() === 'inspect');
    assert.ok(inspectCmd !== undefined);
    inspectCmd.exitOverride();

    await assert.rejects(
      async () => cli.parseAsync(['node', 'squashage', 'inspect']),
      /required option/i,
    );
  });
});
