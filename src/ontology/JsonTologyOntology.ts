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
 * Class IRIs are derived as `${baseIRI}/${className}` (path-form, no fragment)
 * where `className` comes from the schema's `title` field, falling back to the
 * last `$id` segment.
 * Validation is eager: missing titles + non-derivable `$id`s raise at construction.
 *
 * Every output path delegates directly to json-tology's spec-conformant
 * `@rdfjs/types` Quads:
 *   - `toQuads(schemaId, instance)` → `JsonTology#toQuads`
 *   - `tbox()`  → `OntologyBuilder.quads()`
 *   - `shacl()` → `OntologyBuilder.shaclQuads()`
 *
 * No JSON-LD round-trip; no adapter layer.
 *
 * @module
 * @category Ontology
 * @since 0.5.0
 */

import { JsonTology, Curie } from '@studnicky/json-tology';
import type { ValidationErrors } from '@studnicky/json-tology';

import type { Quad, NamedNode, Literal } from '@rdfjs/types';
import { dataFactory } from '../rdf/DataFactory.js';
import { OutputConfigError } from '../errors/OutputConfigError.js';
import { Logger } from '../modules/logger/logger.js';

const logger = Logger.forComponent('JsonTologyOntology');

// ---------------------------------------------------------------------------
// $ref denormalization helpers (transient workaround)
// ---------------------------------------------------------------------------

/**
 * TRANSIENT WORKAROUND for json-tology issue #126.
 * (https://github.com/Studnicky/json-tology/issues/126)
 *
 * json-tology 0.14.0's ABox projection silently drops object properties
 * referenced via cross-schema $ref. We inline-resolve $refs ourselves into
 * a denormalized schema set used ONLY for toQuads() calls. TBox + SHACL
 * emission stays on the original strict-graph schemas (those work correctly).
 *
 * REMOVE when json-tology #126 ships a fix. After removal, toQuads can route
 * through #jt directly like tbox()/shacl() already do.
 */

/** Keys to strip when inlining a referenced schema's body into a property slot. */
const SCHEMA_META_KEYS = new Set(['$id', '$schema', 'title']);

/**
 * Returns a deep clone of `value`, pruning top-level keys listed in `omit`
 * when `value` is a plain object.
 *
 * @internal
 */
function cloneOmitting(
  value: unknown,
  omit: ReadonlySet<string>,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => cloneOmitting(item, omit));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (omit.has(k)) continue;
    out[k] = cloneOmitting(v, new Set()); // only strip meta at top level
  }
  return out;
}

/**
 * Deep-clones an arbitrary value with full recursion (no key stripping).
 *
 * @internal
 */
function deepClone(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepClone);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepClone(v);
  }
  return out;
}

/**
 * Inline-resolves a single property body.
 *
 * Handles three forms:
 *
 * 1. `{ "$ref": "<id>" }` — pure $ref: inline the target schema's body.
 * 2. `{ "items": { "$ref": "<id>" }, "type": "array" }` — array with $ref items:
 *    inline the items $ref so nested object properties flow through projection.
 * 3. Anything else: return the body unchanged (deep-cloned at the call site).
 *
 * For pure-$ref inlining: the target body is cloned minus `$id`/`$schema`/`title`,
 * sibling annotations from the original body are merged in (non-overwriting),
 * and the result is recursed to inline its own nested `$ref` properties.
 *
 * Uses `visited` to prevent cycles. Caps recursion at `maxDepth` (depth 4).
 * Returns the body unchanged when: not a recognizable $ref form, target not
 * found, or depth cap hit.
 *
 * @internal
 */
