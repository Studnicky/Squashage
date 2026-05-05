/**
 * @fileoverview Build script for the Pathfinder/aonprd demo.
 *
 * @remarks
 * Produces:
 *   docs/public/examples/aonprd/aonprd.jsonld          — full JSON-LD output (4-5 MB)
 *   docs/public/examples/aonprd/aonprd.html            — small wrapper that fetches chunks (~170 KB)
 *   docs/public/examples/aonprd/index.json             — chunk manifest sorted by ascending node count
 *   docs/public/examples/aonprd/chunks/<slug>.json     — one chunk per named graph with baked positions
 *
 * The demo is served via VitePress public passthrough under /examples/aonprd/.
 *
 * Usage (fixture-based, 12 records):
 *   npm run viz:demo
 *
 * Usage (full corpus, requires ripperoni scrape output):
 *   SQUASHAGE_DEMO_INPUT=/path/to/ripper/output/aonprd/aonprd npm run viz:demo
 *
 * @module scripts/build-aonprd-demo
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname }           from 'node:path';
import { fileURLToPath }              from 'node:url';

import { SquashageConfig }       from '../src/config/SquashageConfig.js';
import { SquashageOrchestrator } from '../src/orchestrators/SquashageOrchestrator.js';
import { registerAonprdPlugin }  from '../tests/e2e/aonprd/plugin.js';
import { JsonLdGraph }           from '../src/viz/JsonLdGraph.js';
import { ChunkBuilder }          from '../src/viz/ChunkBuilder.js';
import { SigmaGraphRenderer }    from '../src/viz/SigmaGraphRenderer.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const ROOT         = resolve(__dirname, '..');
const FIXTURE      = resolve(ROOT, 'tests', 'e2e', 'aonprd');
const OUT_DIR      = resolve(ROOT, 'docs', 'public', 'examples', 'aonprd');
const JSON_LD_PATH = resolve(OUT_DIR, 'aonprd.jsonld');
const HTML_PATH    = resolve(OUT_DIR, 'aonprd.html');
const TARGET       = 'aonprd';

const DEMO_INPUT_OVERRIDE = process.env['SQUASHAGE_DEMO_INPUT'];

async function main(): Promise<void> {
  const isFullCorpus = DEMO_INPUT_OVERRIDE !== undefined && DEMO_INPUT_OVERRIDE.length > 0;

  if (isFullCorpus) {
    console.log(`Building aonprd demo — full corpus mode`);
    console.log(`  Input: ${DEMO_INPUT_OVERRIDE}`);
  } else {
    console.log('Building aonprd demo — fixture mode (12 records)');
  }

  registerAonprdPlugin();
  await mkdir(OUT_DIR, { recursive: true });

  const cfgPath = resolve(FIXTURE, 'squashage.config.json');
  const raw     = JSON.parse(await readFile(cfgPath, 'utf-8')) as Record<string, unknown>;

  const targets = raw['targets'] as Record<string, Record<string, unknown>>;

  const inputPath = isFullCorpus ? DEMO_INPUT_OVERRIDE : resolve(FIXTURE, 'input');
  targets[TARGET]!['input'] = inputPath;
  (targets[TARGET]!['output'] as Record<string, string>)['path'] = JSON_LD_PATH;

  const classification = targets[TARGET]!['classification'] as Record<string, unknown> | undefined;
  if (classification !== undefined) {
    const schemas = classification['schemas'];
    if (Array.isArray(schemas)) {
      classification['schemas'] = schemas.map((s: unknown) => {
        if (s !== null && typeof s === 'object' && !Array.isArray(s)) {
          const schemaObj = s as Record<string, unknown>;
          if (typeof schemaObj['schemaPath'] === 'string') {
            return { ...schemaObj, schemaPath: resolve(FIXTURE, schemaObj['schemaPath']) };
          }
        }
        return s;
      });
    }
  }

  const tmpCfgPath = resolve(OUT_DIR, '.squashage.config.tmp.json');
  await writeFile(tmpCfgPath, JSON.stringify(raw, null, 2), 'utf-8');

  let result;
  try {
    const config = SquashageConfig.loadFromFile(tmpCfgPath);
    result = await SquashageOrchestrator.run(config, TARGET, {
      outDir:      resolve(OUT_DIR, 'graphs'),
      configPath:  tmpCfgPath,
      outOverride: JSON_LD_PATH,
    });
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(tmpCfgPath, { force: true });
  }

  console.log(`Pipeline: records=${result.recordCount} succeeded=${result.succeeded} failed=${result.failed} exit=${result.exitCode}`);

  // Read JSON-LD, run global FA2 layout, write chunks + small HTML wrapper.
  const jsonldText = await readFile(JSON_LD_PATH, 'utf-8');
  const doc        = JSON.parse(jsonldText) as unknown;
  const payload    = await JsonLdGraph.fromJsonLd(doc);

  console.log(`Payload: nodes=${payload.nodes.length.toString()} edges=${payload.edges.length.toString()} graphs=${payload.graphs.length.toString()}`);
  console.log('Running ForceAtlas2 layout (build time)…');

  const t0       = Date.now();
  const manifest = await ChunkBuilder.build(payload, {
    outDir:     OUT_DIR,
    iterations: payload.nodes.length > 5000 ? 800 : 400,
    onChunk: (entry): void => {
      console.log(`  chunk: ${entry.slug.padEnd(28)} ${entry.nodeCount.toString().padStart(6)} nodes  ${entry.edgeCount.toString().padStart(6)} edges`);
    },
  });
  console.log(`Layout + chunking complete (${(Date.now() - t0).toString()}ms, ${manifest.length.toString()} chunks).`);

  const html = SigmaGraphRenderer.render({
    title:    'Squashage — Pathfinder/AONPRD Demo',
    indexUrl: './index.json',
  });
  await writeFile(HTML_PATH, html, 'utf-8');

  const jsonldBytes = Buffer.byteLength(jsonldText, 'utf-8');
  const htmlBytes   = Buffer.byteLength(html, 'utf-8');
  console.log(`JSON-LD: ${JSON_LD_PATH} (${(jsonldBytes / 1024 / 1024).toFixed(2)} MB, kept for reference)`);
  console.log(`HTML:    ${HTML_PATH} (${(htmlBytes / 1024).toFixed(1)} KB wrapper)`);
  console.log(`Index:   ${OUT_DIR}/index.json + ${OUT_DIR}/chunks/*.json`);
  console.log('Done.');
}

main().catch((err: unknown) => {
  process.stderr.write(String(err instanceof Error ? err.stack ?? err.message : err) + '\n');
  process.exit(1);
});
