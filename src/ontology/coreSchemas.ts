/**
 * coreSchemas — loaders for the framework's bundled upper-ontology and
 * extracted inferred schemas.
 *
 * Plugins building a JsonTologyOntology call these to include the squashage
 * core class hierarchy (Thing → NamedThing → ContentEntry …) and any
 * inferred primitive/object schemas produced by the induction pipeline.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join }     from 'node:path';
import { fileURLToPath }     from 'node:url';

import type { JsonTologySchemaInputInterface } from './JsonTologyOntology.js';

const CORE_SCHEMAS_DIR: string = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'core',
);


let coreSchemaCache: ReadonlyArray<JsonTologySchemaInputInterface> | null = null;

/**
 * Load the bundled core upper-ontology schemas from `src/schemas/core/`.
 *
 * Primitives are loaded first (they are `$ref` targets for class schemas).
 * Results are cached process-wide after the first call.
 */
export async function loadCoreSchemaInputs(): Promise<ReadonlyArray<JsonTologySchemaInputInterface>> {
  if (coreSchemaCache !== null) return coreSchemaCache;

  let topEntries: string[];
  try {
    topEntries = await readdir(CORE_SCHEMAS_DIR);
  } catch {
    coreSchemaCache = [];
    return coreSchemaCache;
  }

  const inputs: JsonTologySchemaInputInterface[] = [];

  const primitivesDir = join(CORE_SCHEMAS_DIR, 'primitives');
  let primEntries: string[];
  try {
    primEntries = await readdir(primitivesDir);
  } catch {
    primEntries = [];
  }
  for (const filename of primEntries.filter((f) => f.endsWith('.schema.json')).sort()) {
    const absPath    = join(primitivesDir, filename);
    const schemaPath = join('schemas', 'core', 'primitives', filename);
    const text       = await readFile(absPath, 'utf8');
    const schema     = JSON.parse(text) as Record<string, unknown> & { readonly '$id': string };
    inputs.push({ schemaPath, schema });
  }

  for (const filename of topEntries.filter((f) => f.endsWith('.schema.json')).sort()) {
    const absPath    = join(CORE_SCHEMAS_DIR, filename);
    const schemaPath = join('schemas', 'core', filename);
    const text       = await readFile(absPath, 'utf8');
    const schema     = JSON.parse(text) as Record<string, unknown> & { readonly '$id': string };
    inputs.push({ schemaPath, schema });
  }

  coreSchemaCache = inputs;
  return coreSchemaCache;
}

/**
 * Scan `pluginDir/schemas/primitives/` and `pluginDir/schemas/objects/` for
 * `*.schema.json` files produced by the induction pipeline.
 * Returns an empty array when the directories are absent.
 */
export async function loadExtractedSchemaInputs(
  pluginDir: string,
): Promise<JsonTologySchemaInputInterface[]> {
  const subdirs = ['schemas/primitives', 'schemas/objects'];
  const inputs: JsonTologySchemaInputInterface[] = [];

  for (const sub of subdirs) {
    const dir = join(pluginDir, sub);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const filename of entries.filter((f) => f.endsWith('.schema.json')).sort()) {
      const absPath    = join(dir, filename);
      const schemaPath = join(sub, filename);
      try {
        const text   = await readFile(absPath, 'utf8');
        const schema = JSON.parse(text) as Record<string, unknown> & { readonly '$id': string };
        inputs.push({ schemaPath, schema });
      } catch {
        // Skip unreadable files; JsonTologyOntology.create will report missing $refs.
      }
    }
  }

  return inputs;
}