function inlinePropertyBody(
  body: Record<string, unknown>,
  schemasById: Readonly<Record<string, Record<string, unknown> & { readonly '$id': string }>>,
  visited: ReadonlySet<string>,
  depth: number,
  maxDepth: number,
): Record<string, unknown> {
  if (depth >= maxDepth) return body;

  const ref = body['$ref'];

  // ── Case 1: pure $ref property ────────────────────────────────────────────
  if (typeof ref === 'string') {
    // Strip fragment (#...) when resolving — the $id is the base IRI.
    const targetId = ref.split('#')[0] ?? ref;
    const target = schemasById[targetId];

    if (target === undefined || visited.has(targetId)) {
      return body;
    }

    // Build the inlined body from the target schema, stripping meta-keys.
    const inlined = cloneOmitting(target, SCHEMA_META_KEYS) as Record<string, unknown>;

    // Copy sibling annotations from the original body (e.g. x-squashage-*, format).
    for (const [k, v] of Object.entries(body)) {
      if (k !== '$ref' && !(k in inlined)) {
        inlined[k] = deepClone(v);
      }
    }

    // Recurse into the inlined properties.
    const nextVisited = new Set(visited).add(targetId);
    return recurseProperties(inlined, schemasById, nextVisited, depth + 1, maxDepth);
  }

  // ── Case 2: array schema with items.$ref ──────────────────────────────────
  const items = body['items'];
  if (
    body['type'] === 'array' &&
    items !== null && typeof items === 'object' && !Array.isArray(items)
  ) {
    const itemsObj = items as Record<string, unknown>;
    const itemsRef = itemsObj['$ref'];
    if (typeof itemsRef === 'string') {
      const inlinedItems = inlinePropertyBody(itemsObj, schemasById, visited, depth, maxDepth);
      if (inlinedItems !== itemsObj) {
        // Return a new property body with inlined items.
        return { ...body, items: inlinedItems };
      }
    }
  }

  return body;
}

/**
 * Walks the `properties` map of a schema object and inline-resolves any
 * `$ref` property bodies. Also handles `items.$ref` in array properties
 * and `allOf` entries that are pure `$ref`s (merges parent properties one
 * level deep).
 *
 * Returns a new schema object (deep clone with substitutions applied).
 *
 * @internal
 */
function recurseProperties(
  schema: Record<string, unknown>,
  schemasById: Readonly<Record<string, Record<string, unknown> & { readonly '$id': string }>>,
  visited: ReadonlySet<string>,
  depth: number,
  maxDepth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };

  // ── Inline $ref properties ────────────────────────────────────────────────
  const props = schema['properties'];
  if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
    const newProps: Record<string, unknown> = {};
    for (const [propName, propBody] of Object.entries(props as Record<string, unknown>)) {
      if (propBody !== null && typeof propBody === 'object' && !Array.isArray(propBody)) {
        newProps[propName] = inlinePropertyBody(
          propBody as Record<string, unknown>,
          schemasById,
          visited,
          depth,
          maxDepth,
        );
      } else {
        newProps[propName] = deepClone(propBody);
      }
    }
    out['properties'] = newProps;
  }

  // ── Inline items.$ref for arrays ──────────────────────────────────────────
  const items = schema['items'];
  if (items !== null && typeof items === 'object' && !Array.isArray(items)) {
    const itemsObj = items as Record<string, unknown>;
    if (typeof itemsObj['$ref'] === 'string') {
      out['items'] = inlinePropertyBody(itemsObj, schemasById, visited, depth, maxDepth);
    }
  }

  // ── Merge allOf $ref parent properties (one level) ───────────────────────
  const allOf = schema['allOf'];
  if (Array.isArray(allOf)) {
    for (const entry of allOf) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const entryObj = entry as Record<string, unknown>;
      const ref = entryObj['$ref'];
      if (typeof ref !== 'string') continue;
      const targetId = ref.split('#')[0] ?? ref;
      const parent = schemasById[targetId];
      if (parent === undefined || visited.has(targetId)) continue;
      const parentProps = parent['properties'];
      if (parentProps !== null && typeof parentProps === 'object' && !Array.isArray(parentProps)) {
        const existingProps = (out['properties'] ?? {}) as Record<string, unknown>;
        const mergedProps: Record<string, unknown> = {};
        // Parent properties provide the base; child properties win on collision.
        for (const [k, v] of Object.entries(parentProps as Record<string, unknown>)) {
          if (!(k in existingProps)) {
            mergedProps[k] = deepClone(v);
          }
        }
        out['properties'] = { ...existingProps, ...mergedProps };
      }
    }
  }

  return out;
}

