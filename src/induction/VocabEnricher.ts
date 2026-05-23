/**
 * VocabEnricher — pure, stateless projection-time enricher.
 *
 * Reads `x-squashage-*` extension hints written by {@link RefinementApplier}
 * into the final schema and produces additional quads (or rewrites existing
 * quads for `predicateOverride`) beyond what json-tology emits by default.
 *
 * No I/O. No Date.now(). No Math.random(). Deterministic given the same inputs.
 *
 * Supported hints (consumed in this order):
 *   x-squashage-array-enum-iri    → arrayEnumIri op
 *   x-squashage-skolem-subject    → skolemSubject op
 *   x-squashage-provenance        → provenanceIri op
 *   x-squashage-predicate-override → predicateOverride op (rewrites base quads)
 *   x-squashage-inverse-of        → inverseOf op (appends extra quads)
 */

import type { DataFactory, DefaultGraph, NamedNode, Quad } from '@rdfjs/types';

// ─── Curie map ────────────────────────────────────────────────────────────────

const CURIE_MAP: Readonly<Record<string, string>> = {
  'dct:':   'http://purl.org/dc/terms/',
  'skos:':  'http://www.w3.org/2004/02/skos/core#',
  'rdf:':   'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'rdfs:':  'http://www.w3.org/2000/01/rdf-schema#',
  'xsd:':   'http://www.w3.org/2001/XMLSchema#',
};

/** Expand a curie or return the string unchanged if already a full IRI. */
function expandCurie(curie: string): string {
  for (const [prefix, expansion] of Object.entries(CURIE_MAP)) {
    if (curie.startsWith(prefix)) {
      return expansion + curie.slice(prefix.length);
    }
  }
  return curie;
}

// ─── JSON Pointer (RFC 6901) ──────────────────────────────────────────────────

/**
 * Resolve a JSON Pointer against an arbitrary value.
 *
 * Returns `undefined` when any segment is absent or the path is not a valid
 * RFC 6901 pointer (must start with `/` or be the empty string `""`).
 */
function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  if (!pointer.startsWith('/')) return undefined;

  const tokens = pointer.slice(1).split('/');
  let cursor: unknown = root;

  for (const raw of tokens) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    cursor = (cursor as Record<string, unknown>)[key];
  }

  return cursor;
}

// ─── Sanitize helpers ─────────────────────────────────────────────────────────

/**
 * Replace runs of non-`[A-Za-z0-9]` characters with a single `-`.
 * This matches the audit spec for IRI-safe enum segment names.
 */
function sanitizeIriSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '-');
}

// ─── XSD type → literal datatype IRI ─────────────────────────────────────────

const XSD_TYPE_IRI: Readonly<Record<string, string>> = {
  'xsd:string':  'http://www.w3.org/2001/XMLSchema#string',
  'xsd:integer': 'http://www.w3.org/2001/XMLSchema#integer',
  'xsd:number':  'http://www.w3.org/2001/XMLSchema#decimal',
  'xsd:boolean': 'http://www.w3.org/2001/XMLSchema#boolean',
};

// ─── Vocab IRI builder ────────────────────────────────────────────────────────

/**
 * Build a vocabulary-namespace IRI from a baseIRI and a local name.
 *
 * Strips trailing `#` and `/` from the baseIRI, then appends `#<localName>`.
 * Mirrors the convention used in {@link JsonTologyOntology}.
 */
function vocabIri(baseIRI: string, localName: string): string {
  let trimmed = baseIRI;
  while (trimmed.endsWith('#') || trimmed.endsWith('/')) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}#${localName}`;
}

// ─── Sub-type declarations ────────────────────────────────────────────────────

interface SkolemEntry {
  readonly fragment:   string;
  readonly type:       string;
  readonly properties?: Record<string, string>;
}

interface ProvenanceSpec {
  readonly predicate: string;
  readonly from:      string;
}

// ─── VocabEnricher ────────────────────────────────────────────────────────────

/**
 * Projection-time quad enricher.
 *
 * Reads `x-squashage-*` hints from a final schema and produces additional
 * quads (plus possible rewrites of the base quad set).
 */
