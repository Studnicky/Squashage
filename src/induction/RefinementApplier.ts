/**
 * RefinementApplier — pure function that applies a `.refine.json` DSL document
 * to a draft schema, producing a final schema suitable for use in Phase 2.
 *
 * All operations are applied in a fixed, deterministic order:
 *   1. drop
 *   2. rename
 *   3. closedEnum
 *   4. openVocabulary
 *   5. promoteIri
 *   6. range
 *   7. rdfsLabel
 *   8. rdfsComment
 *   9. subjectIriPolicy
 *  10. arrayEnumIri
 *  11. skolemSubject
 *  12. provenanceIri
 *  13. predicateOverride
 *  14. inverseOf
 *  15. parents
 *
 * No I/O. No Date.now(). Warn-loud, write-anyway semantics: when a rule
 * references a property not found in the draft, a `RefineWarning` is appended
 * and the rest of the rules continue. The caller decides the exit code.
 */

import type { SubjectIriSanitize } from './SubjectIriPolicy.js';

// ─── Public interfaces ────────────────────────────────────────────────────────

/** A single refinement rule that references a property not present in the draft. */
export interface RefineWarning {
  readonly code:    string;
  readonly pointer: string;
  readonly message: string;
}

/** Shape of the `subjectIriPolicy` block in a refinement file. */
export interface RefineSubjectIriPolicy {
  readonly from:      string;
  readonly sanitize:  SubjectIriSanitize;
  readonly fallback?: string | undefined;
}

/** Shape of a single entry in `skolemSubject`. */
export interface RefineSkolemEntry {
  readonly fragment:   string;
  readonly type:       string;
  readonly properties?: Readonly<Record<string, string>> | undefined;
}

/** Shape of the `provenanceIri` block in a refinement file. */
export interface RefineProvenanceIri {
  readonly predicate: string;
  readonly from:      string;
}

