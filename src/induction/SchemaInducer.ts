/**
 * SchemaInducer — materializes JSON Schema 2020-12 fragments from accumulated
 * `ShapeObservation` data.
 *
 * Clean-room implementation. Inspired by the genson-js per-property accumulator
 * pattern but with squashage-specific heuristics for discriminator / enum / IRI
 * / literal classification.
 *
 * Determinism contract:
 *   - JSON object keys are sorted before every `return` in the public surface.
 *   - `enum` values are sorted lexicographically.
 *   - `typeHistogram` is iterated in sorted type order.
 *   - `properties` map is iterated by sorted key order.
 *   - No `Date.now()`, no `Math.random()`.
 *
 * Same observation set → byte-identical output on every invocation.
 *
 * Extraction contract (strict-graph compatibility):
 *   - Constrained primitives (enum, minimum/maximum, x-squashage-iri-promotion)
 *     are extracted to named sibling schemas under primitives/.
 *   - Inline nested objects (with properties) are extracted to named sibling
 *     schemas under objects/.
 *   - Deduplication: structurally identical shapes share one named schema.
 *   - Collision: distinct shapes with the same semantic name get _2, _3 suffixes.
 */

import { Logger } from '../modules/logger/logger.js';
import type { JsonScalarType, PropertyObservation, ShapeObservation } from './ShapeObservation.js';

const logger = Logger.forComponent('SchemaInducer');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Max distinct values before we suppress `enum` on a string property. */
const CLOSED_ENUM_MAX = 16;

/** Fraction of records where a string value matches URL pattern for IRI promotion. */
const IRI_PROMOTION_FRACTION = 0.9;

/**
 * Fixed iteration order for the type histogram — alphabetical, matching the
 * JSON Schema `type` keyword convention.
 */
const TYPE_SORT_ORDER: readonly JsonScalarType[] = [
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
];

// ─── Output interfaces ────────────────────────────────────────────────────────

/**
 * A single induced schema document with its identifying metadata.
 */
export interface InducedSchemaInterface {
  /** The classification class name or extracted shape name. */
  readonly className: string;
  /** The JSON Schema `$id` value minted for this draft. */
  readonly schemaId: string;
  /** Schema kind: class, extracted primitive, or extracted object. */
  readonly kind: 'class' | 'primitive' | 'object';
  /** The key-sorted JSON Schema 2020-12 document. */
  readonly schema: Record<string, unknown>;
}

/**
 * The full set of induced schemas from one `materialize()` call.
 *
 * `classes` contains the top-level class schemas (one per entry in shapeCache).
 * `primitives` contains extracted constrained-primitive schemas.
 * `objects` contains extracted nested-object schemas.
 */
export interface InducedSchemaSetInterface {
  readonly classes:    ReadonlyArray<InducedSchemaInterface>;
  readonly primitives: ReadonlyArray<InducedSchemaInterface>;
  readonly objects:    ReadonlyArray<InducedSchemaInterface>;
}

// ─── Materialize options ──────────────────────────────────────────────────────

/** Options for the `materialize` call. */
export interface MaterializeOptionsInterface {
  /**
   * Base IRI prepended to every schema `$id` and `x-squashage-class`.
   * Must not end with `#` — a trailing `/` is normalised if absent.
   *
   * Class IRIs use path-form: `<base><ClassName>` (base with trailing `/`).
   * This ensures json-tology mints property IRIs as `<base><ClassName>#<prop>`
   * (exactly one `#` fragment separator per IRI — RFC 3987 compliant).
   *
   * Example: `'https://example.org/vocab/'` → class IRI `https://example.org/vocab/Feat`
   */
  readonly baseIri: string;
}

// ─── Key sort helper ──────────────────────────────────────────────────────────

/**
 * Produce a new plain object with keys sorted alphabetically.
 *
 * Recurses into nested plain-object values so the full schema tree is sorted.
 * Arrays are left in place (array element order is meaningful).
 */
