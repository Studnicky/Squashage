/**
 * @fileoverview Integration test: catalog:emit end-to-end with bucketing.
 *
 * @remarks
 * Runs the full pipeline with bucketing + catalog enabled against a
 * multi-graph fixture and asserts:
 * - Catalog file is created as `<targetId>.catalog.xml` in the bucket dir
 * - Catalog is valid XML (parsed via @xmldom/xmldom)
 * - Root element is `catalog` in the OASIS namespace
 * - One `<uri>` element per non-empty named-graph bucket
 * - `<uri>` `name` attribute is the graph IRI
 * - `<uri>` `uri` attribute resolves to a file that exists
 * - Default-graph bucket is NOT indexed (no defaultGraphCatalogIri)
 *
 * @category Integration
 * @since 0.7.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { DOMParser } from '@xmldom/xmldom';

import { SquashageOrchestrator } from '../../../src/orchestrators/SquashageOrchestrator.js';
import { SquashageConfig }       from '../../../src/config/SquashageConfig.js';
import { TaskRegistry }          from '../../../src/registry/TaskRegistry.js';
import { dataFactory }           from '../../../src/rdf/DataFactory.js';

let workDir: string;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'squashage-catalog-e2e-'));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

const PLUGIN_NAME = 'squash:catalog-e2e';

before(() => {
  if (!TaskRegistry.has(PLUGIN_NAME)) {
    TaskRegistry.register(PLUGIN_NAME, async (next, state) => {
      const ctx = state.context;
      if (ctx === undefined) { await next(); return; }

      const record = state.input as Record<string, unknown>;
      const id     = record['id'] as number;
      const kind   = record['kind'] as string;

      const graphIri  = `https://catalog.test/graph/${kind}`;
      const graphNode = dataFactory.namedNode(graphIri);
      const subject   = dataFactory.namedNode(`https://catalog.test/item/${id}`);
      const predicate = dataFactory.namedNode('https://catalog.test/vocab#id');
      const object    = dataFactory.literal(String(id));

      ctx.dataset.add(dataFactory.quad(subject, predicate, object, graphNode));

      await next();
    });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; }
  catch { return false; }
}

async function writeInputRecords(dir: string, records: unknown[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < records.length; i++) {
    await writeFile(join(dir, `record-${i}.json`), JSON.stringify(records[i]), 'utf8');
  }
}

/** Returns all elements by local name from a DOMParser result. */
function getElementsByLocalName(doc: Document, localName: string): Element[] {
  const result: Element[] = [];
  const all = doc.getElementsByTagNameNS('urn:oasis:names:tc:entity:xmlns:xml:catalog', localName);
  for (let i = 0; i < all.length; i++) {
    const el = all.item(i);
    if (el !== null) result.push(el as Element);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Catalog e2e — bucketing + catalog:emit', () => {
  it('produces a valid OASIS catalog indexing all named-graph buckets', async () => {
    const inputDir  = join(workDir, 'input-catalog');
    const bucketDir = join(workDir, 'buckets-catalog');

    const records = [
      { id: 1, kind: 'feats' },
      { id: 2, kind: 'spells' },
      { id: 3, kind: 'feats' },   // second feat
      { id: 4, kind: 'monsters' },
    ];

    await writeInputRecords(inputDir, records);

    const rawConfig = {
      input:   { basePath: inputDir, format: 'json' },
      targets: {
        aonprd: {
          input:    inputDir,
          pipeline: ['json:read', PLUGIN_NAME, 'rdfjs:finalize', 'catalog:emit'],
          output:   {
            kind:    'file',
            path:    bucketDir,
            format:  'trig',
            bucketing: {
              enabled:  true,
              strategy: 'per-graph-iri',
            },
            catalog: {
              enabled: true,
            },
          },
        },
      },
    };

    const config = SquashageConfig.validate(rawConfig as Parameters<typeof SquashageConfig.validate>[0]);
    const result = await SquashageOrchestrator.run(config, 'aonprd', {
      outDir: join(workDir, 'graphs-catalog'),
    });

    assert.equal(result.exitCode, 0, `exitCode=${result.exitCode}`);
    assert.equal(result.succeeded, records.length);

    // Catalog file should be aonprd.catalog.xml (targetId=aonprd)
    const catalogPath = join(bucketDir, 'aonprd.catalog.xml');
    assert.ok(await exists(catalogPath), 'catalog file should exist');

    const xmlContent = await readFile(catalogPath, 'utf8');

    // Parse as XML
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlContent, 'text/xml');

    // Root element must be <catalog> in the OASIS namespace
    const root = doc.documentElement;
    assert.ok(root !== null, 'document should have a root element');
    assert.equal(root.localName, 'catalog', 'root element should be "catalog"');
    assert.equal(
      root.namespaceURI,
      'urn:oasis:names:tc:entity:xmlns:xml:catalog',
      'root should be in OASIS namespace',
    );

    // Should have exactly 3 <uri> elements (feats, spells, monsters)
    const uriElements = getElementsByLocalName(doc, 'uri');
    assert.equal(uriElements.length, 3, 'should have 3 <uri> elements');

    // All <uri> elements should have both name and uri attributes
    for (const el of uriElements) {
      const name = el.getAttribute('name');
      const uri  = el.getAttribute('uri');
      assert.ok(name !== null && name.length > 0, '<uri> must have a name attribute');
      assert.ok(uri  !== null && uri.length  > 0, '<uri> must have a uri attribute');

      // The uri attribute should resolve to an existing file
      const absolutePath = resolve(bucketDir, uri!);
      assert.ok(await exists(absolutePath), `bucket file should exist: ${absolutePath}`);
    }

    // Named-graph IRIs should be in the catalog
    const names = new Set(uriElements.map(el => el.getAttribute('name')));
    assert.ok(names.has('https://catalog.test/graph/feats'),    'feats graph IRI should be indexed');
    assert.ok(names.has('https://catalog.test/graph/spells'),   'spells graph IRI should be indexed');
    assert.ok(names.has('https://catalog.test/graph/monsters'), 'monsters graph IRI should be indexed');

    // Bucket files should exist
    const bucketFiles = await readdir(bucketDir);
    assert.equal(bucketFiles.filter(f => f.endsWith('.trig')).length, 3, '3 bucket files');
  });

  it('default-graph bucket is NOT indexed when defaultGraphCatalogIri is absent', async () => {
    const inputDir2  = join(workDir, 'input-catalog-default');
    const bucketDir2 = join(workDir, 'buckets-catalog-default');

    // Add a record that emits to the default graph (we'll modify the plugin for this test)
    await writeInputRecords(inputDir2, [{ id: 99, kind: 'items' }]);

    const rawConfig2 = {
      input:   { basePath: inputDir2, format: 'json' },
      targets: {
        aonprd: {
          input:    inputDir2,
          pipeline: ['json:read', PLUGIN_NAME, 'rdfjs:finalize', 'catalog:emit'],
          output:   {
            kind:    'file',
            path:    bucketDir2,
            format:  'trig',
            bucketing: { enabled: true },
            catalog:  { enabled: true },
          },
        },
      },
    };

    const config2 = SquashageConfig.validate(rawConfig2 as Parameters<typeof SquashageConfig.validate>[0]);
    const result2 = await SquashageOrchestrator.run(config2, 'aonprd', {
      outDir: join(workDir, 'graphs-catalog-default'),
    });

    assert.equal(result2.exitCode, 0);

    const catalogPath2 = join(bucketDir2, 'aonprd.catalog.xml');
    const xmlContent2 = await readFile(catalogPath2, 'utf8');

    // No default-graph IRI should appear in the catalog
    assert.ok(!xmlContent2.includes('__default__'), 'default bucket key should not appear');
  });
});
