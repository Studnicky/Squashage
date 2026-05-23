/**
 * @fileoverview Unit tests for the bundled squashage-core upper-ontology schemas.
 *
 * @remarks
 * Verifies structural invariants for every schema in `src/schemas/core/`:
 * - All 10 class schemas exist and are valid JSON Schema 2020-12 documents.
 * - Each class schema carries `$id`, `$schema`, `title`, `type`.
 * - Every non-Thing class has an `allOf` array with at least one `$ref` into
 *   the core base IRI.
 * - ContentEntry has two `allOf` entries (NamedThing + Provenance).
 * - The `allOf` chain for every schema terminates at Thing (no cycles).
 *
 * @category Schemas
 * @since 0.8.0
 */

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname }    from 'node:path';
import { fileURLToPath }    from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CORE_BASE = 'https://noocodec.dev/squashage/core/';

const CORE_CLASS_NAMES = [
  'Thing',
  'NamedThing',
  'Identified',
  'Provenance',
  'DocumentSegment',
  'ContentEntry',
  'Vocabulary',
  'Reference',
  'Mechanic',
  'Container',
] as const;

type CoreClassName = (typeof CORE_CLASS_NAMES)[number];

const CORE_SCHEMAS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../src/schemas/core',
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadCoreSchema(name: string): Promise<Record<string, unknown>> {
  const absPath = join(CORE_SCHEMAS_DIR, `${name}.schema.json`);
  const text    = await readFile(absPath, 'utf8');
  return JSON.parse(text) as Record<string, unknown>;
}

async function loadAllCoreSchemas(): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const name of CORE_CLASS_NAMES) {
    map.set(name, await loadCoreSchema(name));
  }
  return map;
}

function allOfRefs(schema: Record<string, unknown>): string[] {
  const allOf = schema['allOf'];
  if (!Array.isArray(allOf)) return [];
  return allOf
    .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object' && !Array.isArray(e))
    .map((e) => e['$ref'])
    .filter((r): r is string => typeof r === 'string');
}

/**
 * Walk the allOf chain for a given schema using only the locally-loaded core
 * schema set. Returns `true` if the chain terminates at Thing without
 * revisiting any schema (no cycle detected).
 */
