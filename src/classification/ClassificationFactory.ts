/**
 * @fileoverview `ClassificationFactory` — startup-time compiler for all six
 * classifier task classes.
 *
 * @remarks
 * Accepts raw classification config from a target's `classification` block,
 * compiles predicates via {@link Predicate.compile}, loads and AJV-compiles
 * JSON Schema files, and returns fully instantiated classifier task instances
 * whose bound `execute` methods are ready for {@link TaskRegistry.register}.
 *
 * All I/O (schema file reads) happens here, once per run at startup.
 * Per-record evaluators perform no I/O and no allocations beyond the
 * proposal array.
 *
 * @module
 * @since 2.2.0
 * @category Classification
 */

import { readFileSync } from 'node:fs';
import { resolve }       from 'node:path';

import AjvModule         from 'ajv';
import addFormatsModule   from 'ajv-formats';

import type { AjvCtorType, AddFormatsFnInterface } from '../types/AjvInterop.js';
import type { RawPredicate }                       from './predicates/Predicate.js';
import { Predicate }                               from './predicates/Predicate.js';
import { SourceClassifier }                        from './tasks/SourceClassifier.js';
import { StructuralClassifier }                    from './tasks/StructuralClassifier.js';
import type { StructuralRuleInterface }            from './tasks/StructuralClassifier.js';
import { RulesClassifier }                         from './tasks/RulesClassifier.js';
import type { RuleEntryInterface }                 from './tasks/RulesClassifier.js';
import { SchemaClassifier }                        from './tasks/SchemaClassifier.js';
import type { AjvClassEntryInterface }             from './AjvClassifier.js';
import { OntologyClassifier }                      from './tasks/OntologyClassifier.js';
import { ConflictResolver }                        from './tasks/ConflictResolver.js';
import type { ConflictResolverConfigInterface }    from './tasks/ConflictResolver.js';
import { ShaclShapeClassifier }                    from './tasks/ShaclShapeClassifier.js';
import type { ShaclShapeClassifierConfigInterface } from './tasks/ShaclShapeClassifier.js';
import { OutputConfigError }                       from '../errors/OutputConfigError.js';
import { Logger }                                  from '../modules/logger/logger.js';

// AJV 8.x dual-CJS/ESM; NodeNext resolves default on `.default`.
const Ajv        = (AjvModule        as unknown as { default?: AjvCtorType }).default        ?? (AjvModule        as unknown as AjvCtorType);
const addFormats = (addFormatsModule as unknown as { default?: AddFormatsFnInterface }).default ?? (addFormatsModule as unknown as AddFormatsFnInterface);

const logger = Logger.forComponent('ClassificationFactory');

// ── Raw config interfaces ─────────────────────────────────────────────────────

/**
 * A single raw structural rule entry as it appears in the target config's
 * `classification.structural[]` array.
 *
 * @category Classification
 * @since 2.2.0
 * @group Types
 */
export interface RawStructuralRuleInterface {
  /** Ontology class id proposed by this rule. */
  readonly className:  string;
  /** Numeric priority; ConflictResolver picks the highest. */
  readonly priority:   number;
  /** Raw predicate descriptor; compiled once at startup. */
  readonly predicate:  RawPredicate;
  /** Pre-defined human-readable evidence reasons. */
  readonly reasons:    ReadonlyArray<string>;
}

/**
 * A single raw rules entry as it appears in the target config's
 * `classification.rules[]` array.
 *
 * @category Classification
 * @since 2.2.0
 * @group Types
 */
export interface RawRuleEntryInterface {
  /** Ontology class id proposed by this rule. */
  readonly className:  string;
  /** Numeric priority; ConflictResolver picks the highest. */
  readonly priority:   number;
  /** Raw predicate descriptor; compiled once at startup. */
  readonly predicate:  RawPredicate;
  /** Pre-defined human-readable evidence reasons. */
  readonly reasons:    ReadonlyArray<string>;
}

/**
 * A single raw schema entry as it appears in the target config's
 * `classification.schemas[]` array.
 *
 * @category Classification
 * @since 2.2.0
 * @group Types
 */
export interface RawSchemaEntryInterface {
  /** Ontology class id proposed when the schema validates successfully. */
  readonly className:  string;
  /** Numeric priority; ConflictResolver picks the highest. */
  readonly priority:   number;
  /** Path to the JSON Schema file; resolved relative to `schemasBase`. */
  readonly schemaPath: string;
}

// ── Public factory interfaces ─────────────────────────────────────────────────

/**
 * Raw classification config block from a target's squashage configuration.
 *
 * @remarks
 * Each sub-key is independently optional. When a sub-key is present, the
 * corresponding classifier task class is instantiated and registered in the
 * per-run {@link TaskRegistry}. Absent sub-keys result in no instantiation —
 * the cross-validation hook in {@link SquashageConfig} ensures pipeline entries
 * always have matching config.
 *
 * @category Classification
 * @since 2.2.0
 * @see {@link ClassificationFactory}
 * @group Types
 */
