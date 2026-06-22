import { readFileSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath }    from 'node:url';

import AjvModule, { type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

import type { AjvCtorType, AddFormatsFnInterface } from '../types/AjvInterop.js';
import type { ValidateResult } from '../types/Results.js';
import { Logger } from '../modules/logger/logger.js';
import { SquashageConfigError } from '../errors/SquashageConfigError.js';
import { OUTPUT_SCHEMA, type OutputConfigInterface } from './OutputConfig.js';

// AJV 8.x ships dual CJS/ESM; under NodeNext the runtime default lives on `.default`.
const Ajv        = (AjvModule        as unknown as { default?: AjvCtorType }).default        ?? (AjvModule        as unknown as AjvCtorType);
const addFormats = (addFormatsModule as unknown as { default?: AddFormatsFnInterface }).default ?? (addFormatsModule as unknown as AddFormatsFnInterface);

const log = Logger.forComponent('SquashageConfig');

// ─── Schemas directory ─────────────────────────────────────────────────────────
// Resolve the schemas directory relative to this source file so that
// predicate.schema.json can be loaded and registered for the classification
// $ref resolution in target.schema.json.
const _schemasDir = resolve(dirname(fileURLToPath(import.meta.url)), '../schemas');

function _loadSchema(name: string): object {
  const absPath = resolve(_schemasDir, name);
  const text = readFileSync(absPath, 'utf-8');
  return JSON.parse(text) as object;
}

// ─── Target schema ─────────────────────────────────────────────────────────────

const TARGET_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://squashage.dev/schemas/target.json',
  title: 'Squashage Target Config',
  type: 'object',
  additionalProperties: false,
  required: ['input', 'output'],
  properties: {
    input:          { type: 'string', minLength: 1 },
    output:         { $ref: 'https://squashage.dev/schemas/output.json' },
    graphs:         { type: 'object', additionalProperties: { type: 'string', format: 'uri' } },
    ontology: {
      type: 'object',
      properties: {
        engine:  { type: 'string', enum: ['map', 'json-tology'] as const },
        baseIRI: { type: 'string' },
        baseIri: { type: 'string' },
        schemas: {
          type: 'array',
          items: {
            type: 'object',
            required: ['schemaPath'] as const,
            properties: {
              schemaPath: { type: 'string' },
            },
          },
        },
        emit: {
          type: 'object',
          properties: {
            tbox:  { type: 'string' },
            shacl: { type: 'string' },
          },
        },
        classes: {
          type: 'object',
          additionalProperties: { type: 'string', format: 'uri' },
        },
        prefixes: { type: 'object' },
      },
      if:   {
        properties: { engine: { const: 'json-tology' } },
        required: ['engine'] as const,
      },
      then: {
        properties: {
          baseIRI: { type: 'string' },
          schemas: {
            type:  'array',
            items: { type: 'object', required: ['schemaPath'] as const, properties: { schemaPath: { type: 'string' } } },
          },
        },
        required: ['baseIRI', 'schemas'] as const,
      },
    },
    classification: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'boolean', const: true },
        structural: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['className', 'priority', 'predicate', 'reasons'],
            properties: {
              className: { type: 'string', minLength: 1 },
              priority:  { type: 'number' },
              predicate: { $ref: 'https://squashage.dev/schemas/predicate.json' },
              reasons:   { type: 'array', items: { type: 'string' } },
            },
          },
        },
        rules: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['className', 'priority', 'predicate', 'reasons'],
            properties: {
              className: { type: 'string', minLength: 1 },
              priority:  { type: 'number' },
              predicate: { $ref: 'https://squashage.dev/schemas/predicate.json' },
              reasons:   { type: 'array', items: { type: 'string' } },
            },
          },
        },
        schemas: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['className', 'priority', 'schemaPath'],
            properties: {
              className:  { type: 'string', minLength: 1 },
              priority:   { type: 'number' },
              schemaPath: { type: 'string', minLength: 1 },
            },
          },
        },
        ontology: {
          type: 'object',
          additionalProperties: false,
          required: ['classes'],
          properties: {
            classes: {
              type: 'object',
              additionalProperties: { type: 'string', format: 'uri' },
              minProperties: 1,
            },
          },
        },
        conflict: {
          type: 'object',
          additionalProperties: false,
          required: ['onConflict', 'evidence'],
          properties: {
            onConflict: { type: 'string', enum: ['quarantine', 'pickPriority'] as const },
            evidence:   { type: 'boolean' },
          },
        },
        shaclShape: {
          type: 'object',
          additionalProperties: false,
          required: ['shapesFrom'],
          properties: {
            shapesFrom: {
              oneOf: [
                { type: 'string', const: 'ontology' as const },
                { type: 'string', minLength: 1 },
              ],
            },
            priority: { type: 'integer', minimum: 0 },
          },
        },
        taxonomicNarrowing: {
          type: 'object',
          additionalProperties: false,
          required: ['tboxFrom'],
          properties: {
            tboxFrom: {
              oneOf: [
                { type: 'string', const: 'ontology' as const },
                { type: 'string', minLength: 1 },
              ],
            },
            enabled: { type: 'boolean' },
          },
        },
        urlPattern: {
          type: 'object',
          additionalProperties: false,
          required: ['patterns'],
          properties: {
            patterns: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['className', 'match'],
                properties: {
                  className: { type: 'string', minLength: 1 },
                  match:     { type: 'string', minLength: 1 },
                  priority:  { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
        propertyFingerprint: {
          type: 'object',
          additionalProperties: false,
          required: ['fingerprintsFrom'],
          properties: {
            fingerprintsFrom: { type: 'string', minLength: 1 },
            minMatchScore:    { type: 'number', minimum: 0, maximum: 1 },
            priority:         { type: 'integer', minimum: 0 },
          },
        },
        winknlpEntities: {
          type: 'object',
          additionalProperties: false,
          required: ['patterns'],
          properties: {
            patterns: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'patterns', 'className'],
                properties: {
                  name:      { type: 'string', minLength: 1 },
                  patterns:  {
                    type:     'array',
                    minItems: 1,
                    items:    { type: 'string', minLength: 1 },
                  },
                  className: { type: 'string', minLength: 1 },
                  priority:  { type: 'integer', minimum: 0 },
                },
              },
            },
            fields: {
              type:  'array',
              items: { type: 'string', minLength: 1 },
            },
          },
        },
        discriminator: {
          type: 'object',
          additionalProperties: false,
          required: ['from'],
          properties: {
            from:     { type: 'string', minLength: 1 },
            fallback: { type: 'string', minLength: 1 },
            priority: { type: 'integer', minimum: 0 },
            sanitize: { type: 'string', enum: ['verbatim', 'pascalCase', 'kebabToPascal'] as const },
          },
        },
      },
    },
    enrichment: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entityLink: {
          type: 'object',
          additionalProperties: false,
          required: ['engine', 'edgeIri', 'linkAgainst'],
          properties: {
            engine: {
              type: 'string',
              enum: ['winknlp'] as const,
            },
            fields: {
              type:  'array',
              items: { type: 'string', minLength: 1 },
            },
            edgeIri: {
              type:      'string',
              minLength: 1,
            },
            linkAgainst: {
              type:     'array',
              minItems: 1,
              items:    { type: 'string', minLength: 1 },
            },
            minConfidence: {
              type:    'number',
              minimum: 0,
              maximum: 1,
            },
          },
        },
      },
    },
    subjectIri: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'sanitize'] as const,
      properties: {
        from:     { type: 'string', minLength: 1 },
        sanitize: { type: 'string', enum: ['url-tail', 'url-host-path', 'slug', 'verbatim'] as const },
        fallback: { type: 'string', minLength: 1 },
      },
    },
    quarantine:     { type: 'object' },
    concurrency:    { type: 'integer', minimum: 1, default: 1 },
  },
} as const;