/**
 * Builds a denormalized schema: a deep clone of `schema` where every
 * `properties.<name>.$ref` pointing to a known `schemasById` entry is
 * replaced with the target schema's body (minus `$id`/`$schema`/`title`).
 *
 * The `$id` and `title` of the root schema are preserved so json-tology can
 * still identify and mint IRIs for it.
 *
 * Recursion is capped at depth 4. Cycles are prevented via a `visited` Set.
 *
 * @internal
 */
function buildDenormalizedSchema(
  schema: Record<string, unknown> & { readonly '$id': string },
  schemasById: Readonly<Record<string, Record<string, unknown> & { readonly '$id': string }>>,
): Record<string, unknown> & { readonly '$id': string } {
  const MAX_DEPTH = 4;
  const visited = new Set<string>([schema.$id]);
  const result = recurseProperties(schema, schemasById, visited, 0, MAX_DEPTH);
  // Preserve $id and title on the root so json-tology can identify the schema.
  result['$id']   = schema.$id;
  if ('title' in schema) result['title'] = schema['title'];
  return result as Record<string, unknown> & { readonly '$id': string };
}

// ---------------------------------------------------------------------------
// ProjectionSchema — lenient relax transform for ABox projection
// ---------------------------------------------------------------------------

/**
 * Keys stripped unconditionally at every nesting level during the relax transform.
 *
 * These are validation constraints that cause real-world records to be rejected
 * by json-tology's ABox path. Stripping them makes projection permissive while
 * preserving all structural markers json-tology needs to walk the schema tree.
 *
 * @internal
 */
const RELAX_STRIP_KEYS = new Set([
  'required',
  'enum',
  'const',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
]);

/**
 * Recursively relaxes a schema node for ABox projection.
 *
 * Rules applied at each node:
 * - Strip all keys in {@link RELAX_STRIP_KEYS}.
 * - For leaf nodes (no `properties`, no `items`): remove the `type` key
 *   entirely so json-tology can infer from the actual value. This avoids
 *   `"null"` or over-narrow `"integer"` types failing real-world values.
 * - For structural nodes (has `properties` → object; has `items` → array):
 *   preserve `type` so json-tology knows how to traverse the tree.
 * - Recurse into `properties` values, `items`, and `allOf` entries.
 * - Preserve `$id`, `title`, and all `x-squashage-*` annotations.
 *
 * @internal
 */
function relaxSchemaNode(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const hasProperties =
    node['properties'] !== null &&
    node['properties'] !== undefined &&
    typeof node['properties'] === 'object' &&
    !Array.isArray(node['properties']);

  const hasItems =
    node['items'] !== null &&
    node['items'] !== undefined &&
    typeof node['items'] === 'object' &&
    !Array.isArray(node['items']);

  const isStructural = hasProperties || hasItems;

  for (const [key, value] of Object.entries(node)) {
    // Strip validation constraint keys.
    if (RELAX_STRIP_KEYS.has(key)) continue;

    // Strip `type` on leaf nodes — structural `type` (object/array) is preserved below.
    if (key === 'type' && !isStructural) continue;

    if (key === 'properties' && hasProperties) {
      // Recurse into each property schema.
      const props = value as Record<string, unknown>;
      const relaxedProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(props)) {
        if (propSchema !== null && typeof propSchema === 'object' && !Array.isArray(propSchema)) {
          relaxedProps[propName] = relaxSchemaNode(propSchema as Record<string, unknown>);
        } else {
          relaxedProps[propName] = propSchema;
        }
      }
      out['properties'] = relaxedProps;
      continue;
    }

    if (key === 'items' && hasItems) {
      // Recurse into items schema.
      out['items'] = relaxSchemaNode(value as Record<string, unknown>);
      continue;
    }

    if (key === 'allOf' && Array.isArray(value)) {
      // Recurse into allOf entries.
      out['allOf'] = value.map(entry => {
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          return relaxSchemaNode(entry as Record<string, unknown>);
        }
        return entry;
      });
      continue;
    }

    out[key] = value;
  }

  return out;
}