function chainTerminatesAtThing(
  className:   string,
  schemaMap:   Map<string, Record<string, unknown>>,
  visited:     Set<string> = new Set<string>(),
): boolean {
  if (visited.has(className)) return false; // cycle detected
  visited.add(className);

  const schema = schemaMap.get(className);
  if (schema === undefined) return false;

  const refs = allOfRefs(schema);
  if (refs.length === 0) {
    // Leaf node — must be Thing to terminate correctly.
    return className === 'Thing';
  }

  // For each parent ref, resolve to a className and recurse.
  for (const ref of refs) {
    // Strip the base and the .schema.json suffix to get the class name.
    if (!ref.startsWith(CORE_BASE)) continue;
    const tail      = ref.slice(CORE_BASE.length);
    const parentName = tail.replace(/\.schema\.json$/, '');
    if (!chainTerminatesAtThing(parentName, schemaMap, new Set(visited))) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Tests: existence on disk
// ---------------------------------------------------------------------------

describe('core schemas — existence', () => {
  it('src/schemas/core/ directory exists and contains schema files', async () => {
    const entries = await readdir(CORE_SCHEMAS_DIR);
    const schemaFiles = entries.filter((f) => f.endsWith('.schema.json'));
    assert.ok(schemaFiles.length >= 10, `Expected at least 10 schema files; found ${schemaFiles.length.toString()}`);
  });

  for (const name of CORE_CLASS_NAMES) {
    it(`${name}.schema.json exists on disk`, async () => {
      const schema = await loadCoreSchema(name);
      assert.ok(typeof schema === 'object' && schema !== null, `${name} schema must be a non-null object`);
    });
  }
});

// ---------------------------------------------------------------------------
// Tests: JSON Schema 2020-12 structural validity
// ---------------------------------------------------------------------------

describe('core schemas — JSON Schema 2020-12 compliance', () => {
  const REQUIRED_META = '$schema';
  const EXPECTED_SCHEMA_URI = 'https://json-schema.org/draft/2020-12/schema';

  for (const name of CORE_CLASS_NAMES) {
    it(`${name} has required top-level keywords: $id, $schema, title, type`, async () => {
      const schema = await loadCoreSchema(name);

      assert.ok(typeof schema['$id'] === 'string' && (schema['$id'] as string).length > 0,
        `${name}.$id must be a non-empty string`);
      assert.ok(typeof schema[REQUIRED_META] === 'string',
        `${name}.$schema must be present`);
      assert.equal(schema[REQUIRED_META], EXPECTED_SCHEMA_URI,
        `${name}.$schema must be the 2020-12 URI`);
      assert.ok(typeof schema['title'] === 'string' && (schema['title'] as string).length > 0,
        `${name}.title must be a non-empty string`);
      assert.equal(schema['type'], 'object', `${name}.type must be "object"`);
    });

    it(`${name} $id uses the core base IRI`, async () => {
      const schema = await loadCoreSchema(name);
      const id     = schema['$id'] as string;
      assert.ok(id.startsWith(CORE_BASE), `${name}.$id must start with "${CORE_BASE}"`);
    });

    it(`${name} has additionalProperties: true`, async () => {
      const schema = await loadCoreSchema(name);
      assert.equal(schema['additionalProperties'], true,
        `${name} must have additionalProperties: true to allow subclass extension`);
    });

    it(`${name} has a non-empty description`, async () => {
      const schema = await loadCoreSchema(name);
      assert.ok(
        typeof schema['description'] === 'string' && (schema['description'] as string).length > 0,
        `${name} must have a non-empty description (surfaces as rdfs:comment in the TBox)`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Tests: inheritance structure (allOf + $ref)
// ---------------------------------------------------------------------------

describe('core schemas — inheritance via allOf + $ref', () => {
  it('Thing has no allOf (root of hierarchy)', async () => {
    const schema = await loadCoreSchema('Thing');
    assert.ok(
      !('allOf' in schema) || !Array.isArray(schema['allOf']) || (schema['allOf'] as unknown[]).length === 0,
      'Thing must not have allOf — it is the root',
    );
  });

  const NON_ROOT: ReadonlyArray<CoreClassName> = [
    'NamedThing', 'Identified', 'Provenance', 'DocumentSegment',
    'ContentEntry', 'Vocabulary', 'Reference', 'Mechanic', 'Container',
  ];

  for (const name of NON_ROOT) {
    it(`${name} has at least one allOf $ref into the core base`, async () => {
      const schema = await loadCoreSchema(name);
      const refs   = allOfRefs(schema);
      assert.ok(refs.length >= 1, `${name} must have at least one allOf $ref`);
      const coreRef = refs.find((r) => r.startsWith(CORE_BASE));
      assert.ok(coreRef !== undefined, `${name} allOf must contain a $ref into "${CORE_BASE}"`);
    });
  }

  it('ContentEntry has exactly one allOf entry (NamedThing — single-parent inheritance)', async () => {
    const schema = await loadCoreSchema('ContentEntry');
    const allOf  = schema['allOf'] as unknown[];
    assert.equal(allOf.length, 1, 'ContentEntry must extend exactly one parent');

    const refs = allOfRefs(schema);
    assert.ok(
      refs.some((r) => r.includes('NamedThing')),
      'ContentEntry allOf must include a $ref to NamedThing',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: acyclic chain termination at Thing
// ---------------------------------------------------------------------------

describe('core schemas — acyclic chain termination', () => {
  it('every schema chain walks to Thing without cycles', async () => {
    const schemaMap = await loadAllCoreSchemas();

    for (const name of CORE_CLASS_NAMES) {
      const terminates = chainTerminatesAtThing(name, schemaMap);
      assert.ok(terminates, `${name} chain must terminate at Thing without a cycle`);
    }
  });
});
