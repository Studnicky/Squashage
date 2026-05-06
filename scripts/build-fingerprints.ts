/**
 * @fileoverview Offline fingerprint trainer script.
 *
 * @remarks
 * Reads a flat directory of labeled JSON records (each filename following the
 * pattern `<className>-<rest>.json`) and computes the UNION of top-level key sets
 * per className. Writes the resulting fingerprints JSON to the configured output
 * path in the format consumed by {@link PropertyFingerprintClassifier}.
 *
 * CLI:
 * ```
 * tsx scripts/build-fingerprints.ts --records <dir> --out <path>
 * ```
 *
 * Filename parsing: `<className>-<rest>.json` -> className from the text before
 * the first hyphen.
 *
 * Output shape:
 * ```json
 * {
 *   "feat": { "keys": ["name", "level", "rarity"], "weight": 1 },
 *   "spell": { "keys": ["name", "level", "traditions"], "weight": 1 }
 * }
 * ```
 *
 * @module scripts/build-fingerprints
 * @since 0.5.0
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, basename, extname }                  from 'node:path';

// ── Argument parsing ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const recordsDir = getArg('--records');
const outPath    = getArg('--out');

if (recordsDir === undefined || outPath === undefined) {
  process.stderr.write(
    'Usage: tsx scripts/build-fingerprints.ts --records <dir> --out <path>\n',
  );
  process.exit(1);
}

// ── Class name derivation ──────────────────────────────────────────────────────

/**
 * Derives the className from a filename of the form `<className>-<rest>.json`.
 * Returns the text before the first hyphen. If no hyphen is present, the full
 * basename (without extension) is used as the className.
 *
 * @param filename - Filename with or without path components.
 * @returns Derived className string.
 */
function classNameFromFilename(filename: string): string {
  const base  = basename(filename, extname(filename));
  const hyphen = base.indexOf('-');
  return hyphen === -1 ? base : base.slice(0, hyphen);
}

// ── Walk records directory ─────────────────────────────────────────────────────

const entries = readdirSync(recordsDir, { withFileTypes: true });
const jsonFiles = entries
  .filter(e => e.isFile() && extname(e.name).toLowerCase() === '.json')
  .map(e => e.name);

if (jsonFiles.length === 0) {
  process.stderr.write(`No .json files found in "${recordsDir}"\n`);
  process.exit(1);
}

// ── Accumulate key unions per className ───────────────────────────────────────

const keyUnions = new Map<string, Set<string>>();

for (const filename of jsonFiles) {
  const className = classNameFromFilename(filename);
  const filePath  = join(recordsDir, filename);

  let record: unknown;
  try {
    const text = readFileSync(filePath, 'utf-8');
    record = JSON.parse(text) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Warning: skipping "${filename}" -- parse error: ${msg}\n`);
    continue;
  }

  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    process.stderr.write(`Warning: skipping "${filename}" -- not a JSON object\n`);
    continue;
  }

  const keys = Object.keys(record as Record<string, unknown>);

  if (!keyUnions.has(className)) {
    keyUnions.set(className, new Set<string>());
  }
  const unionSet = keyUnions.get(className)!;
  for (const key of keys) {
    unionSet.add(key);
  }
}

if (keyUnions.size === 0) {
  process.stderr.write('No valid records were processed; output not written.\n');
  process.exit(1);
}

// ── Build output object ────────────────────────────────────────────────────────

const output: Record<string, { keys: string[]; weight: number }> = {};

for (const [className, keySet] of keyUnions) {
  output[className] = {
    keys:   [...keySet].sort(),
    weight: 1,
  };
}

// ── Write output ───────────────────────────────────────────────────────────────

try {
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: cannot write output to "${outPath}": ${msg}\n`);
  process.exit(1);
}

const summary = [...keyUnions.entries()]
  .map(([cn, ks]) => `  ${cn}: ${ks.size} keys`)
  .join('\n');

process.stdout.write(
  `Fingerprints written to ${outPath}\n${summary}\n`,
);
