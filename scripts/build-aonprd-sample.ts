/**
 * build-aonprd-sample.ts
 *
 * Selects a stratified sample of ~200 records from the full aonprd ripper output,
 * covering all 16 classifier classes (≤15 records per class), then copies them
 * into /tmp/aonprd-sample/.
 *
 * Usage:
 *   node --import tsx scripts/build-aonprd-sample.ts
 *
 * Output: copies up to 15 records per aspx-prefix to /tmp/aonprd-sample/,
 * prints count + class breakdown.
 */

import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const SRC_DIR  = '/Users/studs/Workspace/ripper/output-improved/aonprd/aonprd/aonprd:parse';
const OUT_DIR  = '/tmp/aonprd-sample';
const PER_CLASS = 15;

// Map from aspx prefix → classifier class name (matches aonprd.config.json url-patterns).
const PREFIX_CLASS_MAP: Record<string, string> = {
  'Actions.aspx':       'action',
  'Armor.aspx':         'armor',
  'Ancestries.aspx':    'ancestry',
  'Backgrounds.aspx':   'background',
  'Classes.aspx':       'class',
  'Conditions.aspx':    'condition',
  'Equipment.aspx':     'equipment',
  'Feats.aspx':         'feat',
  'Hazards.aspx':       'hazard',
  'Monsters.aspx':      'monster',
  'MonsterFamilies.aspx': 'MonsterFamily',
  'Shields.aspx':       'shield',
  'Spells.aspx':        'spell',
  'Traits.aspx':        'trait',
  'Weapons.aspx':       'weapon',
  'Rules.aspx':         'rule',
};

// Anything else → generic (deities, NPCs, archetypes, etc.)
const GENERIC_PREFIXES = [
  'Deities.aspx',
  'NPCs.aspx',
  'Archetypes.aspx',
  'Sources.aspx',
  'Familiars.aspx',
  'Languages.aspx',
];

async function main(): Promise<void> {
  // Wipe and recreate target directory
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const allFiles = await readdir(SRC_DIR);
  const jsonFiles = allFiles.filter((f) => f.endsWith('.json') && f !== 'failures.json');

  // Group by prefix
  const byPrefix = new Map<string, string[]>();
  for (const f of jsonFiles) {
    const prefix = f.includes('-ID-') ? f.split('-ID-')[0] + '.aspx' : f;
    const key = Object.keys(PREFIX_CLASS_MAP).find((p) => prefix.startsWith(p.replace('.aspx', '')));
    const genericKey = GENERIC_PREFIXES.find((p) => prefix.startsWith(p.replace('.aspx', '')));

    const bucket = key ?? (genericKey !== undefined ? 'generic' : 'other');
    if (!byPrefix.has(bucket)) byPrefix.set(bucket, []);
    byPrefix.get(bucket)!.push(f);
  }

  const copiedByClass: Record<string, number> = {};
  let totalCopied = 0;

  // Copy up to PER_CLASS files per canonical class
  const classKeys = [...Object.keys(PREFIX_CLASS_MAP), 'generic'];

  for (const bucket of classKeys) {
    const className = PREFIX_CLASS_MAP[bucket] ?? bucket;
    const files = byPrefix.get(bucket) ?? [];
    // Stable sort for reproducibility
    const sorted = files.slice().sort();
    const selected = sorted.slice(0, PER_CLASS);

    for (const f of selected) {
      await copyFile(join(SRC_DIR, f), join(OUT_DIR, f));
      totalCopied++;
    }

    copiedByClass[className] = selected.length;
  }

  process.stdout.write(`\nAONPRD sample written to ${OUT_DIR}\n`);
  process.stdout.write(`Total records: ${String(totalCopied)}\n\n`);
  process.stdout.write('Class breakdown:\n');
  for (const [cls, cnt] of Object.entries(copiedByClass)) {
    process.stdout.write(`  ${cls.padEnd(20)} ${String(cnt).padStart(3)} records\n`);
  }
  process.stdout.write('\n');
}

main().catch((err: unknown) => {
  process.stderr.write(String(err instanceof Error ? err.message : err) + '\n');
  process.exit(1);
});
