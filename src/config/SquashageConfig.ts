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
  required: ['input', 'pipeline', 'output'],
  properties: {
    input:          { type: 'string', minLength: 1 },
    pipeline:       { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
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
          required: ['onConflict', 'onUnknown', 'evidence'],
          properties: {
            onConflict: { type: 'string', enum: ['quarantine', 'pickPriority'] as const },
            onUnknown:  { type: 'string', enum: ['quarantine', 'skip'] as const },
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
      },
    },
    quarantine:     { type: 'object' },
    concurrency:    { type: 'integer', minimum: 1, default: 1 },
  },
} as const;

// ─── Root config schema ────────────────────────────────────────────────────────

const ROOT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://squashage.dev/schemas/squashage-config.json',
  title: 'Squashage Config',
  type: 'object',
  additionalProperties: false,
  required: ['input', 'targets'],
  properties: {
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['basePath', 'format'],
      properties: {
        basePath: { type: 'string', minLength: 1 },
        format:   { type: 'string', enum: ['json', 'jsonl'] as const },
      },
    },
    targets: {
      type: 'object',
      additionalProperties: { $ref: 'https://squashage.dev/schemas/target.json' },
      minProperties: 1,
    },
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
 * Validated per-target configuration for a squashage build target.
 *
 * @remarks
 * Produced by {@link SquashageConfig.loadFromFile} and {@link SquashageConfig.validate}
 * after AJV validation succeeds. The `output` field satisfies the
 * `PipelineContextInterface.output` slot.
 *
 * @example
 * ```ts
 * const cfg = SquashageConfig.loadFromFile('./squashage.config.json');
 * const target: TargetConfigInterface = cfg.targets['aonprd'];
 * ```
 *
 * @category Configuration
 * @since 2.2.0
 * @see {@link SquashageConfigInterface}
 * @group Types
 */
export interface TargetConfigInterface {
  /** Path to the input directory or file containing source JSON records. */
  readonly input: string;
  /** Ordered list of pipeline task names to execute per record. */
  readonly pipeline: ReadonlyArray<string>;
  /** Resolved output configuration (merged with CLI overrides at runtime). */
  readonly output: OutputConfigInterface;
  /** Named-graph IRIs keyed by lane name (e.g. `{ default: 'https://…' }`). */
  readonly graphs?: Readonly<Record<string, string>> | undefined;
  /** Ontology-specific settings (passed through to plugin tasks). */
  readonly ontology?: Readonly<Record<string, unknown>> | undefined;
  /** Classification cascade configuration (passed through to classifier). */
  readonly classification?: Readonly<Record<string, unknown>> | undefined;
  /** Quarantine bucket configuration (passed through to QuarantineWriter). */
  readonly quarantine?: Readonly<Record<string, unknown>> | undefined;
  /** Maximum concurrent pipeline executions (default 1). */
  readonly concurrency?: number | undefined;
}

/**
 * Validated top-level squashage configuration.
 *
 * @remarks
 * Produced by {@link SquashageConfig.loadFromFile} and {@link SquashageConfig.validate}
 * after AJV validation succeeds against the root squashage-config schema.
 *
 * @example
 * ```ts
 * const cfg: SquashageConfigInterface = SquashageConfig.loadFromFile('./squashage.config.json');
 * console.log(cfg.input.basePath);          // './output'
 * console.log(Object.keys(cfg.targets));    // ['aonprd']
 * ```
 *
 * @category Configuration
 * @since 2.2.0
 * @see {@link SquashageConfig}
 * @group Types
 */
export interface SquashageConfigInterface {
  /** Input source settings shared across all targets. */
  readonly input: {
    /** Base path to the directory containing source JSON input files. */
    readonly basePath: string;
    /** Input file format (one record per file for json; multiple per file for jsonl). */
    readonly format: 'json' | 'jsonl';
  };
  /** Map of target id → target configuration. Must have at least one entry. */
  readonly targets: Record<string, TargetConfigInterface>;
}

// ─── Cross-validation helper ───────────────────────────────────────────────────

/**
 * Set of `classify:*` task names that are class-proposers (not just gates).
 * When 2+ of these are in the pipeline, `classify:conflict` is required.
 *
 * @internal
 */
const CLASS_PROPOSERS = new Set<string>([
  'classify:structural',
  'classify:rules',
  'classify:schema',
  'classify:shacl-shape',
]);

/**
 * Map from classify task name to the classification config sub-key that must
 * be present when the task is in the pipeline.
 *
 * @internal
 */
const CLASSIFY_TASK_CONFIG_KEYS: Readonly<Record<string, string>> = {
  'classify:source':               'source',
  'classify:structural':           'structural',
  'classify:rules':                'rules',
  'classify:schema':               'schemas',
  'classify:ontology':             'ontology',
  'classify:conflict':             'conflict',
  'classify:shacl-shape':          'shaclShape',
  'classify:taxonomic-narrowing':  'taxonomicNarrowing',
};