function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      sorted[key] = sortKeys(val as Record<string, unknown>);
    } else if (Array.isArray(val)) {
      sorted[key] = val.map((item) =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? sortKeys(item as Record<string, unknown>)
          : item,
      );
    } else {
      sorted[key] = val;
    }
  }
  return sorted;
}

// ─── Heuristic helpers ────────────────────────────────────────────────────────

/**
 * Return the sorted list of non-null types present in the histogram.
 * Order matches `TYPE_SORT_ORDER` to keep output deterministic.
 */
function sortedNonNullTypes(histogram: Map<JsonScalarType, number>): JsonScalarType[] {
  return TYPE_SORT_ORDER.filter((t) => t !== 'null' && histogram.has(t));
}

/**
 * Return true when a schema body's `type` field indicates an object type,
 * including nullable variants like `["object", "null"]`.
 */
function typeIncludesObject(body: Record<string, unknown>): boolean {
  const t = body['type'];
  if (t === 'object') return true;
  if (Array.isArray(t)) return (t as string[]).includes('object');
  return false;
}

/**
 * Return true when a schema body's `type` field indicates an array type,
 * including nullable variants like `["array", "null"]`.
 */
function typeIncludesArray(body: Record<string, unknown>): boolean {
  const t = body['type'];
  if (t === 'array') return true;
  if (Array.isArray(t)) return (t as string[]).includes('array');
  return false;
}

/**
 * Build the `type` fragment for a property schema.
 *
 * Rules:
 * - If histogram contains only null → `"type": "null"`.
 * - If histogram has one non-null type and no null → `"type": "<type>"`.
 * - If histogram has one non-null type and null → `"type": ["<type>", "null"]`.
 * - If histogram has multiple non-null types → `"oneOf"` array.
 *   - Each member has a `"type"` key; null is appended last in the oneOf list
 *     if also observed.
 */
function buildTypeFragment(
  histogram: Map<JsonScalarType, number>,
): Record<string, unknown> {
  const nonNull = sortedNonNullTypes(histogram);
  const hasNull  = histogram.has('null');

  if (nonNull.length === 0) {
    // Only null observed.
    return { type: 'null' };
  }

  if (nonNull.length === 1) {
    const t = nonNull[0] as JsonScalarType;
    if (hasNull) {
      return { type: [t, 'null'] };
    }
    return { type: t };
  }

  // Multiple non-null types → oneOf
  const oneOf: Record<string, unknown>[] = nonNull.map((t) => ({ type: t }));
  if (hasNull) {
    oneOf.push({ type: 'null' });
  }
  return { oneOf };
}

// ─── Naming helpers ──────────────────────────────────────────────────────────

/**
 * Convert a property name to PascalCase for use as an extracted schema name.
 *
 * Examples:
 *   rarity         → Rarity
 *   action_cost    → ActionCost
 *   _type          → Type
 *   raw_fields     → RawFields
 */
