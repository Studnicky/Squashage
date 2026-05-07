/**
 * @fileoverview `JsonTologyOntology`: typed projection from JSON Schema to OWL TBox,
 *               SHACL shapes, and ABox quads via the json-tology integration.
 *
 * @remarks
 * This is the foundational scaffold for v0.5.0 (Phase 1). The class wraps a
 * single {@link JsonTology} registry scoped to one Squashage target. It exposes:
 *
 * - {@link JsonTologyOntology.classMap}: synchronous `name → IRI` derivation
 *   (matches the legacy {@link OntologyConfigInterface.classes} flat map).
 * - {@link JsonTologyOntology.tbox}: async OWL TBox quad extraction.
 * - {@link JsonTologyOntology.shacl}: async SHACL shape quad extraction.
 * - {@link JsonTologyOntology.toQuads}: async ABox projection per record.
 *
 * Class IRIs are derived from `${baseIRI}#${className}` where `className` comes
 * from the schema's `title` field, falling back to the last `$id` segment.
 * Validation is eager: missing titles + non-derivable `$id`s raise at construction.
 *
 * The integration uses json-tology's {@link OntologyBuilder}-based `jsonLd()` /
 * `shaclObject()` outputs and converts them into `@rdfjs/types` quads through
 * Squashage's existing {@link Parser}, keeping a single source of truth for
 * RDF parsing across the pipeline.
 *
 * @module
 * @category Ontology
 * @since 0.5.0
 */

import { JsonTology, OntologyBuilder } from 'json-tology';

import type { Quad } from '@rdfjs/types';
import { Parser } from '../rdf/Parser.js';
import { OutputConfigError } from '../errors/OutputConfigError.js';
import { Logger } from '../modules/logger/logger.js';

const logger = Logger.forComponent('JsonTologyOntology');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Raw schema entry as it appears in the per-target ontology block.
 *
 * @remarks
 * The `schemaPath` is resolved relative to the config directory; the loader
 * reads the file once at config-load time and supplies the parsed content
 * via {@link JsonTologySchemaInputInterface.schema}.
 *
 * @category Ontology
 * @since 0.5.0
 * @group Types
 */
export interface JsonTologySchemaInputInterface {
  /** Filesystem path the schema came from; preserved for diagnostics. */
  readonly schemaPath: string;
  /** Loaded JSON Schema object with a required `$id`. */
  readonly schema:     Record<string, unknown> & { readonly '$id': string };
}

/**
 * Constructor options for {@link JsonTologyOntology.create}.
 *
 * @category Ontology
 * @since 0.5.0
 * @group Types
 */
