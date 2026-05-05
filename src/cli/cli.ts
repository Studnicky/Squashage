/**
 * @fileoverview Squashage CLI — `build`, `classify`, and `inspect` subcommands.
 *
 * @remarks
 * Exports a {@link buildCli} factory that constructs a configured Commander
 * {@link Command} tree. The production entry-point calls
 * `buildCli().parseAsync(process.argv)` at the bottom of this module.
 *
 * **Subcommands**:
 * - `build` — wires {@link SquashageOrchestrator.run} and prints the
 *   {@link RunResultInterface} summary to stdout. Exits with `result.exitCode`.
 * - `classify` — v0.x stub; prints a not-implemented message and exits 0.
 *   Commander option definitions are intact so `--help` surface is correct.
 * - `inspect` — v0.x stub; same treatment.
 *
 * **Exit codes**:
 * - `0` — clean run (or stub subcommand).
 * - `1` — known configuration/output error ({@link OutputConfigError},
 *   {@link SquashageConfigError}, {@link FileOutputError},
 *   {@link ExternalSchemaError}).
 * - `2` — unexpected crash (any other thrown value).
 *
 * **`--out` / `--format` / `--dry-run`** are applied as CLI overrides that take
 * precedence over the values in `output.path` / `output.format` / `output.dryRun`
 * from the target config (§ "CLI Override" in plan 13).
 *
 * @module cli/cli
 * @category CLI
 * @since 0.1.0
 */

import { Command }      from 'commander';
import { readFileSync } from 'node:fs';

// Bootstrap built-in task registrations once before any pipeline is assembled.
import '../tasks/index.js';

import { SquashageConfig }       from '../config/SquashageConfig.js';
import { SquashageOrchestrator } from '../orchestrators/SquashageOrchestrator.js';
import type { RunResultInterface } from '../orchestrators/SquashageOrchestrator.js';
import { OutputConfigError }     from '../errors/OutputConfigError.js';
import { SquashageConfigError }  from '../errors/SquashageConfigError.js';
import { FileOutputError }       from '../errors/FileOutputError.js';
import { ExternalSchemaError }   from '../errors/ExternalSchemaError.js';
import { readFile, writeFile }   from 'node:fs/promises';
import { resolve, basename, dirname as pathDirname, join } from 'node:path';
import { JsonLdGraph }           from '../viz/JsonLdGraph.js';
import { ChunkBuilder }          from '../viz/ChunkBuilder.js';
import { SigmaGraphRenderer }    from '../viz/SigmaGraphRenderer.js';

// ---------------------------------------------------------------------------
// Package metadata
// ---------------------------------------------------------------------------

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
) as { version: string };

const DEFAULT_CONFIG_PATH = './squashage.config.json';

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** Known error types that map to exit code `1` (user-fixable config / I/O errors). */
const KNOWN_ERROR_TYPES = [
  OutputConfigError,
  SquashageConfigError,
  FileOutputError,
  ExternalSchemaError,
] as const;

/**
 * Returns the exit code for a caught error.
 *
 * @remarks
 * Known squashage error classes ({@link OutputConfigError},
 * {@link SquashageConfigError}, {@link FileOutputError},
 * {@link ExternalSchemaError}) map to exit code `1`.
 * Any other thrown value maps to exit code `2` (unexpected crash).
 *
 * @param err - The caught error value.
 * @returns `1` for known errors; `2` for unexpected crashes.
 */
function exitCodeFor(err: unknown): 1 | 2 {
  for (const KnownType of KNOWN_ERROR_TYPES) {
    if (err instanceof KnownType) return 1;
  }
  return 2;
}

// ---------------------------------------------------------------------------
// Result formatter
// ---------------------------------------------------------------------------

/**
 * Formats a {@link RunResultInterface} as a human-readable summary string.
 *
 * @param result - The run result returned by {@link SquashageOrchestrator.run}.
 * @returns A multi-line summary string suitable for stdout.
 */