// ─── Root config schema (single-run) ──────────────────────────────────────────
// The root IS the run — no targets map.

const ROOT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://squashage.dev/schemas/squashage-config.json',
  title: 'Squashage Run Config',
  type: 'object',
  additionalProperties: false,
  required: ['input', 'output'],
  properties: {
    name:           { type: 'string', minLength: 1 },
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['basePath', 'format'],
      properties: {
        basePath: { type: 'string', minLength: 1 },
        format:   { type: 'string', enum: ['json', 'jsonl'] as const },
      },
    },
    output:         { $ref: 'https://squashage.dev/schemas/output.json' },
    graphs:         { type: 'object', additionalProperties: { type: 'string', format: 'uri' } },
    ontology:       { type: 'object' },
    classification: { type: 'object' },
    enrichment:     { type: 'object' },
    subjectIri: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'sanitize'] as const,
      properties: {
        from:     { type: 'string', minLength: 1 },
        sanitize: { type: 'string', enum: ['url-tail', 'url-host-path', 'slug', 'verbatim'] as const },
        fallback: { type: 'string', minLength: 1 },
      },
    },
    quarantine:  { type: 'object' },
    concurrency: { type: 'integer', minimum: 1, default: 1 },
  },
} as const;

// ─── AJV instance (all schemas registered so $ref resolves) ───────────────────
// Register predicate schema FIRST so target.schema's $ref resolves correctly.

