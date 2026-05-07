/**
 * @fileoverview End-to-end test suite: Pathfinder/aonprd pipeline.
 *
 * @remarks
 * Proves PrefixResolver deterministic prefix derivation and JsonldContext
 * auto-context pipeline work end-to-end without hardcoded IRIs in config.
 *
 * Test mode: programmatic (SquashageOrchestrator imported directly).
 * All invocations use SquashageOrchestrator.run() directly.
 *
 * OntologyClassifier deviation:
 * AJV schema requires ontology.classes values to be valid URIs (format: uri).
 * The fixture config uses the synthetic fallback IRIs that PrefixResolver emits
 * (https://squashage.dev/vocabulary/aonprd#Feat etc.) in the classes map.
 * The plugin derives class IRIs at runtime from state.context.prefixes — no
 * IRIs are hardcoded in the plugin code. Only the AJV-validated classes map
 * in the config contains the fallback IRI strings.
 *
 * JSON-LD structure:
 * instances.prefix === vocabulary.prefix === 'aonprd'. The vocabulary entry
 * overwrites instances in the @context seed map (last-write wins). Result:
 * @context['aonprd'] === 'https://squashage.dev/vocabulary/aonprd#'.
 * Term keys are prefixed: 'aonprd:name', 'aonprd:level', etc.
 * @graph entries are named-graph wrappers: { "@id": graphIRI, "@graph": [...] }.
 *
 * @module tests/e2e/aonprd
 * @category E2E
 * @since 0.1.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, rm, mkdir, copyFile, readFile, readdir, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SquashageOrchestrator } from '../../src/orchestrators/SquashageOrchestrator.js';
import { SquashageConfig }       from '../../src/config/SquashageConfig.js';
import { registerAonprdPlugin }  from './aonprd/plugin.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET     = 'aonprd';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const FIXTURE_DIR = resolve(__dirname, 'aonprd');

const INPUT_FILES = [
  'feat-power-attack.json',
  'feat-toughness.json',
  'feat-quick-draw.json',
  'spell-fireball.json',
  'spell-heal.json',
  'monster-goblin-warrior.json',
  'monster-ancient-dragon.json',
  'action-stride.json',
  'equipment-longsword.json',
  'equipment-healing-potion.json',
  'unknown-classless.json',
  'tie-feat-spell.json',
  'malformed.jsonl',
] as const;

const SCHEMA_FILES = [
  'feat.schema.json', 'spell.schema.json', 'monster.schema.json',
  'action.schema.json', 'equipment.schema.json',
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EntityInterface extends Record<string, unknown> {
  '@id': string;
  '@type'?: string | string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupTmpFixture(root: string): Promise<{
  inputDir: string; outDir: string; configPath: string; outputPath: string;
}> {
  const inputDir   = join(root, 'input');
  const outDir     = join(root, 'graphs');
  const schemasDir = join(root, 'schemas');
  const outputPath = join(root, 'out', 'aonprd.jsonld');

  await mkdir(inputDir,          { recursive: true });
  await mkdir(outDir,            { recursive: true });
  await mkdir(schemasDir,        { recursive: true });
  await mkdir(join(root, 'out'), { recursive: true });

  for (const f of INPUT_FILES) {
    await copyFile(join(FIXTURE_DIR, 'input', f),   join(inputDir, f));
  }
  for (const f of SCHEMA_FILES) {
    await copyFile(join(FIXTURE_DIR, 'schemas', f), join(schemasDir, f));
  }

  const raw = JSON.parse(
    await readFile(join(FIXTURE_DIR, 'squashage.config.json'), 'utf8'),
  ) as Record<string, unknown>;

  const targets = raw['targets'] as Record<string, Record<string, unknown>>;
  targets[TARGET]!['input'] = inputDir;
  (targets[TARGET]!['output'] as Record<string, string>)['path'] = outputPath;

  const configPath = join(root, 'squashage.config.json');
  await writeFile(configPath, JSON.stringify(raw, null, 2), 'utf8');
  return { inputDir, outDir, configPath, outputPath };
}

function collectEntities(doc: Record<string, unknown>): EntityInterface[] {
  const outerGraph = doc['@graph'];
  if (!Array.isArray(outerGraph)) return [];
  const entities: EntityInterface[] = [];
  for (const entry of outerGraph) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (Array.isArray(e['@graph'])) {
      for (const inner of e['@graph'] as unknown[]) {
        if (inner !== null && typeof inner === 'object') {
          entities.push(inner as EntityInterface);
        }
      }
    } else if (typeof e['@id'] === 'string') {
      entities.push(e as EntityInterface);
    }
  }
  return entities;
}

function findEntity(entities: EntityInterface[], sub: string): EntityInterface | undefined {
  return entities.find(e => e['@id'].includes(sub));
}

function asIri(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v !== null && typeof v === 'object') {
    const id = (v as Record<string, unknown>)['@id'];
    if (typeof id === 'string') return id;
  }
  return undefined;
}

function asScalar(v: unknown): unknown {
  if (Array.isArray(v)) return v[0];
  if (v !== null && typeof v === 'object') {
    const val = (v as Record<string, unknown>)['@value'];
    if (val !== undefined) return val;
  }
  return v;
}

async function runBuild(paths: Awaited<ReturnType<typeof setupTmpFixture>>): Promise<void> {
  const config = SquashageConfig.loadFromFile(paths.configPath);
  await SquashageOrchestrator.run(config, TARGET, {
    outDir:        paths.outDir,
    configPath:    paths.configPath,
    inputOverride: paths.inputDir,
  });
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

before(() => { registerAonprdPlugin(); });

let rootDir = '';
before(async ()  => { rootDir = await mkdtemp(join(tmpdir(), 'sq-e2e-aonprd-')); });
after(async ()   => { await rm(rootDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Test 1: PrefixResolver auto-derivation
// ---------------------------------------------------------------------------

describe('aonprd e2e — PrefixResolver auto-derivation (no hardcoded IRIs)', () => {
  let ctx: Record<string, unknown> = {};

  before(async () => {
    const tmp   = await mkdtemp(join(tmpdir(), 'sq-e2e-prefix-'));
    const paths = await setupTmpFixture(tmp);
    await runBuild(paths);
    const doc = JSON.parse(await readFile(paths.outputPath, 'utf8')) as Record<string, unknown>;
    ctx = doc['@context'] as Record<string, unknown>;
  });

  it('@context is present', () => {
    assert.ok(ctx !== null && typeof ctx === 'object', '@context must be an object');
  });

  it('@context has aonprd prefix (derived from target name slug)', () => {
    assert.ok('aonprd' in ctx,
      `@context must have aonprd key; keys: ${Object.keys(ctx).join(', ')}`);
  });

  it('aonprd prefix maps to synthetic vocabulary namespace (PrefixResolver fallback)', () => {
    assert.equal(ctx['aonprd'], 'https://squashage.dev/vocabulary/aonprd#',
      `Expected aonprd → https://squashage.dev/vocabulary/aonprd#; got ${String(ctx['aonprd'])}`);
  });

  it('aonprdg prefix maps to synthetic graph namespace (PrefixResolver fallback)', () => {
    assert.equal(ctx['aonprdg'], 'https://squashage.dev/graph/aonprd/',
      `Expected aonprdg → https://squashage.dev/graph/aonprd/; got ${String(ctx['aonprdg'])}`);
  });

  it('fixture config has no ontology.prefixes (IRI derivation is automatic)', async () => {
    const raw    = JSON.parse(await readFile(join(FIXTURE_DIR, 'squashage.config.json'), 'utf8')) as Record<string, unknown>;
    const target = (raw['targets'] as Record<string, Record<string, unknown>>)[TARGET]!;
    const onto   = target['ontology'] as Record<string, unknown> | undefined;
    assert.equal(onto?.['prefixes'], undefined,
      'Config must not supply ontology.prefixes');
  });

  it('fixture config has no ontology.baseIri (IRI derivation is automatic)', async () => {
    const raw    = JSON.parse(await readFile(join(FIXTURE_DIR, 'squashage.config.json'), 'utf8')) as Record<string, unknown>;
    const target = (raw['targets'] as Record<string, Record<string, unknown>>)[TARGET]!;
    const onto   = target['ontology'] as Record<string, unknown> | undefined;
    assert.equal(onto?.['baseIri'], undefined,
      'Config must not supply ontology.baseIri');
  });
});

// ---------------------------------------------------------------------------
// Test 2: JsonldContext auto-inference
// ---------------------------------------------------------------------------

describe('aonprd e2e — JsonldContext auto-inference', () => {
  let ctx: Record<string, unknown> = {};

  before(async () => {
    const tmp   = await mkdtemp(join(tmpdir(), 'sq-e2e-ctx-'));
    const paths = await setupTmpFixture(tmp);
    await runBuild(paths);
    const doc = JSON.parse(await readFile(paths.outputPath, 'utf8')) as Record<string, unknown>;
    ctx = doc['@context'] as Record<string, unknown>;
  });

  it('@context has rdf prefix', () => {
    assert.equal(ctx['rdf'], 'http://www.w3.org/1999/02/22-rdf-syntax-ns#');
  });

  it('@context has xsd prefix', () => {
    assert.equal(ctx['xsd'], 'http://www.w3.org/2001/XMLSchema#');
  });

  it('aonprd:level entry has @type xsd:integer (auto-detected from integer literals)', () => {
    const entry = ctx['aonprd:level'] as Record<string, unknown> | undefined;
    assert.ok(entry !== undefined,
      `@context must have 'aonprd:level' entry; keys: ${Object.keys(ctx).join(', ')}`);
    assert.equal(entry['@type'], 'xsd:integer',
      `Expected @type xsd:integer; got ${JSON.stringify(entry)}`);
  });

  it('aonprd:rarity entry has @type @id (auto-detected: rarity is always NamedNode)', () => {
    const entry = ctx['aonprd:rarity'] as Record<string, unknown> | undefined;
    assert.ok(entry !== undefined,
      `@context must have 'aonprd:rarity' entry; keys: ${Object.keys(ctx).join(', ')}`);
    assert.equal(entry['@type'], '@id',
      `Expected @type @id; got ${JSON.stringify(entry)}`);
  });

  it('aonprd:trait entry has @container @set (auto-detected: Fireball has 2 traits → multi-value)', () => {
    const entry = ctx['aonprd:trait'] as Record<string, unknown> | undefined;
    assert.ok(entry !== undefined,
      `@context must have 'aonprd:trait' entry; keys: ${Object.keys(ctx).join(', ')}`);
    assert.equal(entry['@container'], '@set',
      `Expected @container @set; got ${JSON.stringify(entry)}`);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Per-class entity production (9 clean records classify and emit)
// ---------------------------------------------------------------------------

describe('aonprd e2e — per-class entity production (9 clean records)', () => {
  let entities: EntityInterface[] = [];

  before(async () => {
    const tmp   = await mkdtemp(join(tmpdir(), 'sq-e2e-entities-'));
    const paths = await setupTmpFixture(tmp);
    await runBuild(paths);
    const doc = JSON.parse(await readFile(paths.outputPath, 'utf8')) as Record<string, unknown>;
    entities  = collectEntities(doc);
  });

  it('Power Attack (feat) entity in output', () => {
    assert.ok(findEntity(entities, 'Feats.aspx?ID=750') !== undefined,
      `Missing Feats.aspx?ID=750; @ids: ${entities.map(e => e['@id']).join(', ')}`);
  });

  it('Power Attack has @type containing Feat', () => {
    const e = findEntity(entities, 'Feats.aspx?ID=750');
    const t = Array.isArray(e?.['@type']) ? (e['@type'] as string[]) : [e?.['@type'] as string];
    assert.ok(t.some(s => s?.includes('Feat')),
      `Expected @type Feat; got ${JSON.stringify(e?.['@type'])}`);
  });

  it('Fireball (spell) entity in output', () => {
    assert.ok(findEntity(entities, 'Spells.aspx?ID=119') !== undefined,
      'Missing Spells.aspx?ID=119');
  });

  it('Fireball has @type containing Spell', () => {
    const e = findEntity(entities, 'Spells.aspx?ID=119');
    const t = Array.isArray(e?.['@type']) ? (e['@type'] as string[]) : [e?.['@type'] as string];
    assert.ok(t.some(s => s?.includes('Spell')),
      `Expected @type Spell; got ${JSON.stringify(e?.['@type'])}`);
  });

  it('Goblin Warrior (monster) entity in output', () => {
    assert.ok(findEntity(entities, 'Monsters.aspx?ID=232') !== undefined,
      'Missing Monsters.aspx?ID=232');
  });

  it('Goblin Warrior has @type containing Monster', () => {
    const e = findEntity(entities, 'Monsters.aspx?ID=232');
    const t = Array.isArray(e?.['@type']) ? (e['@type'] as string[]) : [e?.['@type'] as string];
    assert.ok(t.some(s => s?.includes('Monster')),
      `Expected @type Monster; got ${JSON.stringify(e?.['@type'])}`);
  });

  it('Stride (action) entity in output', () => {
    assert.ok(findEntity(entities, 'Actions.aspx?ID=88') !== undefined,
      'Missing Actions.aspx?ID=88');
  });

  it('Stride has @type containing Action', () => {
    const e = findEntity(entities, 'Actions.aspx?ID=88');
    const t = Array.isArray(e?.['@type']) ? (e['@type'] as string[]) : [e?.['@type'] as string];
    assert.ok(t.some(s => s?.includes('Action')),
      `Expected @type Action; got ${JSON.stringify(e?.['@type'])}`);
  });

  it('Longsword (equipment) entity in output', () => {
    assert.ok(findEntity(entities, 'Weapons.aspx?ID=31') !== undefined,
      'Missing Weapons.aspx?ID=31');
  });

  it('Longsword has @type containing Equipment', () => {
    const e = findEntity(entities, 'Weapons.aspx?ID=31');
    const t = Array.isArray(e?.['@type']) ? (e['@type'] as string[]) : [e?.['@type'] as string];
    assert.ok(t.some(s => s?.includes('Equipment')),
      `Expected @type Equipment; got ${JSON.stringify(e?.['@type'])}`);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Per-class predicate fidelity
// ---------------------------------------------------------------------------

describe('aonprd e2e — per-class predicate fidelity', () => {
  let entities: EntityInterface[] = [];

  before(async () => {
    const tmp   = await mkdtemp(join(tmpdir(), 'sq-e2e-pred-'));
    const paths = await setupTmpFixture(tmp);
    await runBuild(paths);
    const doc = JSON.parse(await readFile(paths.outputPath, 'utf8')) as Record<string, unknown>;
    entities  = collectEntities(doc);
  });

  // Power Attack
  it('Power Attack: aonprd:name === "Power Attack"', () => {
    const e = findEntity(entities, 'Feats.aspx?ID=750');
    assert.ok(e !== undefined, 'Power Attack entity must exist');
    assert.equal(asScalar(e['aonprd:name']), 'Power Attack');
  });

  it('Power Attack: aonprd:level === 1', () => {
    const e = findEntity(entities, 'Feats.aspx?ID=750');
    assert.ok(e !== undefined, 'Power Attack entity must exist');
    assert.equal(Number(asScalar(e['aonprd:level'])), 1);
  });

  it('Power Attack: aonprd:rarity references Rarity-common', () => {
    const e = findEntity(entities, 'Feats.aspx?ID=750');
    assert.ok(e !== undefined, 'Power Attack entity must exist');
    assert.ok(
      asIri(e['aonprd:rarity'])?.includes('Rarity-common'),
      `Expected Rarity-common; got ${JSON.stringify(e['aonprd:rarity'])}`,
    );
  });

  it('Power Attack: aonprd:trait includes Trait-flourish', () => {
    const e = findEntity(entities, 'Feats.aspx?ID=750');
    assert.ok(e !== undefined, 'Power Attack entity must exist');
    const arr = Array.isArray(e['aonprd:trait']) ? e['aonprd:trait'] as unknown[]
              : e['aonprd:trait'] !== undefined ? [e['aonprd:trait']] : [];
    assert.ok(
      arr.some(t => asIri(t)?.includes('Trait-flourish')),
      `Expected Trait-flourish; got ${JSON.stringify(e['aonprd:trait'])}`,
    );
  });

  it('Power Attack: aonprd:actionCost === "two-actions"', () => {
    const e = findEntity(entities, 'Feats.aspx?ID=750');
    assert.ok(e !== undefined, 'Power Attack entity must exist');
    assert.equal(asScalar(e['aonprd:actionCost']), 'two-actions');
  });

  // Fireball
  it('Fireball: aonprd:name === "Fireball"', () => {
    const e = findEntity(entities, 'Spells.aspx?ID=119');
    assert.ok(e !== undefined, 'Fireball entity must exist');
    assert.equal(asScalar(e['aonprd:name']), 'Fireball');
  });

  it('Fireball: aonprd:level === 3', () => {
    const e = findEntity(entities, 'Spells.aspx?ID=119');
    assert.ok(e !== undefined, 'Fireball entity must exist');
    assert.equal(Number(asScalar(e['aonprd:level'])), 3);
  });

  it('Fireball: aonprd:tradition includes Tradition-arcane', () => {
    const e   = findEntity(entities, 'Spells.aspx?ID=119');
    assert.ok(e !== undefined, 'Fireball entity must exist');
    const arr = Array.isArray(e['aonprd:tradition']) ? e['aonprd:tradition'] as unknown[]
              : e['aonprd:tradition'] !== undefined ? [e['aonprd:tradition']] : [];
    assert.ok(
      arr.some(t => asIri(t)?.includes('Tradition-arcane')),
      `Expected Tradition-arcane; got ${JSON.stringify(e['aonprd:tradition'])}`,
    );
  });

  // Goblin Warrior
  it('Goblin Warrior: aonprd:name === "Goblin Warrior"', () => {
    const e = findEntity(entities, 'Monsters.aspx?ID=232');
    assert.ok(e !== undefined, 'Goblin Warrior entity must exist');
    assert.equal(asScalar(e['aonprd:name']), 'Goblin Warrior');
  });

  it('Goblin Warrior: aonprd:level === -1', () => {
    const e = findEntity(entities, 'Monsters.aspx?ID=232');
    assert.ok(e !== undefined, 'Goblin Warrior entity must exist');
    assert.equal(Number(asScalar(e['aonprd:level'])), -1);
  });

  it('Goblin Warrior: aonprd:trait includes Trait-goblin', () => {
    const e   = findEntity(entities, 'Monsters.aspx?ID=232');
    assert.ok(e !== undefined, 'Goblin Warrior entity must exist');
    const arr = Array.isArray(e['aonprd:trait']) ? e['aonprd:trait'] as unknown[]
              : e['aonprd:trait'] !== undefined ? [e['aonprd:trait']] : [];
    assert.ok(
      arr.some(t => asIri(t)?.includes('Trait-goblin')),
      `Expected Trait-goblin; got ${JSON.stringify(e['aonprd:trait'])}`,
    );
  });

  // Stride
  it('Stride: aonprd:name === "Stride"', () => {
    const e = findEntity(entities, 'Actions.aspx?ID=88');
    assert.ok(e !== undefined, 'Stride entity must exist');
    assert.equal(asScalar(e['aonprd:name']), 'Stride');
  });

  it('Stride: aonprd:actionCost === "one-action"', () => {
    const e = findEntity(entities, 'Actions.aspx?ID=88');
    assert.ok(e !== undefined, 'Stride entity must exist');
    assert.equal(asScalar(e['aonprd:actionCost']), 'one-action');
  });

  // Longsword
  it('Longsword: aonprd:name === "Longsword"', () => {
    const e = findEntity(entities, 'Weapons.aspx?ID=31');
    assert.ok(e !== undefined, 'Longsword entity must exist');
    assert.equal(asScalar(e['aonprd:name']), 'Longsword');
  });

  it('Longsword: aonprd:rarity references Rarity-common', () => {
    const e = findEntity(entities, 'Weapons.aspx?ID=31');
    assert.ok(e !== undefined, 'Longsword entity must exist');
    assert.ok(
      asIri(e['aonprd:rarity'])?.includes('Rarity-common'),
      `Expected Rarity-common; got ${JSON.stringify(e['aonprd:rarity'])}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Test 5: Quarantine bucket counts
// ---------------------------------------------------------------------------

describe('aonprd e2e — quarantine bucket counts', () => {
  let outDir = '';

  before(async () => {
    const tmp   = await mkdtemp(join(tmpdir(), 'sq-e2e-qrtn-'));
    const paths = await setupTmpFixture(tmp);
    outDir      = paths.outDir;
    await runBuild(paths);
  });

  it('unknown/ quarantine has exactly 1 artifact (homebrew record)', async () => {
    const entries = await readdir(join(outDir, TARGET, 'quarantine', 'unknown'));
    assert.equal(entries.length, 1,
      `Expected 1 in unknown/; got ${entries.length.toString()}: ${entries.join(', ')}`);
  });

  it('conflicts/ quarantine has exactly 1 artifact (tie-feat-spell record)', async () => {
    const entries = await readdir(join(outDir, TARGET, 'quarantine', 'conflicts'));
    assert.equal(entries.length, 1,
      `Expected 1 in conflicts/; got ${entries.length.toString()}: ${entries.join(', ')}`);
  });

  it('projection/ quarantine has exactly 1 artifact (malformed JSONL line)', async () => {
    const entries = await readdir(join(outDir, TARGET, 'quarantine', 'projection'));
    assert.equal(entries.length, 1,
      `Expected 1 in projection/; got ${entries.length.toString()}: ${entries.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Determinism — two independent runs produce identical JSON-LD
// ---------------------------------------------------------------------------

describe('aonprd e2e — determinism (two independent runs match)', () => {
  it('two runs produce identical parsed JSON-LD output', async () => {
    async function runOnce(): Promise<unknown> {
      const tmp   = await mkdtemp(join(tmpdir(), 'sq-e2e-det-'));
      const paths = await setupTmpFixture(tmp);
      await runBuild(paths);
      return JSON.parse(await readFile(paths.outputPath, 'utf8')) as unknown;
    }

    const [r1, r2] = await Promise.all([runOnce(), runOnce()]);
    assert.deepEqual(r1, r2,
      'Two identical runs must produce identical parsed JSON-LD output');
  });
});

// ---------------------------------------------------------------------------
// Test 7: Dry run — no output file written
// ---------------------------------------------------------------------------

describe('aonprd e2e — dry run produces no output file', () => {
  it('dry-run: exitCode 0 and no file on disk', async () => {
    const tmp   = await mkdtemp(join(tmpdir(), 'sq-e2e-dry-'));
    const paths = await setupTmpFixture(tmp);
    const config = SquashageConfig.loadFromFile(paths.configPath);

    const result = await SquashageOrchestrator.run(config, TARGET, {
      outDir:        paths.outDir,
      configPath:    paths.configPath,
      inputOverride: paths.inputDir,
      dryRun:        true,
    });

    assert.equal(result.exitCode, 0);
    await assert.rejects(
      () => readFile(paths.outputPath, 'utf8'),
      (e: unknown) => e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT',
      'Dry run must not write output file',
    );
  });
});

// ---------------------------------------------------------------------------
// Test 8: --out override
// ---------------------------------------------------------------------------

describe('aonprd e2e — --out override', () => {
  it('output file lands at the overridden path', async () => {
    const tmp     = await mkdtemp(join(tmpdir(), 'sq-e2e-out-'));
    const paths   = await setupTmpFixture(tmp);
    const altPath = join(tmp, 'alt', 'output.jsonld');
    const config  = SquashageConfig.loadFromFile(paths.configPath);

    const result = await SquashageOrchestrator.run(config, TARGET, {
      outDir:        paths.outDir,
      configPath:    paths.configPath,
      inputOverride: paths.inputDir,
      outOverride:   altPath,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.outputPath, altPath);
    const text = await readFile(altPath, 'utf8');
    assert.ok(text.length > 0, 'Alt path output must not be empty');
  });
});

// ---------------------------------------------------------------------------
// Test 9: Inline jsonldContext override
// ---------------------------------------------------------------------------

describe('aonprd e2e — inline jsonldContext override', () => {
  it('@context matches the inline context supplied in the config', async () => {
    const tmp   = await mkdtemp(join(tmpdir(), 'sq-e2e-ictx-'));
    const paths = await setupTmpFixture(tmp);

    const raw = JSON.parse(await readFile(paths.configPath, 'utf8')) as Record<string, unknown>;
    const tgt = (raw['targets'] as Record<string, Record<string, unknown>>)[TARGET]!;
    const out = tgt['output'] as Record<string, unknown>;

    const inlineCtx = { '@context': { ex: 'https://example.org/', name: { '@id': 'ex:name' } } };
    out['jsonldContext'] = inlineCtx;
    const altOut = join(tmp, 'inline-out', 'aonprd.jsonld');
    out['path']  = altOut;

    const modCfgPath = join(tmp, 'sq-inline.config.json');
    await writeFile(modCfgPath, JSON.stringify(raw, null, 2), 'utf8');

    const config = SquashageConfig.loadFromFile(modCfgPath);
    await SquashageOrchestrator.run(config, TARGET, {
      outDir:        paths.outDir,
      configPath:    modCfgPath,
      inputOverride: paths.inputDir,
    });

    const doc = JSON.parse(await readFile(altOut, 'utf8')) as Record<string, unknown>;
    const ctx = doc['@context'] as Record<string, unknown>;
    assert.equal(ctx['ex'], 'https://example.org/',
      `Expected @context.ex === "https://example.org/"; got ${JSON.stringify(ctx)}`);
  });
});