function formatResult(result: RunResultInterface): string {
  const q = result.quarantine;
  return [
    `target:      ${result.target}`,
    `records:     ${result.recordCount}`,
    `succeeded:   ${result.succeeded}`,
    `failed:      ${result.failed}`,
    `quarantine:  unknown=${q.unknown} conflicts=${q.conflicts} projection=${q.projection} output=${q.output}`,
    `output:      ${result.outputPath}`,
    `exitCode:    ${result.exitCode}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLI factory
// ---------------------------------------------------------------------------

/**
 * Constructs and returns a configured Commander {@link Command} tree for the
 * squashage CLI.
 *
 * @remarks
 * Exported as a factory so tests can instantiate a fresh {@link Command} tree
 * without triggering `process.argv` parsing or side-effecting `process.exit`
 * calls. The production entry-point at the bottom of this module calls
 * `buildCli().parseAsync(process.argv)` and propagates the exit code via a
 * module-scoped carrier variable ({@link _exitCode}).
 *
 * @returns A new Commander {@link Command} configured with `build`,
 *   `classify`, and `inspect` subcommands.
 *
 * @example
 * ```ts
 * const cli = buildCli();
 * await cli.parseAsync(['node', 'squashage', 'build', '--target', 'foo', '--config', './sq.json']);
 * ```
 *
 * @category CLI
 * @since 0.1.0
 */
export function buildCli(): Command {
  const program = new Command();

  program
    .name('squashage')
    .description('Graph reconstitution pipeline — classify, project, and serialize structured JSON records to RDF.')
    .version(pkg.version);

  // -------------------------------------------------------------------------
  // build
  // -------------------------------------------------------------------------

  program
    .command('build')
    .description('Run the full graph reconstitution pipeline for a target')
    .requiredOption('--target <name>', 'Target name from config')
    .option('--config <path>', 'Config file path', DEFAULT_CONFIG_PATH)
    .option('--in <path>', 'Input directory or file path override')
    .option('--out <path>', 'Output file path override (wins over config output.path)')
    .option('--format <fmt>', 'Output format override (turtle|trig|ntriples|nquads|jsonld)')
    .option('--dry-run', 'Compute report without writing output file')
    .action(async (opts: {
      target:  string;
      config:  string;
      in?:     string;
      out?:    string;
      format?: string;
      dryRun?: boolean;
    }): Promise<void> => {
      let result: RunResultInterface;
      try {
        const config = SquashageConfig.loadFromFile(opts.config);
        result = await SquashageOrchestrator.run(config, opts.target, {
          outOverride:    opts.out,
          formatOverride: opts.format,
          dryRun:         opts.dryRun,
          inputOverride:  opts.in,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(message + '\n');
        _exitCode = exitCodeFor(err);
        return;
      }

      process.stdout.write(formatResult(result) + '\n');
      _exitCode = result.exitCode;
    });

  // -------------------------------------------------------------------------
  // classify  (v0.x stub — option definitions kept for correct --help output)
  // -------------------------------------------------------------------------

  program
    .command('classify')
    .description('Run the classification cascade on a target without projecting')
    .requiredOption('--target <name>', 'Target name from config')
    .option('--config <path>', 'Config file path', DEFAULT_CONFIG_PATH)
    .option('--in <path>', 'Input directory or file path override')
    .action((_opts: { target: string; config: string; in?: string }): void => {
      process.stdout.write(
        'classify subcommand not implemented in v0.x — coming with the classifier cascade lane\n',
      );
      _exitCode = 0;
    });

  // -------------------------------------------------------------------------
  // inspect  (v0.x stub — option definitions kept for correct --help output)
  // -------------------------------------------------------------------------

  program
    .command('inspect')
    .description('Inspect a single input JSON record through the classification cascade')
    .requiredOption('--file <path>', 'Path to a JSON record to inspect')
    .option('--config <path>', 'Config file path', DEFAULT_CONFIG_PATH)
    .action((_opts: { file: string; config?: string }): void => {
      process.stdout.write(
        'inspect subcommand not implemented in v0.x — coming with the classifier cascade lane\n',
      );
      _exitCode = 0;
    });


  // -------------------------------------------------------------------------
  // viz  — render a squashage JSON-LD file as a standalone HTML graph
  // -------------------------------------------------------------------------

  program
    .command('viz')
    .description('Render a squashage JSON-LD as a chunked interactive graph (sigma + WebGL)')
    .requiredOption('--in <path>', 'Path to a squashage-produced JSON-LD file')
    .option('--out <dir>', 'Output directory (default: <basename>/ next to --in)')
    .option('--title <string>', 'HTML page title (default: Squashage — <basename>)')
    .option('--iterations <n>', 'ForceAtlas2 iterations (default: 800 for >5k nodes, else 400)')
    .action(async (opts: { in: string; out?: string; title?: string; iterations?: string }): Promise<void> => {
      const inPath = resolve(opts.in);
      const inBase = basename(inPath, '.jsonld');
      const outDir = opts.out !== undefined
        ? resolve(opts.out)
        : join(pathDirname(inPath), inBase);
      const title  = opts.title ?? `Squashage — ${inBase}`;

      let doc: unknown;
      try {
        const raw = await readFile(inPath, 'utf-8');
        doc = JSON.parse(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`viz: cannot read/parse ${inPath}: ${msg}\n`);
        _exitCode = 1;
        return;
      }

      const payload            = await JsonLdGraph.fromJsonLd(doc);
      const explicitIterations = opts.iterations !== undefined ? Number(opts.iterations) : NaN;
      const iterations         = Number.isFinite(explicitIterations) && explicitIterations > 0
        ? explicitIterations
        : (payload.nodes.length > 5000 ? 800 : 400);

      try {
        const manifest = await ChunkBuilder.build(payload, { outDir, iterations });
        const html     = SigmaGraphRenderer.render({ title, indexUrl: './index.json' });
        await writeFile(join(outDir, `${inBase}.html`), html, 'utf-8');
        process.stdout.write(`viz: wrote ${manifest.length.toString()} chunks + index.json + HTML wrapper to ${outDir}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`viz: cannot write to ${outDir}: ${msg}\n`);
        _exitCode = 1;
        return;
      }

      _exitCode = 0;
    });

  return program;
}

// ---------------------------------------------------------------------------
// Exit-code carrier (module-scoped, test-harness-friendly)
// ---------------------------------------------------------------------------

/**
 * Shared exit-code carrier updated inside command actions.
 *
 * @remarks
 * Actions write to this variable rather than calling `process.exit` directly.
 * The production entry-point calls `process.exit(_exitCode)` after `parseAsync`
 * settles. This keeps the code testable — tests instantiate {@link buildCli}
 * and inspect option parsing without spawning a subprocess or triggering exits.
 *
 * @internal
 */
let _exitCode: 0 | 1 | 2 = 0;

// ---------------------------------------------------------------------------
// Production entry-point
// ---------------------------------------------------------------------------

// Guard the production entry-point so that tests importing this module do not
// trigger argv parsing. The specifier comparison is the standard ESM idiom for
// detecting the main module in Node.js.
const isMain = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  buildCli()
    .parseAsync(process.argv)
    .then((): void => {
      if (_exitCode !== 0) process.exit(_exitCode);
    })
    .catch((err: unknown): never => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(message + '\n');
      process.exit(exitCodeFor(err));
    });
}