export interface JsonTologyOntologyOptionsInterface {
  /** Target's base IRI; class IRIs are derived as `${baseIRI}#${className}`. */
  readonly baseIRI: string;
  /** Pre-loaded schemas (loader resolves files; constructor stays pure). */
  readonly schemas: ReadonlyArray<JsonTologySchemaInputInterface>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derives a `className` from a schema's `title`, falling back to the last
 * `$id` URL segment when `title` is absent.
 *
 * @internal
 */
function deriveClassName(schema: Record<string, unknown> & { readonly '$id': string }): string {
  const title = schema['title'];
  if (typeof title === 'string' && title.length > 0) {
    return title;
  }
  const id = schema.$id;
  const segments = id.split(/[/#]/).filter(s => s.length > 0);
  const last = segments.length > 0 ? segments[segments.length - 1] : undefined;
  if (last === undefined || last.length === 0) {
    throw OutputConfigError.create(
      `Cannot derive className from schema "$id": "${id}" (supply an explicit "title" field or a $id with a non-empty trailing segment)`,
      { metadata: { schemaId: id } },
    );
  }
  return last;
}

/**
 * Builds the canonical class IRI for a className under a base IRI, using
 * `${baseIRI}#${className}` (with at most one `#` separator).
 *
 * @internal
 */
function buildClassIri(baseIRI: string, className: string): string {
  // Strip a trailing '#' or '/' before concatenation so we don't double up.
  let trimmed = baseIRI;
  while (trimmed.endsWith('#') || trimmed.endsWith('/')) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}#${className}`;
}

// ---------------------------------------------------------------------------
// JsonTologyOntology
// ---------------------------------------------------------------------------

/**
 * Wraps a json-tology registry scoped to one Squashage target and exposes
 * the four surfaces Squashage's classifier and finalize layers consume.
 *
 * @remarks
 * Construction is the only place I/O may occur (schema files are pre-loaded
 * by the caller, so even construction is pure). The TBox + SHACL outputs are
 * computed lazily and cached on first access.
 *
 * @example
 * ```ts
 * const ontology = JsonTologyOntology.create({
 *   baseIRI: 'https://squashage.dev/vocabulary/aonprd',
 *   schemas: [
 *     { schemaPath: './schemas/feat.schema.json',  schema: featSchema  },
 *     { schemaPath: './schemas/spell.schema.json', schema: spellSchema },
 *   ],
 * });
 *
 * const map = ontology.classMap();           // { feat: 'https://…#feat', … }
 * const tbox = await ontology.tbox();        // OWL Quad[]
 * const shacl = await ontology.shacl();      // SHACL Quad[]
 * const abox = await ontology.toQuads(featSchemaId, instance);
 * ```
 *
 * @category Ontology
 * @since 0.5.0
 * @see {@link JsonTologyOntologyOptionsInterface}
 * @group Core
 */
export class JsonTologyOntology {
  /**
   * Builds a {@link JsonTologyOntology} instance from a baseIRI and a list of
   * pre-loaded schemas.
   *
   * @param options - Configuration: baseIRI and pre-loaded schemas.
   * @returns A fully initialised instance; method calls are pure (cache-on-first-use).
   * @throws {OutputConfigError} When `schemas` is empty, when a schema lacks `$id`,
   *   or when className derivation fails (no title and degenerate `$id`).
   */
  public static create(options: JsonTologyOntologyOptionsInterface): JsonTologyOntology {
    if (options.schemas.length === 0) {
      throw OutputConfigError.create(
        'JsonTologyOntology requires at least one schema; received an empty schemas[] array',
        { metadata: { baseIRI: options.baseIRI } },
      );
    }

    // Build the className → IRI map and the className → schema lookup eagerly so
    // any derivation failure surfaces at construction, not at first use.
    const classMap: Record<string, string> = {};
    const schemasByClassName: Record<string, Record<string, unknown> & { readonly '$id': string }> = {};
    const schemasById: Record<string, Record<string, unknown> & { readonly '$id': string }> = {};

    for (const entry of options.schemas) {
      const id = entry.schema.$id;
      if (typeof id !== 'string' || id.length === 0) {
        throw OutputConfigError.create(
          `Schema at "${entry.schemaPath}" is missing a valid string "$id"`,
          { metadata: { schemaPath: entry.schemaPath } },
        );
      }
      const className = deriveClassName(entry.schema);
      const iri = buildClassIri(options.baseIRI, className);

      if (className in classMap) {
        throw OutputConfigError.create(
          `Duplicate className "${className}" derived from schemas; titles and $id-derived names must be unique within a target's ontology block`,
          { metadata: { className, schemaPath: entry.schemaPath } },
        );
      }
      classMap[className]               = iri;
      schemasByClassName[className]     = entry.schema;
      schemasById[id]                   = entry.schema;
    }

    // Construct the underlying json-tology registry once with all schemas.
    const jt = JsonTology.create({
      baseIRI: options.baseIRI,
      schemas: options.schemas.map(entry => entry.schema) as unknown as ReadonlyArray<{ readonly '$id': string }>,
    });

    logger.debug('create', 'JsonTologyOntology constructed', {
      baseIRI:    options.baseIRI,
      classCount: Object.keys(classMap).length,
    });

    return new JsonTologyOntology(options.baseIRI, classMap, schemasByClassName, schemasById, jt);
  }

  // ── Instance fields ─────────────────────────────────────────────────────

  readonly #baseIRI:            string;
  readonly #classMap:           Readonly<Record<string, string>>;
  readonly #schemasByClassName: Readonly<Record<string, Record<string, unknown> & { readonly '$id': string }>>;
  readonly #schemasById:        Readonly<Record<string, Record<string, unknown> & { readonly '$id': string }>>;
  readonly #jt:                 ReturnType<typeof JsonTology.create>;
  #tboxCache:  ReadonlyArray<Quad> | null = null;
  #shaclCache: ReadonlyArray<Quad> | null = null;

  private constructor(
    baseIRI:            string,
    classMap:           Record<string, string>,
    schemasByClassName: Record<string, Record<string, unknown> & { readonly '$id': string }>,
    schemasById:        Record<string, Record<string, unknown> & { readonly '$id': string }>,
    jt:                 ReturnType<typeof JsonTology.create>,
  ) {
    this.#baseIRI             = baseIRI;
    this.#classMap            = Object.freeze({ ...classMap });
    this.#schemasByClassName  = Object.freeze({ ...schemasByClassName });
    this.#schemasById         = Object.freeze({ ...schemasById });
    this.#jt                  = jt;
  }

  // ── Public surface ─────────────────────────────────────────────────────

  /**
   * Returns the base IRI configured at construction (after stripping any
   * trailing separator).
   */
  public baseIRI(): string {
    return this.#baseIRI;
  }

  /**
   * Returns the derived `className → classIRI` map, mirroring the legacy
   * `classification.ontology.classes` flat map. Suitable as a drop-in for
   * {@link OntologyClassifier}'s `classes` parameter.
   */
  public classMap(): Readonly<Record<string, string>> {
    return this.#classMap;
  }

  /**
   * Returns the registered schema for a given className, or `undefined` when
   * none matches. Useful for plugin code that wants to map a classification
   * result back to its source schema.
   */
  public schemaForClassName(className: string): Record<string, unknown> & { readonly '$id': string } | undefined {
    return this.#schemasByClassName[className];
  }

  /**
   * Returns the OWL TBox quads (class declarations, property declarations,
   * domain/range, cardinality) derived from every registered schema.
   *
   * @remarks
   * Computed once on first call and cached for the lifetime of the instance.
   * The conversion path is `jt.toTbox().jsonLd()` → JSON-LD string →
   * {@link Parser} → `@rdfjs/types` Quads, so the returned quads are fully
   * compatible with Squashage's existing serialization pipeline.
   */
  public async tbox(): Promise<ReadonlyArray<Quad>> {
    if (this.#tboxCache !== null) return this.#tboxCache;
    const builder = this.#jt.toTbox();
    const text    = builder.jsonLd();
    const parsed  = await Parser.parse(text, { format: 'jsonld' });
    this.#tboxCache = parsed.quads;
    return parsed.quads;
  }

  /**
   * Returns the SHACL shape quads (NodeShape + property shape constraints)
   * derived from every registered schema.
   *
   * @remarks
   * Computed once on first call and cached. Same conversion path as
   * {@link JsonTologyOntology.tbox} but reads from `jt.toShacl()`.
   */
  public async shacl(): Promise<ReadonlyArray<Quad>> {
    if (this.#shaclCache !== null) return this.#shaclCache;
    const builder = this.#jt.toShacl();
    const text    = JSON.stringify(builder.shaclObject(), null, 2);
    const parsed  = await Parser.parse(text, { format: 'jsonld' });
    this.#shaclCache = parsed.quads;
    return parsed.quads;
  }

  /**
   * Projects a single instance to ABox quads for the given schema.
   *
   * @param schemaId - The `$id` of a schema registered at construction time.
   * @param instance - Instance data conforming to the schema.
   * @returns The projected quads as `@rdfjs/types` Quads.
   * @throws {OutputConfigError} When `schemaId` is not registered.
   */
  public async toQuads(schemaId: string, instance: unknown): Promise<ReadonlyArray<Quad>> {
    const schema = this.#schemasById[schemaId];
    if (schema === undefined) {
      throw OutputConfigError.create(
        `JsonTologyOntology.toQuads: no schema registered with $id "${schemaId}"`,
        { metadata: { schemaId, registered: Object.keys(this.#schemasById) } },
      );
    }
    // toQuads on the JsonTology instance returns json-tology QuadInterface[];
    // we re-encode to JSON-LD via a fresh ABox-only OntologyBuilder so the
    // returned quads contain only the instance projection (no TBox/SHACL).
    const jtQuads = this.#jt.toQuads(schema, instance);
    if (jtQuads.length === 0) return [];

    // Cast to OntologyBuilder's expected QuadInterface[]; they're the same shape
    // structurally; the type-import boundary is what's tight.
    const aboxBuilder = new OntologyBuilder({
      baseIRI:      this.#baseIRI,
      graphSources: [],
      prefixes:     {},
    }).addQuads(jtQuads as unknown as Parameters<typeof OntologyBuilder.prototype.addQuads>[0]);
    const text   = JSON.stringify(aboxBuilder.jsonLdObject(), null, 2);
    const parsed = await Parser.parse(text, { format: 'jsonld' });
    return parsed.quads;
  }
}