function toPascalCase(name: string): string {
  // Strip leading underscores, split on underscores and spaces, capitalise each word.
  return name
    .replace(/^_+/, '')
    .split(/[_\s]+/)
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

/**
 * Derive a semantic name for an extracted primitive.
 *
 * - IRI-promoted properties → `IriString` (single shared primitive).
 * - Closed-enum strings → `PascalCase(className) + PascalCase(propertyName)` when
 *   className is non-empty (ensures parent context is preserved for nested enums).
 *   When className is empty, falls back to `PascalCase(propertyName)` alone.
 * - Bounded integer/number → `PascalCase(className) + PascalCase(propertyName)`.
 * - Other constrained → `PascalCase(className) + PascalCase(propertyName)`.
 */
function primitiveName(
  propertyName: string,
  className:    string,
  schema:       Record<string, unknown>,
): string {
  if (schema['x-squashage-iri-promotion'] === true) {
    return 'IriString';
  }
  // Always scope to className to prevent bare numeric/short names from escaping.
  // toPascalCase('') produces '' so the fallback still works when className is absent.
  return `${toPascalCase(className)}${toPascalCase(propertyName)}`;
}

/**
 * Derive a semantic name for an extracted object.
 *
 * - Direct object property of a class → `PascalCase(className) + PascalCase(propertyName)`.
 * - Items of an array → singular form (strip trailing `s`; fallback append `Item`).
 */
function objectName(
  propertyName: string,
  className:    string,
): string {
  const rawProp = toPascalCase(propertyName);
  const rawClass = toPascalCase(className);
  // Strip trailing `s` for array-item names, but only when propertyName clearly
  // ends with `s` and the singular form isn't degenerate.
  if (propertyName.endsWith('s') && propertyName.length > 2) {
    const singular = rawProp.slice(0, -1);
    if (singular.length >= 2) {
      return `${rawClass}${singular}`;
    }
  }
  return `${rawClass}${rawProp}`;
}

/**
 * Convert an array-item path token to the item's semantic name.
 *
 * The inducer recursively walks `obs.arrayItem` by passing `${propName}[]` to
 * `buildPropertySchema`. `[]` is a path marker, not a filename component — the
 * extractor's name-generation must replace it before producing a schema name.
 *
 * Strips trailing `s` (matching the singularization in `objectName`) so an
 * extracted item primitive in a `traits` array becomes `<Class>Trait` rather
 * than `<Class>TraitsItem`. Falls back to appending `Item` when the singular
 * form is degenerate (under 2 chars).
 */
function arrayItemName(propName: string): string {
  // Strip the trailing `[]` marker if present (it survives the recursive path).
  const stripped = propName.endsWith('[]') ? propName.slice(0, -2) : propName;
  if (stripped.endsWith('s') && stripped.length > 2) {
    const singular = stripped.slice(0, -1);
    if (singular.length >= 2) {
      return singular;
    }
  }
  return `${stripped}_item`;
}

// ─── Dictionary detection ─────────────────────────────────────────────────────

/**
 * Minimum number of keys in a nested object's properties map before the large-
 * cardinality dictionary heuristic applies.
 */
const DICT_LARGE_KEY_COUNT = 32;

/** Regex for pure numeric strings (integer keys like "1", "-1", "10"). */
const PURE_NUMERIC_RE = /^-?\d+$/;

/**
 * Return true when a set of property keys looks like data keys rather than
 * structural field names (i.e., the object is a dictionary/map, not a struct).
 *
 * Two heuristics:
 *   1. ALL keys are pure numeric strings → always dictionary-style.
 *   2. More than DICT_LARGE_KEY_COUNT keys AND the majority are short
 *      alphanumeric without underscores or camelCase separators → dictionary.
 *
 * This prevents per-key primitive extraction for objects like:
 *   `Spell.levels: { "1": [...], "2": [...], ..., "10": [...] }`
 */
function isDictionaryStyle(keys: readonly string[]): boolean {
  if (keys.length === 0) return false;
  // Heuristic 1: all keys are pure numeric strings.
  if (keys.every((k) => PURE_NUMERIC_RE.test(k))) return true;
  // Heuristic 2: large key count and majority short alphanumeric (no _ or camelCase).
  if (keys.length > DICT_LARGE_KEY_COUNT) {
    const shortAlpha = keys.filter((k) => /^[a-z0-9]{1,12}$/i.test(k) && !k.includes('_'));
    return shortAlpha.length > keys.length * 0.6;
  }
  return false;
}

// ─── Structural hash ──────────────────────────────────────────────────────────

/**
 * Compute a structural hash for a schema fragment.
 *
 * `sortKeys` already produces a deterministic key order; `JSON.stringify` over
 * that is a stable content fingerprint.
 */
function structuralHash(schema: Record<string, unknown>): string {
  return JSON.stringify(sortKeys(schema));
}

// ─── Extractor ────────────────────────────────────────────────────────────────

interface ExtractedEntry {
  readonly id:     string;
  readonly name:   string;
  readonly kind:   'primitive' | 'object';
  readonly schema: Record<string, unknown>;
}

/**
 * Maintains the extraction registry for one `materialize()` call.
 *
 * Not exported — constructed once per `SchemaInducer.materialize` invocation.
 */
class Extractor {
  readonly #base:         string;
  readonly #byHash:       Map<string, ExtractedEntry> = new Map();
  readonly #byName:       Map<string, ExtractedEntry> = new Map();
  readonly #nameCounters: Map<string, number>         = new Map();

  constructor(base: string) {
    this.#base = base;
  }

  /**
   * Register or look up an extracted primitive schema.
   * Returns the `$ref` string to inline in the parent schema.
   */
  extractPrimitive(
    propertyName: string,
    className:    string,
    inlineSchema: Record<string, unknown>,
  ): string {
    const normalised = sortKeys(inlineSchema);
    const hash       = structuralHash(normalised);

    const existing = this.#byHash.get(hash);
    if (existing !== undefined) {
      return existing.id;
    }

    const baseName = primitiveName(propertyName, className, normalised);
    this.#allocateName(baseName, hash, 'primitive', normalised);
    // After allocateName, the entry is in #byHash — return its canonical id.
    return (this.#byHash.get(hash) as ExtractedEntry).id;
  }

  /**
   * Register or look up an extracted object schema.
   * Recursively extracts constrained primitives and nested objects within the
   * object's own properties before computing its structural hash.
   * Returns the `$ref` string to inline in the parent schema.
   *
   * The child object's semantic name is computed BEFORE recursion so that all
   * properties nested inside it carry the child name as their className.
   * For example:
   *   extractObject('levels', 'Spell', ...) → childName = 'SpellLevels'
   *   → processObjectSchema(..., 'SpellLevels')
   *   → nested key '1' → extractPrimitive('1', 'SpellLevels', ...) → 'SpellLevels1'
   */
  extractObject(
    propertyName: string,
    className:    string,
    inlineSchema: Record<string, unknown>,
  ): string {
    // Compute the child name first so recursive processing uses it as context.
    const baseName = objectName(propertyName, className);

    // Walk the inline schema's properties, extracting recursively with the
    // child's own name as the className — THEN hash the resulting schema.
    const processed = this.#processObjectSchema(inlineSchema, baseName);
    const hash      = structuralHash(processed);

    const existing = this.#byHash.get(hash);
    if (existing !== undefined) {
      return existing.id;
    }

    this.#allocateName(baseName, hash, 'object', processed);
    // After allocateName, the entry is in #byHash — return its canonical id.
    return (this.#byHash.get(hash) as ExtractedEntry).id;
  }

  /**
   * Return all extracted entries sorted by name for determinism.
   * The schemas stored in entries are already wrapped with $schema/$id/title.
   */
  materialize(): { primitives: InducedSchemaInterface[]; objects: InducedSchemaInterface[] } {
    const primitives: InducedSchemaInterface[] = [];
    const objects:    InducedSchemaInterface[] = [];

    // Deduplicate: #byHash may have multiple entries pointing to the same
    // ExtractedEntry object when a hash collides. Use a Set of ids to avoid
    // emitting the same schema twice.
    const seen = new Set<string>();

    for (const entry of [...this.#byHash.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);

      const induced: InducedSchemaInterface = {
        className: entry.name,
        schemaId:  entry.id,
        kind:      entry.kind,
        schema:    sortKeys(entry.schema),
      };
      if (entry.kind === 'primitive') {
        primitives.push(induced);
      } else {
        objects.push(induced);
      }
    }

    return { primitives, objects };
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Allocate a unique name for a newly-encountered schema, wrap it with
   * `$schema`, `$id`, and `title` fields, register in both maps, and return
   * the allocated name.
   *
   * If `baseName` is already used for a structurally different schema, appends
   * `_2`, `_3`, etc. and emits a `logger.warn`.
   */
  #allocateName(
    baseName:    string,
    hash:        string,
    kind:        'primitive' | 'object',
    innerSchema: Record<string, unknown>,
  ): string {
    // First check: is the baseName already taken by a different hash?
    if (!this.#byName.has(baseName)) {
      const subDir  = kind === 'primitive' ? 'primitives' : 'objects';
      const id      = `${this.#base}schemas/inferred/${subDir}/${baseName}.draft.json`;
      const wrapped = this.#wrapSchema(id, baseName, innerSchema);
      const entry: ExtractedEntry = { id, name: baseName, kind, schema: wrapped };
      this.#byHash.set(hash, entry);
      this.#byName.set(baseName, entry);
      this.#nameCounters.set(baseName, 1);
      return baseName;
    }

    // Name is taken by a different schema — find the next available suffix.
    const counter = (this.#nameCounters.get(baseName) ?? 1) + 1;
    const suffixed = `${baseName}_${counter}`;
    this.#nameCounters.set(baseName, counter);

    logger.warn('extractPrimitive', 'naming collision — suffixed extracted schema', {
      baseName,
      suffix: `_${counter}`,
      name:   suffixed,
      kind,
    });

    const subDir  = kind === 'primitive' ? 'primitives' : 'objects';
    const id      = `${this.#base}schemas/inferred/${subDir}/${suffixed}.draft.json`;
    const wrapped = this.#wrapSchema(id, suffixed, innerSchema);
    const entry: ExtractedEntry = { id, name: suffixed, kind, schema: wrapped };
    this.#byHash.set(hash, entry);
    this.#byName.set(suffixed, entry);
    return suffixed;
  }

  /**
   * Wrap an extracted inner schema with the standard JSON Schema envelope
   * (`$schema`, `$id`, `title`). The inner schema's own properties are spread
   * in, so type/enum/minimum/properties etc. are preserved at the top level.
   */
  #wrapSchema(
    id:          string,
    title:       string,
    innerSchema: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      '$schema': 'https://json-schema.org/draft/2020-12/schema',
      '$id':     id,
      title,
      ...innerSchema,
    };
  }

  /**
   * Walk an inline object schema's `properties` recursively, returning a new
   * schema object where constrained primitives and nested objects are replaced
   * by `$ref`. Used before hashing the object schema itself.
   *
   * When the properties map looks like a dictionary (all-numeric keys or large
   * cardinality with short alphanumeric keys), the method emits
   * `additionalProperties: { $ref: ... }` pointing to a single merged value
   * schema and drops the per-key `properties` map entirely. This avoids
   * extracting one named primitive per data key (e.g. "1", "2", … "10").
   */
  #processObjectSchema(
    inlineSchema: Record<string, unknown>,
    className:    string,
  ): Record<string, unknown> {
    const rawProps = inlineSchema['properties'];
    if (rawProps === undefined || typeof rawProps !== 'object' || Array.isArray(rawProps)) {
      return inlineSchema;
    }
    const propsMap = rawProps as Record<string, unknown>;
    const propKeys = Object.keys(propsMap).sort();

    // ── dictionary-style detection ────────────────────────────────────────────
    if (isDictionaryStyle(propKeys)) {
      // Collect all value bodies so we can build a representative merged body.
      // We pick the first non-null body as the representative; if it is already
      // a constrained type, extract it as a single value schema.
      const bodies = propKeys
        .map((k) => propsMap[k])
        .filter((b): b is Record<string, unknown> =>
          b !== null && typeof b === 'object' && !Array.isArray(b),
        );

      const representativeBody = bodies[0];
      if (representativeBody !== undefined) {
        const processedBody = this.#processPropertyBody(
          // Use the className itself as a stable synthetic property name so the
          // extracted value schema is named after the dict-owner (e.g. "SpellLevelEntry").
          'Entry',
          className,
          representativeBody,
        );
        // Rebuild schema without per-key properties; use additionalProperties instead.
        const { properties: _omitted, ...rest } = inlineSchema;
        return { ...rest, additionalProperties: processedBody };
      }
      // No processable bodies — keep schema as-is (no extraction).
      return inlineSchema;
    }

    // ── normal struct: extract per-property ──────────────────────────────────
    const newProps: Record<string, unknown> = {};

    for (const propName of propKeys) {
      const body = propsMap[propName];
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        newProps[propName] = body;
        continue;
      }
      const bodyObj = body as Record<string, unknown>;
      newProps[propName] = this.#processPropertyBody(propName, className, bodyObj);
    }

    return { ...inlineSchema, properties: newProps };
  }

  /**
   * Process a single property body: extract if constrained, recurse into
   * items/nested objects, or leave bare.
   */
  #processPropertyBody(
    propName:  string,
    className: string,
    body:      Record<string, unknown>,
  ): Record<string, unknown> {
    // Already a ref — skip.
    if ('$ref' in body) {
      return body;
    }

    // Nested object with properties → extract object (including nullable objects).
    if (typeIncludesObject(body) && 'properties' in body) {
      const ref = this.extractObject(propName, className, body);
      return { $ref: ref };
    }

    // Array (including nullable arrays): recurse into items.
    if (typeIncludesArray(body) && body['items'] !== undefined) {
      const items = body['items'];
      if (items !== null && typeof items === 'object' && !Array.isArray(items)) {
        const itemsObj = items as Record<string, unknown>;
        // Array items that are an object → extract object.
        if (typeIncludesObject(itemsObj) && 'properties' in itemsObj) {
          const ref = this.extractObject(propName, className, itemsObj);
          return { ...body, items: { $ref: ref } };
        }
        // Array items that are a constrained primitive → extract primitive.
        if (this.#isConstrainedPrimitive(itemsObj)) {
          const ref = this.extractPrimitive(arrayItemName(propName), className, itemsObj);
          return { ...body, items: { $ref: ref } };
        }
      }
      return body;
    }

    // Constrained primitive → extract.
    if (this.#isConstrainedPrimitive(body)) {
      const ref = this.extractPrimitive(propName, className, body);
      return { $ref: ref };
    }

    return body;
  }

  /**
   * Return true when a schema body carries at least one constraint that
   * json-tology strict-graph mode rejects as inline.
   *
   * `oneOf` schemas are multi-type unions; mixed-type properties are left
   * inline because the numeric constraints belong to one branch of the union,
   * not the property as a whole.
   */
  #isConstrainedPrimitive(body: Record<string, unknown>): boolean {
    if ('oneOf' in body) return false;
    return (
      'enum'                      in body ||
      'minimum'                   in body ||
      'maximum'                   in body ||
      'format'                    in body ||
      body['x-squashage-iri-promotion'] === true
    );
  }
}