/** Validated shape of a `.refine.json` document. */
export interface RefineSpec {
  readonly $schema:           string;
  readonly appliesTo:         string;
  readonly rename?:           Readonly<Record<string, string>>;
  readonly promoteIri?:       readonly string[];
  readonly closedEnum?:       readonly string[];
  readonly openVocabulary?:   readonly string[];
  readonly rdfsLabel?:        string;
  readonly rdfsComment?:      string;
  readonly range?:            Readonly<Record<string, string>>;
  readonly drop?:             readonly string[];
  readonly subjectIriPolicy?: RefineSubjectIriPolicy;
  readonly arrayEnumIri?:     Readonly<Record<string, string>>;
  readonly skolemSubject?:    Readonly<Record<string, RefineSkolemEntry>>;
  readonly provenanceIri?:    RefineProvenanceIri;
  readonly predicateOverride?: Readonly<Record<string, string>>;
  readonly inverseOf?:        Readonly<Record<string, string>>;
  /** Parent class names. Each becomes an `allOf: [{ $ref }]` entry on the final schema. */
  readonly parents?:          ReadonlyArray<string>;
  /**
   * Override the base URL used to build `$ref` paths for parent classes.
   * When absent, the base is derived from the draft's `$id`:
   *   - strip the trailing `/inferred/<leaf>` segment if present, yielding the finals directory;
   *   - otherwise strip just the leaf filename.
   */
  readonly parentsBase?:      string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

type SchemaProperties = Record<string, Record<string, unknown>>;

/**
 * Deeply sort object keys recursively (same sort the SchemaInducer applies).
 * Returns a new object with all keys sorted lexicographically at every level.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Extract the property key from a simple JSON Pointer (`/propName`).
 *
 * This applier only deals with top-level `properties` keys — the draft
 * schemas produced by SchemaInducer are flat (no nested object schemas),
 * so only one-segment pointers are valid here.
 *
 * Returns `undefined` for pointers that are empty or have more than one
 * segment (multi-segment pointers are not yet supported and will generate
 * a warning at the call site).
 */
function pointerToPropKey(pointer: string): string | undefined {
  if (!pointer.startsWith('/')) return undefined;
  const segments = pointer.slice(1).split('/');
  if (segments.length !== 1) return undefined;
  const raw = segments[0];
  if (raw === undefined || raw.length === 0) return undefined;
  // RFC 6901: unescape ~1 then ~0.
  return raw.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Resolve a simple one-segment JSON Pointer against the properties map.
 * Returns the property name if found; `undefined` otherwise.
 */
function resolvePropertyKey(
  properties: SchemaProperties,
  pointer:    string,
): string | undefined {
  const key = pointerToPropKey(pointer);
  if (key === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(properties, key) ? key : undefined;
}

/** Regexp for valid parent class names (must start with a letter, then letters/digits/underscores). */
const PARENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Derive the base URL for parent class `$ref` paths from a draft schema `$id`.
 *
 * Derivation rule:
 *   1. Parse the `$id` URL.
 *   2. Take the pathname directory of the `$id` (everything before the last `/`).
 *   3. If that directory ends with `/inferred`, strip `/inferred` as well — this
 *      aligns with the convention that draft schemas live in `<origin>/schemas/inferred/`
 *      while final (blessed) schemas live in `<origin>/schemas/`.
 *   4. Reconstruct a full URL (no trailing slash).
 *
 * Example:
 *   `$id = "https://2e.aonprd.com/schemas/inferred/Feat.draft.json"`
 *   → pathname dir = `/schemas/inferred`
 *   → after strip  = `/schemas`
 *   → result       = `"https://2e.aonprd.com/schemas"`
 *
 * Fallback: if the `$id` is absent, malformed, or cannot be parsed as a URL,
 * returns `undefined` and the caller should warn.
 */
function deriveFinalsBase(draftId: unknown): string | undefined {
  if (typeof draftId !== 'string' || draftId.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(draftId);
  } catch {
    return undefined;
  }
  const pathname  = url.pathname;
  // Strip the leaf filename.
  const lastSlash = pathname.lastIndexOf('/');
  let dir         = lastSlash >= 0 ? pathname.slice(0, lastSlash) : '';
  // Strip `/inferred` suffix if present.
  if (dir.endsWith('/inferred')) {
    dir = dir.slice(0, dir.length - '/inferred'.length);
  }
  // Reconstruct: origin (scheme + host + port) + derived path (no trailing slash).
  return `${url.origin}${dir}`;
}

// ─── Applier class ────────────────────────────────────────────────────────────

/**
 * Applies a refinement DSL document to a draft schema.
 *
 * All methods are static; the class is a namespace for the operation.
 */
export class RefinementApplier {
  /**
   * Apply `refineSpec` to `draftJson`, returning the final schema and any
   * warnings generated by unresolvable pointers.
   *
   * @param draftJson  - Parsed draft schema (from `<className>.draft.json`).
   * @param refineSpec - Parsed refinement document (validated against the schema).
   * @returns `{ final, warnings }` — `final` is the key-sorted final schema;
   *          `warnings` is a (possibly empty) list of unresolved-pointer notices.
   */
  static apply(
    draftJson:  Record<string, unknown>,
    refineSpec: RefineSpec,
  ): { final: Record<string, unknown>; warnings: ReadonlyArray<RefineWarning> } {
    const warnings: RefineWarning[] = [];

    // Work on a deep clone so the caller's draft is never mutated.
    const doc = JSON.parse(JSON.stringify(draftJson)) as Record<string, unknown>;

    // Ensure `properties` exists and is a plain object.
    if (doc['properties'] === undefined || doc['properties'] === null) {
      doc['properties'] = {};
    }
    const properties = doc['properties'] as SchemaProperties;

    // Ensure `required` is an array (may be absent).
    const required: string[] =
      Array.isArray(doc['required']) ? (doc['required'] as string[]) : [];

    // ── 1. drop ───────────────────────────────────────────────────────────────
    for (const pointer of refineSpec.drop ?? []) {
      const key = resolvePropertyKey(properties, pointer);
      if (key === undefined) {
        warnings.push({
          code:    'DROP_UNRESOLVED',
          pointer,
          message: `drop: pointer "${pointer}" does not resolve to a property in the draft`,
        });
        continue;
      }
      delete properties[key];
      const idx = required.indexOf(key);
      if (idx !== -1) required.splice(idx, 1);
    }

    // ── 2. rename ─────────────────────────────────────────────────────────────
    for (const [pointer, newName] of Object.entries(refineSpec.rename ?? {})) {
      const key = resolvePropertyKey(properties, pointer);
      if (key === undefined) {
        warnings.push({
          code:    'RENAME_UNRESOLVED',
          pointer,
          message: `rename: pointer "${pointer}" does not resolve to a property in the draft`,
        });
        continue;
      }
      if (key !== newName) {
        properties[newName] = properties[key] as Record<string, unknown>;
        delete properties[key];
        const idx = required.indexOf(key);
        if (idx !== -1) required[idx] = newName;
      }
    }

    // ── 3. closedEnum ─────────────────────────────────────────────────────────
    for (const propName of refineSpec.closedEnum ?? []) {
      const pointer = `/${propName}`;
      const key     = resolvePropertyKey(properties, pointer);
      if (key === undefined) {
        warnings.push({
          code:    'CLOSED_ENUM_UNRESOLVED',
          pointer,
          message: `closedEnum: property "${propName}" does not exist in the draft`,
        });
        continue;
      }
      const prop = properties[key] as Record<string, unknown>;
      prop['x-squashage-closed-enum'] = true;

      // If enum is absent, try to back-fill from inducer hints.
      if (prop['enum'] === undefined) {
        const examples       = prop['examples'];
        const distinctValues = prop['x-squashage-distinct-values'];
        const source         = distinctValues ?? examples;
        if (Array.isArray(source) && source.length > 0) {
          prop['enum'] = [...source].sort();
        } else {
          warnings.push({
            code:    'CLOSED_ENUM_NO_VALUES',
            pointer,
            message: `closedEnum: property "${propName}" has no enum values in the draft (no examples or distinct-values hint)`,
          });
        }
      }
    }

    // ── 4. openVocabulary ─────────────────────────────────────────────────────
    for (const propName of refineSpec.openVocabulary ?? []) {
      const pointer = `/${propName}`;
      const key     = resolvePropertyKey(properties, pointer);
      if (key === undefined) {
        warnings.push({
          code:    'OPEN_VOCAB_UNRESOLVED',
          pointer,
          message: `openVocabulary: property "${propName}" does not exist in the draft`,
        });
        continue;
      }
      const prop = properties[key] as Record<string, unknown>;
      prop['x-squashage-open-vocab'] = true;
      if (prop['enum'] !== undefined) {
        delete prop['enum'];
      }
    }

    // ── 5. promoteIri ─────────────────────────────────────────────────────────
    for (const pointer of refineSpec.promoteIri ?? []) {
      const key = resolvePropertyKey(properties, pointer);
      if (key === undefined) {
        warnings.push({
          code:    'PROMOTE_IRI_UNRESOLVED',
          pointer,
          message: `promoteIri: pointer "${pointer}" does not resolve to a property in the draft`,
        });
        continue;
      }
      const prop = properties[key] as Record<string, unknown>;
      prop['x-squashage-iri-promotion'] = true;
      prop['format']                    = 'iri';
    }

    // ── 6. range ─────────────────────────────────────────────────────────────
    for (const [propName, rangeClass] of Object.entries(refineSpec.range ?? {})) {
      const pointer = `/${propName}`;
      const key     = resolvePropertyKey(properties, pointer);
      if (key === undefined) {
        warnings.push({
          code:    'RANGE_UNRESOLVED',
          pointer,
          message: `range: property "${propName}" does not exist in the draft`,
        });
        continue;
      }
      const prop = properties[key] as Record<string, unknown>;
      prop['x-squashage-range'] = rangeClass;
    }

    // ── 7. rdfsLabel ─────────────────────────────────────────────────────────
    if (refineSpec.rdfsLabel !== undefined) {
      const pointer = `/${refineSpec.rdfsLabel}`;
      const key     = resolvePropertyKey(properties, pointer);
      if (key === undefined) {
        warnings.push({
          code:    'RDFS_LABEL_UNRESOLVED',
          pointer,
          message: `rdfsLabel: pointer "${pointer}" does not resolve to a property in the draft`,
        });
      } else {
        doc['x-squashage-rdfs-label'] = pointer;
      }
    }

    // ── 8. rdfsComment ───────────────────────────────────────────────────────
    if (refineSpec.rdfsComment !== undefined) {
      const pointer = `/${refineSpec.rdfsComment}`;
      const key     = resolvePropertyKey(properties, pointer);
      if (key === undefined) {
        warnings.push({
          code:    'RDFS_COMMENT_UNRESOLVED',
          pointer,
          message: `rdfsComment: pointer "${pointer}" does not resolve to a property in the draft`,
        });
      } else {
        doc['x-squashage-rdfs-comment'] = pointer;
      }
    }

    // ── 9. subjectIriPolicy ───────────────────────────────────────────────────
    if (refineSpec.subjectIriPolicy !== undefined) {
      doc['x-squashage-subject-iri'] = { ...refineSpec.subjectIriPolicy };
    }

    // ── 10. arrayEnumIri ─────────────────────────────────────────────────────
    if (refineSpec.arrayEnumIri !== undefined) {
      const orphans: string[] = [];
      for (const propName of Object.keys(refineSpec.arrayEnumIri).sort()) {
        if (!Object.prototype.hasOwnProperty.call(properties, propName)) {
          orphans.push(propName);
          warnings.push({
            code:    'ARRAY_ENUM_IRI_UNRESOLVED',
            pointer: `/${propName}`,
            message: `arrayEnumIri: property "${propName}" does not exist in the draft`,
          });
        }
      }
      // Write the hint regardless of orphans for declared non-orphan keys.
      const validEntries = Object.fromEntries(
        Object.entries(refineSpec.arrayEnumIri).filter(([k]) => !orphans.includes(k)),
      );
      if (Object.keys(validEntries).length > 0) {
        doc['x-squashage-array-enum-iri'] = validEntries;
      }
    }

    // ── 11. skolemSubject ─────────────────────────────────────────────────────
    if (refineSpec.skolemSubject !== undefined) {
      const orphans: string[] = [];
      for (const propName of Object.keys(refineSpec.skolemSubject).sort()) {
        if (!Object.prototype.hasOwnProperty.call(properties, propName)) {
          orphans.push(propName);
          warnings.push({
            code:    'SKOLEM_SUBJECT_UNRESOLVED',
            pointer: `/${propName}`,
            message: `skolemSubject: property "${propName}" does not exist in the draft`,
          });
        }
      }
      const validEntries = Object.fromEntries(
        Object.entries(refineSpec.skolemSubject).filter(([k]) => !orphans.includes(k)),
      );
      if (Object.keys(validEntries).length > 0) {
        doc['x-squashage-skolem-subject'] = validEntries;
      }
    }

    // ── 12. provenanceIri ─────────────────────────────────────────────────────
    if (refineSpec.provenanceIri !== undefined) {
      doc['x-squashage-provenance'] = { ...refineSpec.provenanceIri };
    }

    // ── 13. predicateOverride ─────────────────────────────────────────────────
    if (refineSpec.predicateOverride !== undefined) {
      const orphans: string[] = [];
      for (const propName of Object.keys(refineSpec.predicateOverride).sort()) {
        if (!Object.prototype.hasOwnProperty.call(properties, propName)) {
          orphans.push(propName);
          warnings.push({
            code:    'PREDICATE_OVERRIDE_UNRESOLVED',
            pointer: `/${propName}`,
            message: `predicateOverride: property "${propName}" does not exist in the draft`,
          });
        }
      }
      const validEntries = Object.fromEntries(
        Object.entries(refineSpec.predicateOverride).filter(([k]) => !orphans.includes(k)),
      );
      if (Object.keys(validEntries).length > 0) {
        doc['x-squashage-predicate-override'] = validEntries;
      }
    }

    // ── 14. inverseOf ─────────────────────────────────────────────────────────
    if (refineSpec.inverseOf !== undefined) {
      doc['x-squashage-inverse-of'] = { ...refineSpec.inverseOf };
    }

    // ── 15. parents ───────────────────────────────────────────────────────────
    if (refineSpec.parents !== undefined && refineSpec.parents.length > 0) {
      // Resolve the base URL for $ref paths.
      // Use an explicit override when provided; otherwise derive from the draft's $id.
      const finalsBase: string | undefined =
        refineSpec.parentsBase !== undefined
          ? refineSpec.parentsBase
          : deriveFinalsBase(doc['$id']);

      if (finalsBase === undefined) {
        // Cannot derive base — emit one warning for each parent entry and skip all.
        const draftId = String(doc['$id']);
        for (let i = 0; i < refineSpec.parents.length; i++) {
          warnings.push({
            code:    'PARENTS_BASE_UNRESOLVABLE',
            pointer: `#/parents/${i}`,
            message: `parents: cannot derive finalsBase from draft $id "${draftId}"; provide parentsBase explicitly`,
          });
        }
      } else {
        const allOfEntries: Array<{ $ref: string }> = [];
        for (const parentName of refineSpec.parents) {
          // Validate: empty string or non-identifier → warn and skip.
          if (parentName.length === 0 || !PARENT_NAME_PATTERN.test(parentName)) {
            warnings.push({
              code:    'PARENTS_INVALID_NAME',
              pointer: '#/parents',
              message: `parents: "${parentName}" is not a valid class name (must match [A-Za-z][A-Za-z0-9_]*)`,
            });
            continue;
          }
          allOfEntries.push({ $ref: `${finalsBase}/${parentName}.schema.json` });
        }
        if (allOfEntries.length > 0) {
          // Merge with any existing allOf the draft already carries.
          const existing = Array.isArray(doc['allOf'])
            ? (doc['allOf'] as Array<{ $ref: string }>)
            : [];
          doc['allOf'] = [...existing, ...allOfEntries];
        }
      }
    }

    // Write back required (if non-empty) or remove it.
    if (required.length > 0) {
      doc['required'] = required;
    } else {
      delete doc['required'];
    }

    // Write properties back (may have been mutated in place).
    doc['properties'] = properties;

    const final = sortKeys(doc) as Record<string, unknown>;

    return { final, warnings };
  }
}