export class VocabEnricher {
  /**
   * Enrich the projected quad set with additional quads derived from the
   * schema's `x-squashage-*` extension hints.
   *
   * @param baseQuads    - Quads already produced by json-tology projection.
   * @param schema       - The final schema (may carry x-squashage-* hints).
   * @param instance     - The raw record instance being projected.
   * @param subjectIri   - The policy-resolved subject IRI for this record.
   * @param factory      - RDF/JS DataFactory for term construction.
   * @param baseIRI      - Vocabulary base IRI (for vocab:X expansion).
   * @param targetGraph  - Named graph to stamp on every emitted quad.
   * @returns A new (possibly larger) array of quads. Never mutates the input.
   */
  static enrich(
    baseQuads:   ReadonlyArray<Quad>,
    schema:      Readonly<Record<string, unknown>>,
    instance:    Readonly<Record<string, unknown>>,
    subjectIri:  string,
    factory:     DataFactory,
    baseIRI:     string,
    targetGraph: NamedNode | DefaultGraph,
  ): ReadonlyArray<Quad> {
    const subject = factory.namedNode(subjectIri);

    // ── a. predicateOverride — rewrites base quads ────────────────────────────
    const overrideMap = readOverrideMap(schema);
    let workingQuads: ReadonlyArray<Quad> = overrideMap.size > 0
      ? applyPredicateOverrides(baseQuads, overrideMap, factory, targetGraph)
      : baseQuads;

    // ── b. inverseOf — appends inverse triples to base quads ──────────────────
    const inverseMap = readInverseMap(schema);
    if (inverseMap.size > 0) {
      workingQuads = applyInverseOf(workingQuads, inverseMap, factory, baseIRI, targetGraph);
    }

    // ── c. arrayEnumIri ───────────────────────────────────────────────────────
    const arrayEnumMap = readArrayEnumMap(schema);
    const arrayEnumQuads = arrayEnumMap.size > 0
      ? emitArrayEnumIri(arrayEnumMap, instance, subject, factory, baseIRI, targetGraph)
      : [];

    // ── d. skolemSubject ──────────────────────────────────────────────────────
    const skolemMap = readSkolemMap(schema);
    const skolemQuads = skolemMap.size > 0
      ? emitSkolemSubjects(skolemMap, instance, subjectIri, factory, baseIRI, targetGraph)
      : [];

    // ── e. provenanceIri ──────────────────────────────────────────────────────
    const provSpec = readProvenanceSpec(schema);
    const provenanceQuads = provSpec !== null
      ? emitProvenanceIri(provSpec, instance, subject, factory, targetGraph)
      : [];

    // ── collect all quads ─────────────────────────────────────────────────────
    const extras = [...arrayEnumQuads, ...skolemQuads, ...provenanceQuads];
    if (extras.length === 0) return workingQuads;

    return [...workingQuads, ...extras];
  }
}

// ─── Schema hint readers ──────────────────────────────────────────────────────

function readArrayEnumMap(schema: Readonly<Record<string, unknown>>): Map<string, string> {
  const raw = schema['x-squashage-array-enum-iri'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return new Map();
  const result = new Map<string, string>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') result.set(k, v);
  }
  return result;
}

function readSkolemMap(schema: Readonly<Record<string, unknown>>): Map<string, SkolemEntry> {
  const raw = schema['x-squashage-skolem-subject'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return new Map();
  const result = new Map<string, SkolemEntry>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const entry = v as Record<string, unknown>;
      if (typeof entry['fragment'] === 'string' && typeof entry['type'] === 'string') {
        const rawProps = entry['properties'];
        const base: SkolemEntry = { fragment: entry['fragment'], type: entry['type'] };
        const skolem: SkolemEntry =
          rawProps !== null && typeof rawProps === 'object' && !Array.isArray(rawProps)
            ? { ...base, properties: rawProps as Record<string, string> }
            : base;
        result.set(k, skolem);
      }
    }
  }
  return result;
}

function readProvenanceSpec(schema: Readonly<Record<string, unknown>>): ProvenanceSpec | null {
  const raw = schema['x-squashage-provenance'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['predicate'] === 'string' && typeof obj['from'] === 'string') {
    return { predicate: obj['predicate'], from: obj['from'] };
  }
  return null;
}

function readOverrideMap(schema: Readonly<Record<string, unknown>>): Map<string, string> {
  const raw = schema['x-squashage-predicate-override'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return new Map();
  const result = new Map<string, string>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') result.set(k, v);
  }
  return result;
}

function readInverseMap(schema: Readonly<Record<string, unknown>>): Map<string, string> {
  const raw = schema['x-squashage-inverse-of'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return new Map();
  const result = new Map<string, string>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') result.set(k, v);
  }
  return result;
}

// ─── Emitters ─────────────────────────────────────────────────────────────────

function emitArrayEnumIri(
  map:         Map<string, string>,
  instance:    Readonly<Record<string, unknown>>,
  subject:     NamedNode,
  factory:     DataFactory,
  baseIRI:     string,
  targetGraph: NamedNode | DefaultGraph,
): Quad[] {
  const quads: Quad[] = [];
  for (const [propName, rangeClass] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const values = instance[propName];
    if (!Array.isArray(values)) continue;
    const predicate = factory.namedNode(vocabIri(baseIRI, propName));
    for (const val of values) {
      if (typeof val !== 'string' || val.length === 0) continue;
      const objectIri = vocabIri(baseIRI, `${rangeClass}-${sanitizeIriSegment(val)}`);
      quads.push(factory.quad(subject, predicate, factory.namedNode(objectIri), targetGraph));
    }
  }
  return quads;
}

