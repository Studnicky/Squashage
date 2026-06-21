/**
 * render-dags — emits Mermaid flowchart source for the squashage DAGs into
 * `docs/architecture/dags/` so the VitePress build can embed them via the
 * mermaid plugin. Run before every `docs:build` / `docs:dev`.
 *
 *   docs/architecture/dags/squashage-record.md — per-record deep-DAG
 *   docs/architecture/dags/squashage-run.md    — run-scope DAG
 *
 * The run DAG is built dynamically inside `SquashageRun.forTarget(...)`. To
 * render it we construct a `SquashageRun` against a tiny synthetic config so
 * the DAGBuilder chain executes; we then read the registered DAG out of the
 * dispatcher and pass it to `MermaidRenderer.render`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MermaidRenderer } from '@studnicky/dagonizer/viz';

import { recordDag } from '../src/dag/recordDag.js';
import { SquashageRun } from '../src/SquashageRun.js';
import type { TargetConfigInterface } from '../src/config/SquashageConfig.js';
import type { OutputConfigInterface } from '../src/config/OutputConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'docs', 'architecture', 'dags');

const wrapper = (title: string, source: string): string => [
  '---',
  `title: ${title}`,
  '---',
  '',
  `# ${title}`,
  '',
  '```mermaid',
  source,
  '```',
  '',
].join('\n');

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  // Per-record DAG is static — render it directly.
  const recordSource = MermaidRenderer.render(recordDag);
  await writeFile(resolve(OUT, 'squashage-record.md'),
    wrapper('Per-record DAG (squashage:record)', recordSource), 'utf-8');

  // Run-scope DAG is built per-target inside SquashageRun. Construct a
  // synthetic one and pull the registered DAG out by name.
  const synthetic: TargetConfigInterface = {
    input:  '.',
    output: { kind: 'file', path: '/tmp/__render-dag.trig' } as OutputConfigInterface,
    graphs: { default: 'https://example.org/graph/default' },
    ontology: { baseIri: 'https://example.org/' },
    concurrency: 1,
  };
  const run = await SquashageRun.forTargetWithNullObserver({
    target:       'render',
    targetConfig: synthetic,
    output:       synthetic.output,
    outDir:       '/tmp',
    schemasBase:  '/tmp',
  });

  const runDag = run.dispatcher.getDAG('squashage:run');
  if (runDag === undefined) {
    throw new Error('squashage:run DAG was not registered on the dispatcher');
  }
  const runSource = MermaidRenderer.render(runDag);
  await writeFile(resolve(OUT, 'squashage-run.md'),
    wrapper('Run-scope DAG (squashage:run)', runSource), 'utf-8');

  process.stdout.write(`render-dags: wrote ${OUT}/squashage-record.md and squashage-run.md\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`render-dags: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