export interface ClassificationConfigInterface {
  /** Marker for `classify:source`. When `true`, a SourceClassifier is instantiated. */
  readonly source?:     true | undefined;
  /** Config for `classify:structural`. Each entry is compiled at startup. */
  readonly structural?: ReadonlyArray<RawStructuralRuleInterface> | undefined;
  /** Config for `classify:rules`. Each entry is compiled at startup. */
  readonly rules?:      ReadonlyArray<RawRuleEntryInterface> | undefined;
  /** Config for `classify:schema`. Each entry's schema file is read and AJV-compiled at startup. */
  readonly schemas?:    ReadonlyArray<RawSchemaEntryInterface> | undefined;
  /** Config for `classify:ontology`. The `classes` map is frozen at startup. */
  readonly ontology?:   { readonly classes: Readonly<Record<string, string>> } | undefined;
  /** Config for `classify:conflict`. All three fields are required when present. */
  readonly conflict?:   ConflictResolverConfigInterface | undefined;
  /**
   * Config for `classify:shacl-shape`. Sits between structural (priority 30)
   * and ontology (priority 50) in the cascade by default (priority 45).
   */
  readonly shaclShape?: ShaclShapeClassifierConfigInterface | undefined;
}

/**
 * Compiled classifier task instances returned by {@link ClassificationFactory.build}.
 *
 * @remarks
 * Only the sub-keys whose config was present in the input
 * {@link ClassificationConfigInterface} are populated. Callers register the
 * bound `execute` of each present instance onto the per-run
 * {@link TaskRegistry}.
 *
 * @category Classification
 * @since 2.2.0
 * @see {@link ClassificationFactory}
 * @group Types
 */
export interface ClassifierInstancesInterface {
  /** Instantiated `classify:source` task, when `config.source === true`. */
  readonly 'classify:source'?:     SourceClassifier     | undefined;
  /** Instantiated `classify:structural` task, when `config.structural` is present. */
  readonly 'classify:structural'?: StructuralClassifier | undefined;
  /** Instantiated `classify:rules` task, when `config.rules` is present. */
  readonly 'classify:rules'?:      RulesClassifier      | undefined;
  /** Instantiated `classify:schema` task, when `config.schemas` is present. */
  readonly 'classify:schema'?:     SchemaClassifier     | undefined;
  /** Instantiated `classify:ontology` task, when `config.ontology` is present. */
  readonly 'classify:ontology'?:   OntologyClassifier   | undefined;
  /** Instantiated `classify:conflict` task, when `config.conflict` is present. */
  readonly 'classify:conflict'?:   ConflictResolver     | undefined;
  /** Instantiated `classify:shacl-shape` task, when `config.shaclShape` is present. */
  readonly 'classify:shacl-shape'?: ShaclShapeClassifier | undefined;
}

// ── ClassificationFactory ─────────────────────────────────────────────────────

/**
 * Static-only factory that compiles raw classification config into idiomatic
 * classifier task instances.
 *
 * @remarks
 * All I/O (schema file reads) and compile-time work (predicate compilation,
 * AJV schema compilation) happens in {@link ClassificationFactory.build}, once
 * per run at startup. The returned instances expose bound `execute` methods
 * that are pure and perform no I/O or allocations beyond the proposal array.
 *
 * @example
 * ```ts
 * const instances = ClassificationFactory.build(
 *   targetConfig.classification,
 *   './graphs',
 *   'aonprd',
 *   path.dirname(configPath),
 * );
 * if (instances['classify:rules'] !== undefined) {
 *   registry.register('classify:rules', instances['classify:rules'].execute);
 * }
 * ```
 *
 * @category Classification
 * @since 2.2.0
 * @see {@link ClassificationConfigInterface}
 * @see {@link ClassifierInstancesInterface}
 * @group Core
 */
export class ClassificationFactory {
  private constructor() { /* static-only */ }

