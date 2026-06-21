/**
 * dagonizer CLI entry — wraps `SquashageRun.forTarget(...).execute()` for the
 * new DAG-based pipeline. Coexists with the legacy `cli.ts` during the
 * migration; once the legacy CLI is deleted (Phase 10), this becomes the only
 * entry point.
 *
 *   squashage-dag build --target <name> --config <path>
 *                       [--out <path>] [--format <fmt>] [--dry-run]
 *
 * Stream mode (output.encoding === 'stream') consumes the Execution async
 * iterator and writes per-record quads as they finalize. File mode awaits the
 * execution and lets `rdfjs-finalize` handle the write.
 */

import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { SquashageConfig } from '../config/SquashageConfig.js';
import { SquashageRun } from '../SquashageRun.js';
import type { SquashageRunState } from '../state/SquashageRunState.js';
import type { SquashageInduceRunState } from '../state/SquashageInduceRunState.js';
import type { SquashageRefineRunState } from '../state/SquashageRefineRunState.js';
import { ChunkBuilder } from '../viz/ChunkBuilder.js';
import { JsonLdGraph } from '../viz/JsonLdGraph.js';
import { QuadGraph } from '../viz/QuadGraph.js';
import { SigmaGraphRenderer } from '../viz/SigmaGraphRenderer.js';
import { extname } from 'node:path';

interface BuildOptionsInterface {
  target:  string;
  config:  string;
  out?:    string;
  format?: string;
  dryRun?: boolean;
}

interface InduceOptionsInterface {
  target: string;
  config: string;
  out?:   string;
}

interface RefineOptionsInterface {
  target: string;
  config: string;
  out?:   string;
}

interface BootstrapOptionsInterface {
  target:       string;
  config:       string;
  out?:         string;
  skipInduce?:  boolean;
}