/**
 * Performs cross-validation of a single target config after AJV schema
 * validation passes.
 *
 * @remarks
 * Validates that every `classify:*` task in the pipeline has a corresponding
 * `classification.*` config sub-key present. Also enforces that when ≥2
 * distinct class-proposing classifiers are in the pipeline
 * (`classify:structural`, `classify:rules`, `classify:schema`), the
 * `classify:conflict` task must be present.
 *
 * Also enforces that `output.jsonldContext` is only present when the resolved
 * format is `jsonld` (explicit `format: 'jsonld'` or a `.jsonld` path extension).
 *
 * @param target      - Target identifier for error messages.
 * @param targetConfig - Validated target config to cross-check.
 * @throws {SquashageConfigError} When a classify task is listed without its config sub-key.
 * @throws {SquashageConfigError} When ≥2 class-proposers are listed without `classify:conflict`.
 * @throws {SquashageConfigError} When `output.jsonldContext` is set but format is not jsonld.
 *
 * @internal
 */
function crossValidateTarget(target: string, targetConfig: TargetConfigInterface): void {
  const classification = targetConfig.classification as Record<string, unknown> | undefined;
  const pipeline = targetConfig.pipeline;

  // Validate each classify:* task has its config sub-key.
  for (const taskName of pipeline) {
    const configKey = CLASSIFY_TASK_CONFIG_KEYS[taskName];
    if (configKey === undefined) {
      // Not a classify task — skip.
      continue;
    }

    const configValue = classification?.[configKey];
    const isMissing =
      configValue === undefined ||
      configValue === null ||
      (configKey === 'source' && configValue !== true) ||
      (Array.isArray(configValue) && (configValue as unknown[]).length === 0) ||
      (configKey === 'ontology' &&
        typeof configValue === 'object' &&
        configValue !== null &&
        Object.keys((configValue as Record<string, unknown>)['classes'] as Record<string, unknown> ?? {}).length === 0);

    if (isMissing) {
      throw SquashageConfigError.create(
        `Pipeline lists "${taskName}" but classification.${configKey} is missing or empty`,
        { metadata: { target, task: taskName, configKey } },
      );
    }
  }

  // Enforce classify:conflict when ≥2 class-proposers are in the pipeline.
  const proposersInPipeline = pipeline.filter((name) => CLASS_PROPOSERS.has(name));
  const distinctProposers = new Set(proposersInPipeline);
  if (distinctProposers.size >= 2 && !pipeline.includes('classify:conflict')) {
    throw SquashageConfigError.create(
      `Pipeline includes ${distinctProposers.size} class-proposing classifiers ` +
      `(${[...distinctProposers].join(', ')}) but is missing "classify:conflict". ` +
      `When multiple class-proposers are active, the ConflictResolver must be ` +
      `present in the pipeline to pick the winning class.`,
      { metadata: { target, distinctProposers: [...distinctProposers] } },
    );
  }

  // Enforce jsonldContext is only set when output format resolves to jsonld.
  const output = targetConfig.output as Record<string, unknown>;
  const jsonldContext = output['jsonldContext'];
  if (jsonldContext !== undefined) {
    const format = output['format'] as string | undefined;
    const path   = output['path'] as string | undefined;
    const isJsonldFormat =
      format === 'jsonld' ||
      (format === undefined && path !== undefined && extname(path).toLowerCase() === '.jsonld');
    if (!isJsonldFormat) {
      throw SquashageConfigError.create(
        `output.jsonldContext is set on target "${target}" but the resolved output format is not "jsonld". ` +
        `Either set output.format to "jsonld", use a ".jsonld" output path extension, or remove jsonldContext.`,
        { metadata: { target, format, path } },
      );
    }
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
 * @see {@link SquashageConfigInterface}
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
   * @returns Validated {@link SquashageConfigInterface} object.
   * @throws {SquashageConfigError} When the file is missing, unparseable, or fails schema validation.
   *
   * @example
   * ```ts
   * const config = SquashageConfig.loadFromFile('./squashage.config.json');
   * ```
   */
  public static loadFromFile(path: string): SquashageConfigInterface {
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
   * target's `pipeline` vs `classification` config sub-keys, and for
   * `output.jsonldContext` vs the resolved output format.
   *
   * @param raw - Unknown value to validate.
   * @param configPath - Optional path shown in error messages for context.
   * @returns Validated {@link SquashageConfigInterface} object.
   * @throws {SquashageConfigError} When `raw` fails schema validation or cross-validation.
   *
   * @example
   * ```ts
   * const config = SquashageConfig.validate(JSON.parse(rawJson));
   * ```
   */
  public static validate(raw: unknown, configPath?: string): SquashageConfigInterface {
    const errors = SquashageConfigSchema.validate(raw);
    if (errors !== null) {
      const location = configPath !== undefined ? ` at ${configPath}` : '';
      log.error('validate', `Squashage config validation failed${location}`, { errors, configPath });
      throw SquashageConfigError.create(
        `Invalid squashage config${location}:\n  ${errors}`,
        { metadata: { configPath, errors } },
      );
    }

    const validated = raw as SquashageConfigInterface;

    // Cross-validate each target: pipeline classify tasks vs classification config,
    // and jsonldContext vs resolved output format.
    for (const [target, targetConfig] of Object.entries(validated.targets)) {
      crossValidateTarget(target, targetConfig);
    }

    log.debug('validate', 'Squashage config validated successfully', { configPath });
    return validated;
  }
}