/**
 * Produces a relaxed (permissive) copy of a denormalized schema for ABox
 * projection leniency. The relaxed schema preserves all structural markers
 * json-tology needs to map JSON→RDF while stripping validation constraints
 * that would reject real-world records.
 *
 * @remarks
 * **Preserved:** `$id`, `title`, `type: "object"` / `type: "array"` structural
 * markers, `properties`, `items`, `allOf`, and all `x-squashage-*` annotations.
 *
 * **Stripped:** `required`, `enum`, `const`, numeric range keywords
 * (`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`),
 * string constraints (`minLength`, `maxLength`, `pattern`), array length
 * constraints (`minItems`, `maxItems`), and `type` on leaf scalar nodes
 * (widened to accept any value by removing the type key entirely).
 *
 * This is an internal implementation detail of the ABox denormalization path.
 * Not exported from the module.
 *
 * @internal
 */
class ProjectionSchema {
  public static relax(
    schema: Record<string, unknown> & { readonly '$id': string },
  ): Record<string, unknown> & { readonly '$id': string } {
    const relaxed = relaxSchemaNode(schema);
    // Ensure $id and title are preserved on the root — they are identity anchors.
    relaxed['$id'] = schema.$id;
    if ('title' in schema) {
      relaxed['title'] = schema['title'];
    }
    return relaxed as Record<string, unknown> & { readonly '$id': string };
  }
}

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
  /** Target's base IRI; class IRIs are derived as `${baseIRI}/${className}`. */
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
 * path-form: `<baseIRI>/<className>` (with exactly one `/` separator).
 *
 * Path-form ensures json-tology can mint property IRIs as
 * `<classIRI>#<propertyName>` (a single `#` fragment separator, RFC 3987
 * compliant). Fragment-form `<base>#<className>` would cause json-tology to
 * produce double-hash IRIs `<base>#<className>#<propertyName>` which are invalid.
 *
 * @internal
 */