// ─── Property schema builder ──────────────────────────────────────────────────

/**
 * Build the JSON Schema fragment for a single `PropertyObservation`.
 *
 * @param propName  - Property name (needed for discriminator heuristic).
 * @param obs       - The accumulated observation.
 * @param className - Parent class name (needed for discriminator heuristic).
 * @param recordCount - Total record count for the parent class.
 */
function buildPropertySchema(
  propName:    string,
  obs:         PropertyObservation,
  className:   string,
  recordCount: number,
): Record<string, unknown> {
  const schema: Record<string, unknown> = {};

  // ── type fragment ──────────────────────────────────────────────────────────
  Object.assign(schema, buildTypeFragment(obs.typeHistogram));

  // ── numeric range ──────────────────────────────────────────────────────────
  if (obs.numericRange !== undefined) {
    schema['minimum'] = obs.numericRange.min;
    schema['maximum'] = obs.numericRange.max;
  }

  // ── string-specific heuristics ────────────────────────────────────────────
  const isStringTyped = obs.typeHistogram.has('string');
  // Closed-enum emission is only valid when string is the sole non-null type.
  // Mixed-type properties (e.g. string | integer) cannot have a meaningful
  // string-only enum because non-string values would always fail validation.
  const isStringOnlyNonNull = isStringTyped && sortedNonNullTypes(obs.typeHistogram).length === 1;
  if (isStringTyped) {
    const bounded   = isStringOnlyNonNull && !obs.distinctOverflow && obs.distinctValues.size <= CLOSED_ENUM_MAX;
    const iriHeavy  = obs.urlPatternCount > recordCount * IRI_PROMOTION_FRACTION;
    const singleton = obs.distinctValues.size === 1;
    const onlyValue = singleton ? [...obs.distinctValues][0] : undefined;

    if (bounded) {
      // Closed-enum candidate — sort values for determinism.
      const enumValues: unknown[] = [...obs.distinctValues].sort();
      if (obs.typeHistogram.has('null')) {
        enumValues.push(null);
      }
      schema['enum'] = enumValues;
      schema['x-squashage-closed-enum'] = true;

      // Discriminator hint: singleton whose value equals the class name.
      if (singleton && onlyValue === className) {
        schema['x-squashage-discriminator'] = true;
      }
    }

    if (iriHeavy) {
      schema['x-squashage-iri-promotion'] = true;
    }

    if (obs.distinctOverflow) {
      schema['x-squashage-open-vocab'] = true;
    }
  }

  // ── array items ───────────────────────────────────────────────────────────
  if (obs.arrayItem !== undefined) {
    schema['items'] = buildPropertySchema(
      arrayItemName(propName),
      obs.arrayItem,
      className,
      recordCount,
    );
  }

  // ── nested object properties ──────────────────────────────────────────────
  if (obs.nested !== undefined && obs.nested.size > 0) {
    const nestedProps: Record<string, unknown> = {};
    for (const nestedKey of [...obs.nested.keys()].sort()) {
      const nestedObs = obs.nested.get(nestedKey) as PropertyObservation;
      nestedProps[nestedKey] = buildPropertySchema(
        `${propName}.${nestedKey}`,
        nestedObs,
        className,
        recordCount,
      );
    }
    schema['properties'] = nestedProps;
  }

  return schema;
}