function emitSkolemSubjects(
  map:         Map<string, SkolemEntry>,
  instance:    Readonly<Record<string, unknown>>,
  subjectIri:  string,
  factory:     DataFactory,
  baseIRI:     string,
  targetGraph: NamedNode | DefaultGraph,
): Quad[] {
  const quads: Quad[] = [];
  const RDF_TYPE_IRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

  for (const [fieldName, entry] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const fieldValue = instance[fieldName];
    if (fieldValue === undefined || fieldValue === null) continue;

    const skolemSubjectIri = `${subjectIri}#${entry.fragment}`;
    const skolemNode = factory.namedNode(skolemSubjectIri);
    const classNode  = factory.namedNode(vocabIri(baseIRI, entry.type));

    // rdf:type assertion on the skolem subject
    quads.push(factory.quad(
      skolemNode,
      factory.namedNode(RDF_TYPE_IRI),
      classNode,
      targetGraph,
    ));

    // Link from main subject → skolem subject via the field predicate
    quads.push(factory.quad(
      factory.namedNode(subjectIri),
      factory.namedNode(vocabIri(baseIRI, fieldName)),
      skolemNode,
      targetGraph,
    ));

    // Data properties on the skolem subject
    if (entry.properties !== undefined) {
      const fieldRecord = typeof fieldValue === 'object' && !Array.isArray(fieldValue)
        ? (fieldValue as Record<string, unknown>)
        : null;

      for (const [propName, xsdType] of Object.entries(entry.properties).sort(
        ([a], [b]) => a.localeCompare(b),
      )) {
        const rawVal = fieldRecord !== null ? fieldRecord[propName] : fieldValue;
        if (rawVal === undefined || rawVal === null) continue;

        const dtIri = XSD_TYPE_IRI[xsdType];
        if (dtIri === undefined) continue;

        const strVal = coerceLiteralValue(rawVal, xsdType);
        if (strVal === null) continue;

        quads.push(factory.quad(
          skolemNode,
          factory.namedNode(vocabIri(baseIRI, propName)),
          factory.literal(strVal, factory.namedNode(dtIri)),
          targetGraph,
        ));
      }
    }
  }

  return quads;
}

function emitProvenanceIri(
  spec:        ProvenanceSpec,
  instance:    Readonly<Record<string, unknown>>,
  subject:     NamedNode,
  factory:     DataFactory,
  targetGraph: NamedNode | DefaultGraph,
): Quad[] {
  const resolved = resolvePointer(instance, spec.from);
  if (typeof resolved !== 'string' || resolved.length === 0) return [];

  const predicate = factory.namedNode(expandCurie(spec.predicate));
  return [factory.quad(subject, predicate, factory.namedNode(resolved), targetGraph)];
}

function applyPredicateOverrides(
  quads:       ReadonlyArray<Quad>,
  overrideMap: Map<string, string>,
  factory:     DataFactory,
  targetGraph: NamedNode | DefaultGraph,
): Quad[] {
  // Build a set of vocab predicate IRIs that should be overridden.
  // We match by checking whether the quad's predicate value ends with `#<fieldName>`
  // (the convention used in vocabIri). Since the baseIRI varies, we store the
  // fragment suffix pattern as `#<fieldName>`.
  const overridePairs: Array<[string, NamedNode]> = [...overrideMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fieldName, overrideCurie]) => [
      `#${fieldName}`,
      factory.namedNode(expandCurie(overrideCurie)),
    ]);

  return quads.map((quad) => {
    if (quad.predicate.termType !== 'NamedNode') return quad;
    const predicateValue = quad.predicate.value;
    for (const [suffix, newPredicate] of overridePairs) {
      if (predicateValue.endsWith(suffix)) {
        return factory.quad(quad.subject, newPredicate, quad.object, targetGraph);
      }
    }
    return quad;
  });
}

function applyInverseOf(
  quads:       ReadonlyArray<Quad>,
  inverseMap:  Map<string, string>,
  factory:     DataFactory,
  baseIRI:     string,
  targetGraph: NamedNode | DefaultGraph,
): Quad[] {
  // Pairs: [vocab IRI of forwardProp, vocab IRI of inverseProp]
  const inversePairs: Array<[string, string]> = [...inverseMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([forwardProp, inverseProp]) => [
      vocabIri(baseIRI, forwardProp),
      vocabIri(baseIRI, inverseProp),
    ]);

  const extras: Quad[] = [];
  for (const quad of quads) {
    if (quad.predicate.termType !== 'NamedNode') continue;
    const predicateValue = quad.predicate.value;
    for (const [forwardIri, inverseIri] of inversePairs) {
      if (predicateValue === forwardIri && quad.object.termType === 'NamedNode') {
        extras.push(factory.quad(
          quad.object as NamedNode,
          factory.namedNode(inverseIri),
          quad.subject,
          targetGraph,
        ));
      }
    }
  }

  if (extras.length === 0) return quads as Quad[];
  return [...quads, ...extras];
}

// ─── Literal coercion ─────────────────────────────────────────────────────────

function coerceLiteralValue(value: unknown, xsdType: string): string | null {
  switch (xsdType) {
    case 'xsd:string':  return typeof value === 'string' ? value : String(value);
    case 'xsd:integer': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? String(Math.trunc(n)) : null;
    }
    case 'xsd:number':  {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? String(n) : null;
    }
    case 'xsd:boolean': {
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      if (value === 'true' || value === '1') return 'true';
      if (value === 'false' || value === '0') return 'false';
      return null;
    }
    default: return null;
  }
}