function buildClassIri(baseIRI: string, className: string): string {
  // Strip any trailing '#' or '/' before appending the class name segment.
  let trimmed = baseIRI;
  while (trimmed.endsWith('#') || trimmed.endsWith('/')) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}/${className}`;
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
  // ── Standard prefix map for CURIE expansion ──────────────────────────────

  /**
   * Standard RDF/OWL/SHACL/XSD prefix map used to expand compact CURIEs that
   * json-tology occasionally emits instead of fully-resolved IRIs.
   *
   * @see {@link JsonTologyOntology.#expandQuad}
   */
  static readonly #STANDARD_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
    rdf:    'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    rdfs:   'http://www.w3.org/2000/01/rdf-schema#',
    owl:    'http://www.w3.org/2002/07/owl#',
    xsd:    'http://www.w3.org/2001/XMLSchema#',
    dct:    'http://purl.org/dc/terms/',
    skos:   'http://www.w3.org/2004/02/skos/core#',
    sh:     'http://www.w3.org/ns/shacl#',
    schema: 'https://schema.org/',
    prov:   'http://www.w3.org/ns/prov#',
  });

  /**
   * Expands a single Quad's terms in place: any NamedNode whose `.value` is a
   * compact CURIE (e.g. `rdf:type`, `xsd:string`) is replaced with its fully
   * expanded IRI. Literal datatypes are expanded by the same logic.
   *
   * Detection: a value is treated as a compact CURIE when it contains `:` but
   * NOT `://` — this correctly excludes `http://`, `https://`, and `urn:` IRIs
   * while matching `rdf:type`, `xsd:string`, etc.
   *
   * Returns the original quad reference when no terms changed (no allocation).
   *
   * @internal
   */
  static #expandQuad(quad: Quad, curie: Curie): Quad {
    const s = JsonTologyOntology.#expandNamedNode(quad.subject as NamedNode, curie);
    const p = JsonTologyOntology.#expandNamedNode(quad.predicate as NamedNode, curie);
    const o = JsonTologyOntology.#expandObject(quad.object, curie);
    const g = JsonTologyOntology.#expandNamedNode(quad.graph as NamedNode, curie);

    if (s === quad.subject && p === quad.predicate && o === quad.object && g === quad.graph) {
      return quad;
    }
    return dataFactory.quad(
      s as Quad['subject'],
      p as Quad['predicate'],
      o as Quad['object'],
      g as Quad['graph'],
    );
  }

  /**
   * Expands a NamedNode's value if it looks like a compact CURIE.
   * Non-NamedNode terms and already-expanded IRIs are returned unchanged.
   *
   * @internal
   */
  static #expandNamedNode(term: NamedNode, curie: Curie): NamedNode {
    if (term.termType !== 'NamedNode') return term;
    let v = term.value;
    // Already an absolute IRI if it contains "://"
    if (v.includes('://')) {
      const sanitized = JsonTologyOntology.#sanitizeIri(v);
      return sanitized === v ? term : dataFactory.namedNode(sanitized);
    }
    // A compact CURIE must have a colon after one or more lowercase letters
    if (!/^[a-z][a-z0-9]*:/.test(v)) return term;
    v = curie.expand(v);
    const sanitized = JsonTologyOntology.#sanitizeIri(v);
    if (sanitized === term.value) return term;
    return dataFactory.namedNode(sanitized);
  }

  /**
   * Enforce the "no spaces / no controls / no <>{}|\\^`" invariant on every
   * IRI squashage emits. Spaces are percent-encoded; other illegal chars
   * (controls, the small set RFC 3987 forbids) are also percent-encoded.
   *
   * Upstream source: json-tology mints property IRIs from JSON Schema
   * property names, which originate from source-data object keys. When those
   * keys carry spaces (e.g. `"Class DC"` in Pathfinder data), the resulting
   * IRI is malformed. Sanitization here is the canonical squashage boundary —
   * no IRI emitted by `toQuads`, `tbox`, or `shacl` ever carries an illegal
   * character.
   *
   * @internal
   */
  static #sanitizeIri(iri: string): string {
    let needsFix = false;
    for (let i = 0; i < iri.length; i++) {
      const c = iri.charCodeAt(i);
      if (JsonTologyOntology.#isIriForbidden(c)) { needsFix = true; break; }
    }
    if (!needsFix) return iri;
    let out = '';
    for (let i = 0; i < iri.length; i++) {
      const c = iri.charCodeAt(i);
      if (JsonTologyOntology.#isIriForbidden(c)) {
        out += '%' + c.toString(16).padStart(2, '0').toUpperCase();
      } else {
        out += iri[i];
      }
    }
    return out;
  }

  // RFC 3987 forbids inside an IRI: any char <= 0x20 (controls + space),
  // 0x7F (DEL), and explicit `<` `>` `"` `{` `}` `|` `\` `^` backtick.
  static #isIriForbidden(c: number): boolean {
    if (c <= 0x20) return true;
    if (c === 0x7F) return true;
    if (c === 0x3C || c === 0x3E) return true;        // < >
    if (c === 0x22) return true;                       // "
    if (c === 0x7B || c === 0x7D) return true;        // { }
    if (c === 0x7C) return true;                       // |
    if (c === 0x5C) return true;                       // backslash
    if (c === 0x5E) return true;                       // ^
    if (c === 0x60) return true;                       // backtick
    return false;
  }

  /**
   * Expands the object term: NamedNodes are expanded via `#expandNamedNode`,
   * Literal datatypes are expanded if they carry a compact CURIE datatype IRI.
   * BlankNode, DefaultGraph, Variable: pass through unchanged.
   *
   * @internal
   */
  static #expandObject(term: Quad['object'], curie: Curie): Quad['object'] {
    if (term.termType === 'NamedNode') {
      return JsonTologyOntology.#expandNamedNode(term, curie);
    }
    if (term.termType === 'Literal') {
      const lit = term as Literal;
      const expandedDt = JsonTologyOntology.#expandNamedNode(lit.datatype, curie);
      if (expandedDt === lit.datatype) return term;
      return dataFactory.literal(lit.value, expandedDt);
    }
    return term;
  }

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

      // Always register by $id so $ref resolution works for every schema.
      if (!(id in schemasById)) {
        schemasById[id] = entry.schema;
      }

      // Extracted primitive/object schemas (identified by their path containing
      // `/primitives/` or `/objects/`) are $ref targets, not OWL classes.
      // Exclude them from `classMap` and `schemasByClassName` so they don't
      // clash with same-titled core primitives (e.g. both core and AONPRD-
      // extracted schemas may carry title: "IriString").
      const isExtracted =
        entry.schemaPath.includes('/primitives/') ||
        entry.schemaPath.includes('/objects/') ||
        id.includes('/inferred/primitives/') ||
        id.includes('/inferred/objects/');

      if (isExtracted) continue;

      const className = deriveClassName(entry.schema);
      const iri = buildClassIri(options.baseIRI, className);

      if (className in classMap) {
        throw OutputConfigError.create(
          `Duplicate className "${className}" derived from schemas; titles and $id-derived names must be unique within a target's ontology block`,
          { metadata: { className, schemaPath: entry.schemaPath } },
        );
      }
      classMap[className] = iri;
      schemasByClassName[className] = entry.schema;
    }

    // ── TBox / SHACL instance (original strict-graph schemas) ─────────────
    // Cross-schema $ref works correctly for TBox + SHACL emission. Route
    // tbox() and shacl() through this instance.
    const jt = JsonTology.create({
      baseIri:           options.baseIRI,
      enableStrictGraph: false,
      schemas:           options.schemas.map(entry => entry.schema) as unknown as ReadonlyArray<{ readonly '$id': string }>,
    });

    // ── ABox instance (denormalized schemas — TRANSIENT, issue #126) ───────
    // Build a denormalized copy of every schema where cross-schema $ref
    // properties are inlined. The inlined schemas violate strict-graph by
    // definition, so this instance runs with enableStrictGraph: false.
    // Only toQuads() routes through this instance; tbox()/shacl() stay on #jt.
    const denormalizedSchemas = options.schemas.map(entry =>
      ProjectionSchema.relax(buildDenormalizedSchema(entry.schema, schemasById)),
    );
    const abox = JsonTology.create({
      baseIri:           options.baseIRI,
      enableStrictGraph: false,
      schemas:           denormalizedSchemas as unknown as ReadonlyArray<{ readonly '$id': string }>,
    });

    // Build the id→denormalized schema map for toQuads lookup.
    const denormalizedById: Record<string, Record<string, unknown> & { readonly '$id': string }> = {};
    for (const s of denormalizedSchemas) {
      denormalizedById[s.$id] = s;
    }

    logger.debug('create', 'JsonTologyOntology constructed', {
      baseIRI:    options.baseIRI,
      classCount: Object.keys(classMap).length,
    });

    return new JsonTologyOntology(
      options.baseIRI,
      classMap,
      schemasByClassName,
      schemasById,
      jt,
      abox,
      denormalizedById,
    );
  }

  // ── Instance fields ─────────────────────────────────────────────────────

  readonly #baseIRI:            string;
  readonly #classMap:           Readonly<Record<string, string>>;
  readonly #schemasByClassName: Readonly<Record<string, Record<string, unknown> & { readonly '$id': string }>>;
  readonly #schemasById:        Readonly<Record<string, Record<string, unknown> & { readonly '$id': string }>>;
  /** TBox + SHACL instance: original strict-graph schemas. */
  readonly #jt:                 ReturnType<typeof JsonTology.create>;
  /** ABox-only instance: denormalized schemas (TRANSIENT — issue #126). */
  readonly #abox:               ReturnType<typeof JsonTology.create>;
  /** Map of $id → denormalized schema used by toQuads (TRANSIENT — issue #126). */
  readonly #denormalizedById:   Readonly<Record<string, Record<string, unknown> & { readonly '$id': string }>>;
  readonly #curie:              Curie;
  #tboxCache:        ReadonlyArray<Quad> | null = null;
  #shaclCache:       ReadonlyArray<Quad> | null = null;
  #ancestorsCache:   Map<string, ReadonlyArray<string>> | null = null;

  private constructor(
    baseIRI:            string,
    classMap:           Record<string, string>,
    schemasByClassName: Record<string, Record<string, unknown> & { readonly '$id': string }>,
    schemasById:        Record<string, Record<string, unknown> & { readonly '$id': string }>,
    jt:                 ReturnType<typeof JsonTology.create>,
    abox:               ReturnType<typeof JsonTology.create>,
    denormalizedById:   Record<string, Record<string, unknown> & { readonly '$id': string }>,
  ) {
    this.#baseIRI             = baseIRI;
    this.#classMap            = Object.freeze({ ...classMap });
    this.#schemasByClassName  = Object.freeze({ ...schemasByClassName });
    this.#schemasById         = Object.freeze({ ...schemasById });
    this.#jt                  = jt;
    this.#abox                = abox;
    this.#denormalizedById    = Object.freeze({ ...denormalizedById });
    this.#curie               = new Curie(JsonTologyOntology.#STANDARD_PREFIXES);
    this.#ancestorsCache      = null;
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
   * Returns the transitive ancestor class IRIs for `className` in BFS order
   * (immediate parent first, root last).
   *
   * Walks each schema's `allOf` array — P19b emits entries of the form
   * `{ $ref: '<absolute-id>' }` for every parent class. For each `$ref`, the
   * corresponding schema is looked up in `#schemasById`; its `className` is
   * derived, and its own ancestors are collected recursively.
   *
   * A visited set prevents infinite loops when a schema accidentally references
   * itself transitively.
   *
   * Result is cached per `className` after the first traversal.
   *
   * @param className - The class name to look up (matches the `title` or last
   *                    `$id` segment of a registered schema).
   * @returns BFS-ordered ancestor class IRIs, or `[]` when the class has no
   *          ancestors or is not registered.
   */
  public ancestorIris(className: string): ReadonlyArray<string> {
    // Lazy-init the cache map on first call.
    if (this.#ancestorsCache === null) {
      this.#ancestorsCache = new Map<string, ReadonlyArray<string>>();
    }

    const cached = this.#ancestorsCache.get(className);
    if (cached !== undefined) return cached;

    const result = this.#collectAncestors(className, new Set<string>());
    this.#ancestorsCache.set(className, result);
    return result;
  }

  /**
   * Recursive BFS helper for {@link ancestorIris}.
   *
   * @internal
   */
  #collectAncestors(
    className: string,
    visited:   Set<string>,
  ): ReadonlyArray<string> {
    if (visited.has(className)) return [];
    visited.add(className);

    const schema = this.#schemasByClassName[className];
    if (schema === undefined) return [];

    const allOf = schema['allOf'];
    if (!Array.isArray(allOf) || allOf.length === 0) return [];

    const immediateParents: string[] = [];

    for (const entry of allOf) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const ref = (entry as Record<string, unknown>)['$ref'];
      if (typeof ref !== 'string' || ref.length === 0) continue;

      // Strip fragment if present and look up by absolute $id.
      const schemaId    = ref.split('#')[0] ?? ref;
      const parentSchema = this.#schemasById[schemaId];
      if (parentSchema === undefined) continue;

      const parentName = deriveClassName(parentSchema);
      const parentIri  = buildClassIri(this.#baseIRI, parentName);
      if (!visited.has(parentName)) {
        immediateParents.push(parentIri);
      }
    }

    // BFS: emit immediate parents first, then recurse for grandparents.
    const result: string[] = [...immediateParents];
    for (const parentIri of immediateParents) {
      // Derive the parentName back from the IRI so we can recurse.
      // Class IRIs use path-form (<base>/vocab/<ClassName>), so extract the
      // last path segment rather than a fragment.  Fallback: if a '#' is
      // present (legacy or external schemas), slice after it.
      const hashIdx = parentIri.lastIndexOf('#');
      const classNameFromIri = hashIdx >= 0
        ? parentIri.slice(hashIdx + 1)
        : parentIri.slice(parentIri.lastIndexOf('/') + 1);
      const grandParents = this.#collectAncestors(classNameFromIri, visited);
      for (const gp of grandParents) {
        if (!result.includes(gp)) result.push(gp);
      }
    }

    return result;
  }

  /**
   * Returns the OWL TBox quads (class declarations, property declarations,
   * domain/range, cardinality) derived from every registered schema.
   *
   * Cached on first call. Reads directly from `OntologyBuilder.quads()`
   * (json-tology 0.14.0+) — no JSON-LD serialization round-trip.
   */
  public async tbox(): Promise<ReadonlyArray<Quad>> {
    if (this.#tboxCache !== null) return this.#tboxCache;
    const raw = this.#jt.toTbox().quads();
    this.#tboxCache = raw.map(q => JsonTologyOntology.#expandQuad(q, this.#curie));
    return this.#tboxCache;
  }

  /**
   * Returns the SHACL shape quads (NodeShape + property shape constraints)
   * derived from every registered schema.
   *
   * Cached on first call. Reads directly from `OntologyBuilder.shaclQuads()`
   * (json-tology 0.14.0+) — no JSON-LD serialization round-trip.
   */
  public async shacl(): Promise<ReadonlyArray<Quad>> {
    if (this.#shaclCache !== null) return this.#shaclCache;
    const raw = this.#jt.toShacl().shaclQuads();
    this.#shaclCache = raw.map(q => JsonTologyOntology.#expandQuad(q, this.#curie));
    return this.#shaclCache;
  }

  /**
   * Projects a single instance to ABox quads for the given schema.
   *
   * @remarks
   * Routes through the denormalized ABox instance (`#abox`) to work around
   * json-tology issue #126 — cross-schema `$ref` properties were silently
   * dropped during ABox projection in 0.14.0. The denormalized schema has
   * all `$ref` properties inlined so json-tology can walk them directly.
   *
   * TBox (`tbox()`) and SHACL (`shacl()`) continue to route through `#jt`
   * which holds the original strict-graph schemas.
   *
   * REMOVE the `#abox` routing when json-tology #126 is fixed; then route
   * through `this.#jt.toQuads(schema, instance)` directly.
   *
   * @param schemaId - The `$id` of a schema registered at construction time.
   * @param instance - Instance data conforming to the schema.
   * @returns The projected quads as `@rdfjs/types` Quads.
   * @throws {OutputConfigError} When `schemaId` is not registered.
   */
  public async toQuads(schemaId: string, instance: unknown): Promise<ReadonlyArray<Quad>> {
    // Guard on original registry — authoritative source of registered schemas.
    const schema = this.#schemasById[schemaId];
    if (schema === undefined) {
      throw OutputConfigError.create(
        `JsonTologyOntology.toQuads: no schema registered with $id "${schemaId}"`,
        { metadata: { schemaId, registered: Object.keys(this.#schemasById) } },
      );
    }

    // Route through the ABox instance which holds denormalized (inlined) schemas.
    // TRANSIENT: remove when json-tology #126 is resolved.
    const denormalized = this.#denormalizedById[schemaId] ?? schema;
    const raw = this.#abox.toQuads(denormalized, instance);
    return raw.map(q => JsonTologyOntology.#expandQuad(q, this.#curie));
  }

  /**
   * Validates `instance` against the strict schema registered under `schemaId`.
   *
   * @remarks
   * Validation is advisory — it uses the original strict `#jt` schemas so
   * callers can surface constraint violations as warnings without preventing
   * projection. The relaxed ABox schemas (used by `toQuads`) never participate
   * in validation; validation is a separate best-effort signal.
   *
   * Delegates to `JsonTology.validate` (static), which does not require the
   * registry instance.
   *
   * @param schemaId - The `$id` of a schema registered at construction time.
   * @param instance - The value to validate.
   * @returns A {@link ValidationErrors} instance. `result.ok === true` when
   *   valid; `result.items` carries the individual constraint violations.
   * @throws {OutputConfigError} When `schemaId` is not registered.
   */
  public validate(schemaId: string, instance: unknown): ValidationErrors {
    const schema = this.#schemasById[schemaId];
    if (schema === undefined) {
      throw OutputConfigError.create(
        `JsonTologyOntology.validate: no schema registered with $id "${schemaId}"`,
        { metadata: { schemaId, registered: Object.keys(this.#schemasById) } },
      );
    }
    return JsonTology.validate(schema, instance);
  }
}