// ─── SchemaInducer ────────────────────────────────────────────────────────────

/**
 * Materializes JSON Schema 2020-12 drafts from a filled `shapeCache`.
 *
 * All static methods. No constructor — this is a pure-function utility class.
 */
export class SchemaInducer {
  private constructor() { /* static-only class */ }

  /**
   * Convert every entry in `shapeCache` into a JSON Schema 2020-12 draft.
   *
   * The output set has three arrays:
   * - `classes`:    one schema per entry in shapeCache, sorted by className.
   * - `primitives`: extracted constrained-primitive schemas, sorted by name.
   * - `objects`:    extracted nested-object schemas, sorted by name.
   *
   * @param shapeCache - The filled shape cache (`services.shapeCache`).
   * @param options    - `baseIri` for `$id` and `x-squashage-class` minting.
   */
  static materialize(
    shapeCache: ReadonlyMap<string, ShapeObservation>,
    options:    MaterializeOptionsInterface,
  ): InducedSchemaSetInterface {
    // Normalise the base IRI: must end with exactly one '/' and must NOT end
    // with '#'.  This is required so class IRIs take the path-form convention
    // `<base>vocab/<ClassName>` — json-tology then mints property IRIs as
    // `<base>vocab/<ClassName>#<propertyName>` (single fragment separator).
    const base = options.baseIri.endsWith('/')
      ? options.baseIri
      : `${options.baseIri}/`;

    const extractor = new Extractor(base);
    const classes: InducedSchemaInterface[] = [];

    // Iterate in sorted key order for determinism.
    for (const className of [...shapeCache.keys()].sort()) {
      const observation = shapeCache.get(className) as ShapeObservation;
      const induced     = SchemaInducer.#induceOne(observation, base, extractor);
      classes.push(induced);
    }

    const { primitives, objects } = extractor.materialize();

    return { classes, primitives, objects };
  }