export class DagonizerCli {
  static build(): Command {
    const program = new Command();
    program.name('squashage-dag').description('Squashage DAG pipeline (dagonizer port)');

    program
      .command('build')
      .description('Run the DAG pipeline for one target')
      .requiredOption('--target <name>', 'Target name from config')
      .requiredOption('--config <path>', 'Squashage config path')
      .option('--out <path>',    'Output path override')
      .option('--format <fmt>',  'Output format override')
      .option('--dry-run',       'Skip writes')
      .action(async (opts: BuildOptionsInterface): Promise<void> => {
        const cfg = SquashageConfig.loadFromFile(opts.config);
        const targetConfig = cfg.targets[opts.target];
        if (targetConfig === undefined) {
          process.stderr.write(`Target "${opts.target}" not found\n`);
          process.exitCode = 1;
          return;
        }

        const output = {
          ...targetConfig.output,
          ...(opts.out    !== undefined ? { path:   opts.out }    : {}),
          ...(opts.format !== undefined ? { format: opts.format } : {}),
          ...(opts.dryRun ? { dryRun: true } : {}),
        } as typeof targetConfig.output;

        const run = await SquashageRun.forTarget({
          target:       opts.target,
          targetConfig,
          output,
          outDir:       './graphs',
          schemasBase:  dirname(opts.config),
        });

        const result = await run.execute();
        const finalState = result.state as unknown as SquashageRunState;
        const summaries  = run.services.recordSummaries;
        const successes  = summaries.filter((r) => r.outcome === 'squashed').length;
        const failures   = summaries.filter((r) => r.outcome !== 'squashed').length;
        process.stdout.write(
          `target: ${opts.target}\n` +
          `records: ${String(summaries.length)}\n` +
          `succeeded: ${String(successes)}\n` +
          `failed: ${String(failures)}\n` +
          `lifecycle: ${finalState.lifecycle.variant}\n`,
        );
        process.exitCode = failures > 0 ? 1 : 0;
      });

    program
      .command('induce')
      .description('Walk input, classify records, observe shapes, write draft schemas')
      .requiredOption('--target <name>', 'Target name from config')
      .requiredOption('--config <path>', 'Squashage config path')
      .option('--out <dir>', 'Override output directory for draft schemas')
      .action(async (opts: InduceOptionsInterface): Promise<void> => {
        const cfg = SquashageConfig.loadFromFile(opts.config);
        const targetConfig = cfg.targets[opts.target];
        if (targetConfig === undefined) {
          process.stderr.write(`Target "${opts.target}" not found\n`);
          process.exitCode = 1;
          return;
        }

        const configDir = dirname(opts.config);
        const run = await SquashageRun.forTarget({
          target:      opts.target,
          targetConfig,
          output:      targetConfig.output,
          outDir:      './graphs',
          schemasBase: opts.out !== undefined ? resolve(opts.out) : configDir,
        });

        const result = await run.executeInduce();
        const finalState = result.state as unknown as SquashageInduceRunState;
        const classList  = finalState.discoveredClasses.join(', ') || '(none)';
        const inferredDir = run.services.schemaPaths.inferred;

        process.stdout.write(
          `target: ${opts.target}\n` +
          `observed: ${String(finalState.observedRecords)} records\n` +
          `discovered: ${String(finalState.discoveredClasses.length)} classes (${classList})\n` +
          `drafts: ${String(finalState.draftsWritten)} written to ${inferredDir}\n` +
          `lifecycle: ${finalState.lifecycle.variant}\n`,
        );
      });

    program
      .command('refine')
      .description('Apply operator refinements to draft schemas, writing final schemas')
      .requiredOption('--target <name>', 'Target name from config')
      .requiredOption('--config <path>', 'Squashage config path')
      .option('--out <dir>', 'Override output directory for final schemas')
      .action(async (opts: RefineOptionsInterface): Promise<void> => {
        const cfg = SquashageConfig.loadFromFile(opts.config);
        const targetConfig = cfg.targets[opts.target];
        if (targetConfig === undefined) {
          process.stderr.write(`Target "${opts.target}" not found\n`);
          process.exitCode = 1;
          return;
        }

        const configDir = dirname(opts.config);
        const run = await SquashageRun.forTarget({
          target:      opts.target,
          targetConfig,
          output:      targetConfig.output,
          outDir:      './graphs',
          schemasBase: opts.out !== undefined ? resolve(opts.out) : configDir,
        });

        const result     = await run.executeRefine();
        const finalState = result.state as unknown as SquashageRefineRunState;

        process.stdout.write(
          `target: ${opts.target}\n` +
          `refined: ${String(finalState.refinedCount)}\n` +
          `passthrough: ${String(finalState.passthroughCount)}\n` +
          `errors: ${String(finalState.runErrors.length)}\n` +
          `lifecycle: ${finalState.lifecycle.variant}\n`,
        );

        if (finalState.runErrors.length > 0) {
          for (const err of finalState.runErrors) {
            process.stderr.write(`  error: ${err}\n`);
          }
          process.exitCode = 1;
        }
      });

    program
      .command('bootstrap')
      .description('Run the full induce → refine → build pipeline for one target')
      .requiredOption('--target <name>', 'Target name from config')
      .requiredOption('--config <path>', 'Squashage config path')
      .option('--out <dir>',    'Override output directory / schemas base')
      .option('--skip-induce', 'Skip induce phase; start at refine then build')
      .action(async (opts: BootstrapOptionsInterface): Promise<void> => {
        const cfg = SquashageConfig.loadFromFile(opts.config);
        const targetConfig = cfg.targets[opts.target];
        if (targetConfig === undefined) {
          process.stderr.write(`Target "${opts.target}" not found\n`);
          process.exitCode = 1;
          return;
        }

        const configDir  = dirname(opts.config);
        const schemasBase = opts.out !== undefined ? resolve(opts.out) : configDir;

        const run = await SquashageRun.forTarget({
          target:      opts.target,
          targetConfig,
          output:      targetConfig.output,
          outDir:      './graphs',
          schemasBase,
        });

        if (opts.skipInduce === true) {
          // --skip-induce: execute refine then build sequentially.
          process.stdout.write('[bootstrap] --skip-induce: starting at refine phase\n');

          const refineResult = await run.executeRefine();
          const refineState  = refineResult.state as unknown as SquashageRefineRunState;

          if (refineState.lifecycle.variant !== 'completed') {
            process.stderr.write(
              `[refine] phase failed (lifecycle: ${refineState.lifecycle.variant})\n`,
            );
            process.exitCode = 1;
            return;
          }

          process.stdout.write(
            `[refine]    ${String(refineState.refinedCount)} drafts → ${String(refineState.refinedCount + refineState.passthroughCount)} finals\n`,
          );

          await run.execute();
          const buildSummaries = run.services.recordSummaries;

          const successes = buildSummaries.filter((r) => r.outcome === 'squashed').length;
          const failures  = buildSummaries.filter((r) => r.outcome !== 'squashed').length;

          process.stdout.write(
            `[build]     ${String(buildSummaries.length)} records → ${String(successes)} quads + TBox + SHACL + PROV\n`,
          );

          process.exitCode = failures > 0 ? 1 : 0;
          return;
        }

        // Full bootstrap: induce → gate → refine → gate → build.
        const { state: finalState } = await run.executeBootstrap();
        const inferredDir    = run.services.schemaPaths.inferred;
        const refinementsDir = run.services.schemaPaths.refinements;

        if (finalState.induceResult !== null) {
          const { discoveredClasses, draftsWritten } = finalState.induceResult;
          process.stdout.write(
            `[induce]    discovered ${String(discoveredClasses.length)} classes; wrote ${String(draftsWritten)} drafts to ${inferredDir}\n`,
          );
        }

        if (finalState.refineResult === null && finalState.induceResult !== null) {
          // Halted at refine-required-gate.
          process.stdout.write(
            `[gate]      no refinements found under ${refinementsDir} — halting\n` +
            `            operator: review drafts, write refinements, re-run bootstrap\n`,
          );
          process.exitCode = 0;
          return;
        }

        if (finalState.refineResult !== null) {
          const { refinedCount, passthroughCount } = finalState.refineResult;
          process.stdout.write(
            `[refine]    ${String(refinedCount + passthroughCount)} drafts → ${String(refinedCount + passthroughCount)} finals\n`,
          );
        }

        if (finalState.buildResult === null && finalState.refineResult !== null) {
          // Halted at build-ready-gate (should not happen in normal operation).
          process.stdout.write('[gate]      no final schemas found — build phase skipped\n');
          process.exitCode = 0;
          return;
        }

        if (finalState.results.length > 0) {
          const successes = finalState.results.filter((r) => r.outcome === 'squashed').length;
          process.stdout.write(
            `[build]     ${String(finalState.results.length)} records → ${String(successes)} quads + TBox + SHACL + PROV\n`,
          );
          const failures = finalState.results.filter((r) => r.outcome !== 'squashed').length;
          process.exitCode = failures > 0 ? 1 : 0;
        }
      });

    program
      .command('viz')
      .description('Render a squashage JSON-LD as a chunked interactive graph (sigma + WebGL)')
      .requiredOption('--in <path>', 'Path to a squashage-produced JSON-LD file')
      .option('--out <dir>', 'Output directory (default: <basename>/ next to --in)')
      .option('--title <string>', 'HTML page title (default: Squashage — <basename>)')
      .option('--iterations <n>', 'ForceAtlas2 iterations (default: 800 for >5k nodes, else 400)')
      .action(async (opts: { in: string; out?: string; title?: string; iterations?: string }): Promise<void> => {
        const inPath = resolve(opts.in);
        const ext    = extname(inPath).toLowerCase();
        const inBase = basename(inPath, ext);
        const outDir = opts.out !== undefined ? resolve(opts.out) : join(dirname(inPath), inBase);
        const title  = opts.title ?? `Squashage — ${inBase}`;

        // Route by extension. .nq / .trig / .nt / .ttl stream through n3 (preferred);
        // .jsonld retained as legacy fallback.
        let payload;
        try {
          // Load <basename>.prefixes.json sidecar if present so the viz uses CURIEs
          // rather than full IRIs for node/edge labels.
          const prefixesPath = inPath.replace(/\.[^.]+$/, '.prefixes.json');
          let prefixes: Record<string, string> = {};
          try {
            prefixes = JSON.parse(await readFile(prefixesPath, 'utf-8')) as Record<string, string>;
          } catch { /* no sidecar — fall back to empty prefixes */ }

          if (ext === '.nq' || ext === '.nquads') {
            payload = await QuadGraph.fromQuadsFile(inPath, prefixes, 'nquads');
          } else if (ext === '.trig') {
            payload = await QuadGraph.fromQuadsFile(inPath, prefixes, 'trig');
          } else if (ext === '.nt' || ext === '.ntriples') {
            payload = await QuadGraph.fromQuadsFile(inPath, prefixes, 'ntriples');
          } else if (ext === '.ttl' || ext === '.turtle') {
            payload = await QuadGraph.fromQuadsFile(inPath, prefixes, 'turtle');
          } else {
            const doc = JSON.parse(await readFile(inPath, 'utf-8')) as unknown;
            payload = await JsonLdGraph.fromJsonLd(doc);
          }
        } catch (err) {
          process.stderr.write(`viz: cannot read/parse ${inPath}: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exitCode = 1;
          return;
        }

        const explicit   = opts.iterations !== undefined ? Number(opts.iterations) : NaN;
        const iterations = Number.isFinite(explicit) && explicit > 0
          ? explicit
          : (payload.nodes.length > 5000 ? 800 : 400);

        try {
          const manifest = await ChunkBuilder.build(payload, { outDir, iterations });
          const html     = SigmaGraphRenderer.render({ title, indexUrl: './index.json' });
          await writeFile(join(outDir, `${inBase}.html`), html, 'utf-8');
          process.stdout.write(`viz: wrote ${String(manifest.length)} chunks + index.json + HTML wrapper to ${outDir}\n`);
          process.stdout.write(`viz: open ${join(outDir, inBase)}.html\n`);
        } catch (err) {
          process.stderr.write(`viz: cannot write to ${outDir}: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exitCode = 1;
        }
      });

    return program;
  }
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  DagonizerCli.build().parseAsync(process.argv).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