  /**
   * Compile raw config into idiomatic classifier task instances.
   *
   * @remarks
   * Schemas are loaded and AJV-compiled at startup. Predicates are compiled
   * via {@link Predicate.compile}. Returned instances expose bound `execute`
   * {@link TaskFnInterface}s ready for {@link TaskRegistry.register}.
   *
   * @param config       - Raw classification config from the target.
   * @param outDir       - Run output directory (passed into ConflictResolver for quarantine).
   * @param targetId     - Target identifier (passed into ConflictResolver).
   * @param schemasBase  - Base directory for resolving relative `schemaPath` entries.
   * @returns Populated {@link ClassifierInstancesInterface}; keys present only when config sub-key is present.
   * @throws {OutputConfigError} When a referenced schema file is missing or invalid AJV.
   */
  public static build(
    config:      ClassificationConfigInterface,
    outDir:      string,
    targetId:    string,
    schemasBase: string,
  ): ClassifierInstancesInterface {
    logger.debug('build', 'Building classifier instances', { targetId, schemasBase });

    const result: Record<string, unknown> = {};

    // ── classify:source ────────────────────────────────────────────────────
    if (config.source === true) {
      logger.debug('build', 'Instantiating SourceClassifier', { targetId });
      result['classify:source'] = new SourceClassifier();
    }

    // ── classify:structural ────────────────────────────────────────────────
    if (config.structural !== undefined) {
      logger.debug('build', 'Compiling structural rules', {
        targetId,
        ruleCount: config.structural.length,
      });
      const compiledRules: StructuralRuleInterface[] = config.structural.map((raw) => ({
        className: raw.className,
        priority:  raw.priority,
        predicate: Predicate.compile(raw.predicate),
        reasons:   raw.reasons,
      }));
      result['classify:structural'] = new StructuralClassifier(compiledRules);
    }

    // ── classify:rules ─────────────────────────────────────────────────────
    if (config.rules !== undefined) {
      logger.debug('build', 'Compiling rules entries', {
        targetId,
        ruleCount: config.rules.length,
      });
      const compiledRules: RuleEntryInterface[] = config.rules.map((raw) => ({
        className: raw.className,
        priority:  raw.priority,
        predicate: Predicate.compile(raw.predicate),
        reasons:   raw.reasons,
      }));
      result['classify:rules'] = new RulesClassifier(compiledRules);
    }

    // ── classify:schema ────────────────────────────────────────────────────
    if (config.schemas !== undefined) {
      logger.debug('build', 'Compiling schema entries', {
        targetId,
        entryCount: config.schemas.length,
      });
      const schemaAjv = ClassificationFactory.#buildAjv();
      const entries: AjvClassEntryInterface[] = config.schemas.map((raw) => {
        const absPath = resolve(schemasBase, raw.schemaPath);
        logger.debug('build', 'Loading schema file', { targetId, absPath, className: raw.className });

        let schemaText: string;
        try {
          schemaText = readFileSync(absPath, 'utf-8');
        } catch (err) {
          const cause = err instanceof Error ? err : undefined;
          throw OutputConfigError.create(
            `classify:schema: cannot read schema file for class "${raw.className}" at ${absPath}: ${cause?.message ?? String(err)}`,
            { cause, metadata: { targetId, className: raw.className, schemaPath: absPath } },
          );
        }

        let schemaJson: unknown;
        try {
          schemaJson = JSON.parse(schemaText) as unknown;
        } catch (err) {
          const cause = err instanceof Error ? err : undefined;
          throw OutputConfigError.create(
            `classify:schema: cannot parse schema JSON for class "${raw.className}" at ${absPath}: ${cause?.message ?? String(err)}`,
            { cause, metadata: { targetId, className: raw.className, schemaPath: absPath } },
          );
        }

        let validate: AjvClassEntryInterface['validate'];
        try {
          validate = schemaAjv.compile(schemaJson as object);
        } catch (err) {
          const cause = err instanceof Error ? err : undefined;
          throw OutputConfigError.create(
            `classify:schema: AJV compilation failed for class "${raw.className}" at ${absPath}: ${cause?.message ?? String(err)}`,
            { cause, metadata: { targetId, className: raw.className, schemaPath: absPath } },
          );
        }

        return {
          className: raw.className,
          priority:  raw.priority,
          validate,
        };
      });

      result['classify:schema'] = new SchemaClassifier(entries);
    }

    // ── classify:ontology ──────────────────────────────────────────────────
    if (config.ontology !== undefined) {
      logger.debug('build', 'Instantiating OntologyClassifier', {
        targetId,
        classCount: Object.keys(config.ontology.classes).length,
      });
      result['classify:ontology'] = new OntologyClassifier({ classes: config.ontology.classes });
    }

    // ── classify:shacl-shape ───────────────────────────────────────────────
    if (config.shaclShape !== undefined) {
      logger.debug('build', 'Instantiating ShaclShapeClassifier', {
        targetId,
        shapesFrom: config.shaclShape.shapesFrom,
        priority:   config.shaclShape.priority ?? 45,
      });
      result['classify:shacl-shape'] = ShaclShapeClassifier.create(config.shaclShape, schemasBase);
    }

    // ── classify:conflict ──────────────────────────────────────────────────
    if (config.conflict !== undefined) {
      logger.debug('build', 'Instantiating ConflictResolver', { targetId, outDir });
      result['classify:conflict'] = new ConflictResolver(config.conflict, outDir, targetId);
    }

    logger.info('build', 'Classifier instances built', {
      targetId,
      tasks: Object.keys(result),
    });

    return result as ClassifierInstancesInterface;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Builds a private AJV instance for schema-classifier compilation.
   *
   * @remarks
   * Uses the same AJV options as the module-level instance in `SquashageConfig`:
   * `allErrors: true`, `strict: true`, `useDefaults: false`. `addFormats` is
   * applied so `format` keywords in user schemas resolve without warning.
   *
   * @returns A fresh, configured AJV instance.
   */
  static #buildAjv(): InstanceType<AjvCtorType> {
    const instance = new Ajv({ allErrors: true, strict: true, useDefaults: false });
    addFormats(instance);
    return instance;
  }
}