const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: false });
addFormats(ajv);
ajv.addSchema(OUTPUT_SCHEMA);
ajv.addSchema(_loadSchema('predicate.schema.json'));
ajv.addSchema(TARGET_SCHEMA);

const _validate: ValidateFunction<object> = ajv.compile(ROOT_SCHEMA);

// ─── Public interface types ────────────────────────────────────────────────────

/**
 * Validated single-run squashage configuration.
 *
 * @remarks
 * Produced by {@link SquashageConfig.loadFromFile} and {@link SquashageConfig.validate}
 * after AJV validation succeeds against the root squashage-config schema. The root
 * object IS the run — there is no targets map. The optional `name` field acts as
 * the run slug used for graph IRI and output directory derivation.
 *
 * @example
 * ```ts
 * const cfg = SquashageConfig.loadFromFile('./squashage.config.json');
 * console.log(cfg.input.basePath);   // './output/aonprd'
 * console.log(cfg.output.kind);      // 'file'
 * ```
 *
 * @category Configuration
 * @since 2.3.0
 * @see {@link SquashageConfig}
 * @group Types
 */
export interface SquashageRunConfigInterface {
  /** Optional run name / slug used for graph IRI and output directory derivation. */
  readonly name?: string | undefined;
  /** Input source settings for this run. */
  readonly input: {
    /** Base path to the directory containing source JSON input files. */
    readonly basePath: string;
    /** Input file format (one record per file for json; multiple per file for jsonl). */
    readonly format: 'json' | 'jsonl';
  };
  /** Resolved output configuration (merged with CLI overrides at runtime). */
  readonly output: OutputConfigInterface;
  /** Named-graph IRIs keyed by lane name (e.g. `{ default: 'https://…' }`). */
  readonly graphs?: Readonly<Record<string, string>> | undefined;
  /** Ontology-specific settings (passed through to plugin tasks). */
  readonly ontology?: Readonly<Record<string, unknown>> | undefined;
  /** Classification cascade configuration (passed through to classifier). */
  readonly classification?: Readonly<Record<string, unknown>> | undefined;
  /** Enrichment configuration (passed through to enrichment tasks). */
  readonly enrichment?: Readonly<Record<string, unknown>> | undefined;
  /** Quarantine bucket configuration (passed through to QuarantineWriter). */
  readonly quarantine?: Readonly<Record<string, unknown>> | undefined;
  /** Maximum concurrent pipeline executions (default 1). */
  readonly concurrency?: number | undefined;
  /**
   * Subject-IRI derivation policy for this run.
   *
   * When absent, subject IRIs are derived from a sha1 hash of
   * `recordPath:recordLine` (legacy default).
   */
  readonly subjectIri?: {
    /** JSON Pointer into the record to read the candidate IRI value. */
    readonly from: string;
    /** Sanitize strategy applied to the resolved string. */
    readonly sanitize: 'url-tail' | 'url-host-path' | 'slug' | 'verbatim';
    /** JSON Pointer used when `from` resolves to undefined. */
    readonly fallback?: string | undefined;
  } | undefined;
}