  // ─── private ────────────────────────────────────────────────────────────────

  static #induceOne(
    observation: ShapeObservation,
    base:        string,
    extractor:   Extractor,
  ): InducedSchemaInterface {
    const { className, recordCount, properties } = observation;

    const schemaId = `${base}schemas/inferred/${className}.draft.json`;

    const propertiesFragment: Record<string, unknown> = {};
    const required: string[] = [];

    // Iterate properties in sorted key order.
    for (const propName of [...properties.keys()].sort()) {
      const obs = properties.get(propName) as PropertyObservation;

      // Build the raw property schema (inline).
      const rawBody = buildPropertySchema(propName, obs, className, recordCount);

      // Then run it through the extractor to replace constrained shapes with $refs.
      propertiesFragment[propName] = SchemaInducer.#extractBody(
        propName, className, rawBody, extractor,
      );

      if (obs.presenceCount === recordCount) {
        required.push(propName);
      }
    }

    // Class IRI uses path-form: <base><className> (base always has trailing '/').
    // json-tology (SchemaIri.propertyIri) appends #<propertyName> to the $id,
    // so the final property IRI is <base><className>#<propertyName> —
    // exactly one '#' fragment separator, RFC 3987 compliant.
    const classIri = `${base}${className}`;

    const schema: Record<string, unknown> = {
      '$schema': 'https://json-schema.org/draft/2020-12/schema',
      '$id':     schemaId,
      title:     className,
      'x-squashage-class': classIri,
      type:      'object',
      properties: propertiesFragment,
      additionalProperties: true,
    };

    // Only emit `required` when at least one property qualifies.
    if (required.length > 0) {
      schema['required'] = required.sort();
    }

    return {
      className,
      schemaId,
      kind: 'class',
      schema: sortKeys(schema),
    };
  }

  /**
   * Walk a property body and replace constrained primitives with `$ref`
   * pointers, delegating to the shared `Extractor`.
   *
   * Nested objects are left INLINE (not extracted to a separate schema file).
   * json-tology's ABox projector (Projection.abox) uses the single root-schema
   * graph and cannot follow external cross-schema `$ref` targets; if objects
   * are extracted the projector silently drops all nested-object properties.
   * Keeping objects inline ensures complete ABox projection.
   *
   * Constrained primitives (enum, min/max, format, IRI-promotion) ARE still
   * extracted to separate schemas for clean TBox/SHACL typing.
   */
  static #extractBody(
    propName:  string,
    className: string,
    body:      Record<string, unknown>,
    extractor: Extractor,
  ): Record<string, unknown> {
    // Already a ref — skip.
    if ('$ref' in body) {
      return body;
    }

    // Nested object with properties — keep INLINE for ABox projection.
    // (Do NOT call extractor.extractObject here.)
    if (typeIncludesObject(body) && 'properties' in body) {
      return body;
    }

    // Array (including nullable arrays): recurse into items.
    if (typeIncludesArray(body) && body['items'] !== undefined) {
      const items = body['items'];
      if (items !== null && typeof items === 'object' && !Array.isArray(items)) {
        const itemsObj = items as Record<string, unknown>;
        // Array items that are objects are STILL extracted to $ref.
        // Inline projection of arrays-of-objects can produce enormous output
        // (e.g. Rule.sections with 100+ entries each having large body_text),
        // causing V8 "Invalid string length" during N-Quads serialization.
        // The ABox projector handles scalar array items (strings, numbers) fine;
        // only nested objects in arrays are skipped when extracted.
        if (typeIncludesObject(itemsObj) && 'properties' in itemsObj) {
          const ref = extractor.extractObject(propName, className, itemsObj);
          return { ...body, items: { $ref: ref } };
        }
        if (SchemaInducer.#isConstrainedPrimitive(itemsObj)) {
          const ref = extractor.extractPrimitive(arrayItemName(propName), className, itemsObj);
          return { ...body, items: { $ref: ref } };
        }
      }
      return body;
    }

    // Constrained primitive → extract.
    if (SchemaInducer.#isConstrainedPrimitive(body)) {
      const ref = extractor.extractPrimitive(propName, className, body);
      return { $ref: ref };
    }

    return body;
  }

  static #isConstrainedPrimitive(body: Record<string, unknown>): boolean {
    // `oneOf` schemas are multi-type unions; constraints inside oneOf members are
    // not top-level constraints on the property itself — don't extract them.
    if ('oneOf' in body) return false;
    return (
      'enum'                           in body ||
      'minimum'                        in body ||
      'maximum'                        in body ||
      'format'                         in body ||
      body['x-squashage-iri-promotion'] === true
    );
  }
}
