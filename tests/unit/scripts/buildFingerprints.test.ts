/**
 * @fileoverview Unit tests for the `build-fingerprints` offline trainer script.
 *
 * @remarks
 * Tests the key-union logic: given a temp dir with `feat-power.json` (keys: name,
 * level) and `feat-quick.json` (keys: name, level, rarity), the output fingerprint
 * for `feat` should be the UNION -- name, level, rarity (sorted).
 *
 * Also tests: multiple class files in one directory, and sorted output.
 *
 * @module tests/unit/scripts/buildFingerprints
 * @category Scripts
 * @since 0.5.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// ── Suite-level temp directory ─────────────────────────────────────────────────

let rootDir = '';

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'sq-unit-bfp-'));
});

after(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────────

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/build-fingerprints.ts',
);

/**
 * Runs `build-fingerprints.ts` via tsx and returns the parsed output JSON.
 */
function runScript(
  recordsDir: string,
  outPath:    string,
): Record<string, { keys: string[]; weight: number }> {
  const result = spawnSync(
    'node_modules/.bin/tsx',
    [SCRIPT_PATH, '--records', recordsDir, '--out', outPath],
    { encoding: 'utf-8', cwd: process.cwd() },
  );

  if (result.status !== 0) {
    throw new Error(
      `build-fingerprints exited with status ${result.status ?? 'null'}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }

  return JSON.parse(readFileSync(outPath, 'utf-8')) as Record<
    string,
    { keys: string[]; weight: number }
  >;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('buildFingerprints -- union of keys across same-class records', () => {
  it('feat-power.json (name, level) + feat-quick.json (name, level, rarity) produces union {level, name, rarity}', async () => {
    const recordsDir = join(rootDir, 'union-test');
    const outPath    = join(rootDir, 'union-test-out.json');
    await mkdir(recordsDir, { recursive: true });

    await writeFile(
      join(recordsDir, 'feat-power.json'),
      JSON.stringify({ name: 'Power Attack', level: 1 }),
      'utf-8',
    );
    await writeFile(
      join(recordsDir, 'feat-quick.json'),
      JSON.stringify({ name: 'Quick Draw', level: 1, rarity: 'common' }),
      'utf-8',
    );

    const output = runScript(recordsDir, outPath);

    assert.ok('feat' in output, 'Output must have a "feat" key');

    const featEntry = output['feat']!;
    const keys      = [...featEntry.keys].sort();

    assert.deepStrictEqual(
      keys,
      ['level', 'name', 'rarity'],
      `Expected union keys [level, name, rarity]; got ${JSON.stringify(keys)}`,
    );
  });
});

describe('buildFingerprints -- multiple classes in same directory', () => {
  it('feat and spell records each get their own fingerprint entry', async () => {
    const recordsDir = join(rootDir, 'multi-class');
    const outPath    = join(rootDir, 'multi-class-out.json');
    await mkdir(recordsDir, { recursive: true });

    await writeFile(
      join(recordsDir, 'feat-power.json'),
      JSON.stringify({ name: 'Power Attack', level: 1, rarity: 'common', action_cost: 'two-actions' }),
      'utf-8',
    );
    await writeFile(
      join(recordsDir, 'spell-fireball.json'),
      JSON.stringify({ name: 'Fireball', level: 3, traditions: ['arcane'], range: '500 feet' }),
      'utf-8',
    );

    const output = runScript(recordsDir, outPath);

    assert.ok('feat' in output, 'Output must have a "feat" key');
    assert.ok('spell' in output, 'Output must have a "spell" key');

    const featKeys  = [...(output['feat']!.keys)].sort();
    const spellKeys = [...(output['spell']!.keys)].sort();

    assert.deepStrictEqual(featKeys, ['action_cost', 'level', 'name', 'rarity']);
    assert.deepStrictEqual(spellKeys, ['level', 'name', 'range', 'traditions']);
  });
});

describe('buildFingerprints -- keys are sorted in output', () => {
  it('output keys array is sorted lexicographically', async () => {
    const recordsDir = join(rootDir, 'sorted-keys');
    const outPath    = join(rootDir, 'sorted-keys-out.json');
    await mkdir(recordsDir, { recursive: true });

    await writeFile(
      join(recordsDir, 'widget-one.json'),
      JSON.stringify({ zzz: 1, aaa: 2, mmm: 3 }),
      'utf-8',
    );

    const output = runScript(recordsDir, outPath);

    assert.ok('widget' in output, 'Output must have a "widget" key');
    const keys = output['widget']!.keys;
    assert.deepStrictEqual(keys, ['aaa', 'mmm', 'zzz'], 'keys must be sorted lexicographically');
  });
});