/**
 * Backward-compatible alias for {@link SquashageRunConfigInterface}.
 *
 * @remarks
 * Callers that previously imported `TargetConfigInterface` continue to work
 * without modification. New code should prefer `SquashageRunConfigInterface`.
 *
 * @category Configuration
 * @since 2.2.0
 * @group Types
 */
export interface TargetConfigInterface {
  /** Optional run name / slug. */
  readonly name?: string | undefined;
  /** Input source settings for this run. */
  readonly input: {
    readonly basePath: string;
    readonly format: 'json' | 'jsonl';
  };
  /** Resolved output configuration. */
  readonly output: OutputConfigInterface;
  readonly graphs?: Readonly<Record<string, string>> | undefined;
  readonly ontology?: Readonly<Record<string, unknown>> | undefined;
  readonly classification?: Readonly<Record<string, unknown>> | undefined;
  readonly enrichment?: Readonly<Record<string, unknown>> | undefined;
  readonly quarantine?: Readonly<Record<string, unknown>> | undefined;
  readonly concurrency?: number | undefined;
  readonly subjectIri?: {
    readonly from: string;
    readonly sanitize: 'url-tail' | 'url-host-path' | 'slug' | 'verbatim';
    readonly fallback?: string | undefined;
  } | undefined;
}

// ─── Cross-validation helper ───────────────────────────────────────────────────

/**
 * Enforces that `output.jsonldContext` is only present when the resolved
 * output format is `jsonld` (explicit `format: 'jsonld'` or a `.jsonld`
 * path extension).
 *
 * @remarks
 * Per-plugin AJV schemas (compiled at each plugin's `onRunStart` via
 * `ctx.ajv.compile(...)`) now own classification config-namespace and shape
 * validation, and the orchestrator enforces the proposer-count + conflict
 * requirement at startup via `TaskRegistry.manifests()`. Only the
 * `output.jsonldContext` rule remains here — it spans `output.format` and
 * `output.path`, neither of which a single plugin owns.
 *
 * @param target       - Target identifier for error messages.
 * @param targetConfig - Validated target config to cross-check.
 * @throws {SquashageConfigError} When `output.jsonldContext` is set but the resolved format is not jsonld.
 *
 * @internal
 */
function validateOutputJsonldContext(runConfig: SquashageRunConfigInterface): void {
  const output = runConfig.output as Record<string, unknown>;
  const jsonldContext = output['jsonldContext'];
  if (jsonldContext === undefined) return;

  const format = output['format'] as string | undefined;
  const path   = output['path'] as string | undefined;
  const isJsonldFormat =
    format === 'jsonld' ||
    (format === undefined && path !== undefined && extname(path).toLowerCase() === '.jsonld');
  if (!isJsonldFormat) {
    const run = runConfig.name ?? '(run)';
    throw SquashageConfigError.create(
      `output.jsonldContext is set on run "${run}" but the resolved output format is not "jsonld". ` +
      `Either set output.format to "jsonld", use a ".jsonld" output path extension, or remove jsonldContext.`,
      { metadata: { run, format, path } },
    );
  }
}

// ─── Schema class ──────────────────────────────────────────────────────────────

/**
 * Validates raw unknown data against the squashage-config root schema.
 *
 * @remarks
 * Provides the `validate` surface consumed by {@link SquashageConfig}.
 * All methods and the AJV instance are module-private; only `ValidateResult`
 * is exposed through {@link SquashageConfig.validate}.
 *
 * @category Schema
 * @since 2.2.0
 * @see {@link SquashageConfig}
 * @group Schema
 */
class SquashageConfigSchema {
  private constructor() { /* static-only */ }

  /**
   * Validates data against the squashage-config root schema.
   *
   * @param data - Unknown value to validate.
   * @returns `null` when `data` is valid; a human-readable error string otherwise.
   */
  public static validate(data: unknown): ValidateResult {
    if (_validate(data as object)) return null;
    return ajv.errorsText(_validate.errors, { separator: '\n  ' });
  }
}

// ─── Loader class ─────────────────────────────────────────────────────────────

/**
 * Synchronous loader and AJV validator for squashage configuration files.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated. Uses synchronous
 * I/O with three registered AJV schemas (output, target, root) so callers can
 * load config at startup without top-level `await`.
 *
 * Throws {@link SquashageConfigError} on I/O failure, JSON parse failure, or
 * AJV schema violation. The error message includes the absolute config path
 * and a human-readable description of every violation.
 *
 * @example
 * ```ts
 * const config = SquashageConfig.loadFromFile('./squashage.config.json');
 * const target = config.targets['aonprd'];
 * console.log(target.output.path);   // './graphs/aonprd.jsonld'
 * ```
 *
 * @category Configuration
 * @since 2.2.0
 * @see {@link SquashageRunConfigInterface}
 * @see {@link SquashageConfigError}
 * @group Core
 */
export class SquashageConfig {
  private constructor() { /* static-only */ }

  /**
   * Reads and AJV-validates a squashage JSON config file synchronously.
   *
   * @remarks
   * The config path is resolved to an absolute path relative to the current
   * working directory before reading. Synchronous I/O is intentional — config
   * loading occurs at process startup before any async pipeline work begins.
   *
   * @param path - Path to the squashage config JSON file (resolved to absolute).
   * @returns Validated {@link SquashageRunConfigInterface} object.
   * @throws {SquashageConfigError} When the file is missing, unparseable, or fails schema validation.
   *
   * @example
   * ```ts
   * const config = SquashageConfig.loadFromFile('./squashage.config.json');
   * ```
   */
  public static loadFromFile(path: string): SquashageRunConfigInterface {
    const abs = resolve(path);
    log.info('loadFromFile', `Loading squashage config from ${abs}`, { path: abs });

    let text: string;
    try {
      text = readFileSync(abs, 'utf-8');
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      log.error('loadFromFile', `Failed to read config file: ${abs}`, { path: abs });
      throw SquashageConfigError.create(
        `Cannot read squashage config at ${abs}: ${cause?.message ?? String(err)}`,
        { cause, metadata: { configPath: abs } },
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      log.error('loadFromFile', `Failed to parse config JSON: ${abs}`, { path: abs });
      throw SquashageConfigError.create(
        `Cannot parse squashage config at ${abs}: ${cause?.message ?? String(err)}`,
        { cause, metadata: { configPath: abs } },
      );
    }

    return SquashageConfig.validate(raw, abs);
  }

  /**
   * Validates a raw unknown value against the squashage-config schema.
   *
   * @remarks
   * Pure validation with no I/O. Useful for callers that have already parsed
   * the config JSON (e.g. from an environment variable or a test fixture).
   *
   * After AJV schema validation passes, cross-validation is performed for each
   * target's `output.jsonldContext` vs the resolved output format.
   * (Classify task config-namespace and proposer-count rules now live in the
   * per-plugin AJV schemas and the orchestrator's startup manifest check.)
   *
   * @param raw - Unknown value to validate.
   * @param configPath - Optional path shown in error messages for context.
   * @returns Validated {@link SquashageRunConfigInterface} object.
   * @throws {SquashageConfigError} When `raw` fails schema validation or cross-validation.
   *
   * @example
   * ```ts
   * const config = SquashageConfig.validate(JSON.parse(rawJson));
   * ```
   */
  public static validate(raw: unknown, configPath?: string): SquashageRunConfigInterface {
    const errors = SquashageConfigSchema.validate(raw);
    if (errors !== null) {
      const location = configPath !== undefined ? ` at ${configPath}` : '';
      log.error('validate', `Squashage config validation failed${location}`, { errors, configPath });
      throw SquashageConfigError.create(
        `Invalid squashage config${location}:\n  ${errors}`,
        { metadata: { configPath, errors } },
      );
    }

    const validated = raw as SquashageRunConfigInterface;

    // Cross-validate: jsonldContext vs resolved output format.
    validateOutputJsonldContext(validated);

    log.debug('validate', 'Squashage config validated successfully', { configPath });
    return validated;
  }
}
