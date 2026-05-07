/**
 * @fileoverview Fixture plugin for the Pathfinder/aonprd e2e test suite.
 *
 * @remarks
 * Registers `aonprd:squash` — a pipeline task that branches on
 * `state.classification.type` and emits class-appropriate quads using only
 * `state.context.prefixes` and `state.context.factory`. No IRIs are hardcoded.
 *
 * Prefix derivation (all synthetic fallback — see PrefixResolver):
 * - `instances.base`  -> `https://squashage.dev/instance/aonprd/`
 * - `graphs.base`     -> `https://squashage.dev/graph/aonprd/`
 * - `vocabulary.base` -> `https://squashage.dev/vocabulary/aonprd#`
 *
 * Subject IRI: `instances.base + url-tail` where url-tail is derived from the
 * record's `_source.url` (parsed at task time from `state.input`).
 *
 * Pokemontology-style enrichment (v0.5.0):
 * - Item 1:  rdfs:label "Name"@en on every emitter
 * - Item 2:  Monster stat-block bnode reification (hp, ac, perception, ability scores)
 * - Item 3:  Reified ActionCost resource (feat + action emitters)
 * - Item 4:  Spell school as second-axis IRI
 * - Item 5:  Feat hasPrerequisite + inverse isPrerequisiteFor
 * - Item 6:  Trait skos:broader hierarchy (category field)
 * - Item 7:  dct:source per-record provenance
 * - Item 8:  Description literal (description_text field)
 * - Item 9:  Monster size as IRI not literal
 *
 * @module tests/e2e/aonprd/plugin
 * @category TestFixture
 * @since 0.1.0
 */

import { TaskRegistry } from '../../../src/registry/TaskRegistry.js';
import type { NextFnInterface } from '../../../src/types/Pipeline.js';
import type { PipelineStateInterface } from '../../../src/types/PipelineState.js';
import type { DataFactory, NamedNode, Quad } from '@rdfjs/types';

// ---------------------------------------------------------------------------
// Well-known IRIs (static — standard vocabularies, not domain IRIs)
// ---------------------------------------------------------------------------

const RDF_TYPE_IRI    = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_STRING_IRI  = 'http://www.w3.org/2001/XMLSchema#string';
const XSD_INTEGER_IRI = 'http://www.w3.org/2001/XMLSchema#integer';
const RDFS_LABEL_IRI  = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_BROADER_IRI = 'http://www.w3.org/2004/02/skos/core#broader';
const DCT_SOURCE_IRI  = 'http://purl.org/dc/terms/source';

// Stat fields emitted as StatBlock bnodes in emitMonsterQuads.
const STAT_BLOCK_FIELDS: ReadonlyArray<string> = [
  'hp', 'ac', 'perception', 'str', 'dex', 'con', 'int', 'wis', 'cha',
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derives the URL tail from a record's `_source.url` or top-level `url` field.
 *
 * @remarks
 * Checks `_source.url` first (squashage-enriched records written by the
 * orchestrator), then the top-level `url` field (direct ripperoni scrape
 * output), yielding a path+query string suitable for use as the local part
 * of the instance IRI.  Falls back to a sanitized form of the record name
 * when neither URL field is present or parseable.
 *
 * @param input - Parsed record from `state.input`.
 * @returns The URL tail string (e.g. `Feats.aspx?ID=750`).
 */
function deriveUrlTail(input: Readonly<Record<string, unknown>>): string {
  // Helper: attempt to parse a raw URL string and return its path+query tail.
  const tryUrl = (rawUrl: unknown): string | null => {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;
    try {
      const parsed = new URL(rawUrl);
      return (parsed.pathname + parsed.search).replace(/^\//, '');
    } catch {
      return null;
    }
  };

  // 1. _source.url (squashage-enriched records).
  const source = input['_source'];
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    const tail = tryUrl((source as Record<string, unknown>)['url']);
    if (tail !== null) return tail;
  }

  // 2. Top-level url (direct ripperoni scrape output).
  const tail = tryUrl(input['url']);
  if (tail !== null) return tail;

  // 3. Fallback: sanitized name — no URL available.
  const name = typeof input['name'] === 'string' ? input['name'] : 'unknown';
  return sanitizeLocal(name.toLowerCase());
}

/**
 * Sanitizes a local name for use in an IRI by replacing spaces and
 * other characters that are illegal in IRIs without percent-encoding.
 *
 * @param localName - Raw local name (e.g. `"versatile P"`).
 * @returns IRI-safe local name (e.g. `"versatile-P"`).
 */
function sanitizeLocal(localName: string): string {
  return localName.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.~]/g, '_');
}

/**
 * Slugifies a prerequisite name for use in a feat IRI.
 *
 * @param name - Prerequisite name string.
 * @returns Slug suitable for use in an IRI local part.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '');
}

/**
 * Produces a NamedNode for a vocabulary term (predicate or class IRI).
 *
 * @param vocabularyBase - The vocabulary namespace base IRI.
 * @param localName      - The local name of the term (sanitized for IRI safety).
 * @param factory        - RDF/JS data factory.
 * @returns A NamedNode with IRI `vocabularyBase + sanitizedLocalName`.
 */
function vocab(vocabularyBase: string, localName: string, factory: DataFactory): NamedNode {
  return factory.namedNode(`${vocabularyBase}${sanitizeLocal(localName)}`);
}

/**
 * Produces a NamedNode for an instance IRI.
 *
 * @param instanceBase - The instance namespace base IRI.
 * @param tail         - The URL tail of the record.
 * @param factory      - RDF/JS data factory.
 * @returns A NamedNode with IRI `instanceBase + tail`.
 */
function instance(instanceBase: string, tail: string, factory: DataFactory): NamedNode {
  return factory.namedNode(`${instanceBase}${tail}`);
}

/**
 * Produces a NamedNode for a named graph IRI.
 *
 * @param graphBase  - The graph namespace base IRI.
 * @param className  - The class name (e.g. `'feat'`).
 * @param factory    - RDF/JS data factory.
 * @returns A NamedNode with IRI `graphBase + className`.
 */
function graph(graphBase: string, className: string, factory: DataFactory): NamedNode {
  return factory.namedNode(`${graphBase}${className}`);
}

/**
 * Emits a `rdfs:label "name"@en` quad if the record has a `name` string field.
 *
 * Item 1 helper — called from every class-specific emitter.
 *
 * @param subject   - Subject NamedNode.
 * @param input     - Parsed record.
 * @param graphNode - Named graph NamedNode.
 * @param factory   - RDF/JS data factory.
 * @param quads     - Mutable output array.
 */
function pushRdfsLabel(
  subject:   NamedNode,
  input:     Readonly<Record<string, unknown>>,
  graphNode: NamedNode,
  factory:   DataFactory,
  quads:     Quad[],
): void {
  if (typeof input['name'] === 'string') {
    quads.push(factory.quad(
      subject,
      factory.namedNode(RDFS_LABEL_IRI),
      factory.literal(input['name'], 'en'),
      graphNode,
    ));
  }
}

/**
 * Emits a `dct:source <url>` quad if the record has a `_source.url` field.
 *
 * Item 7 helper — called from every class-specific emitter.
 *
 * @param subject   - Subject NamedNode.
 * @param input     - Parsed record.
 * @param graphNode - Named graph NamedNode.
 * @param factory   - RDF/JS data factory.
 * @param quads     - Mutable output array.
 */
function pushDctSource(
  subject:   NamedNode,
  input:     Readonly<Record<string, unknown>>,
  graphNode: NamedNode,
  factory:   DataFactory,
  quads:     Quad[],
): void {
  const source = input['_source'];
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    const url = (source as Record<string, unknown>)['url'];
    if (typeof url === 'string' && url.length > 0) {
      quads.push(factory.quad(
        subject,
        factory.namedNode(DCT_SOURCE_IRI),
        factory.namedNode(url),
        graphNode,
      ));
    }
  }
}

/**
 * Emits a `aonprd:description "..."^^xsd:string` quad if the record has
 * a `description_text` (or `description`) string field.
 *
 * Item 8 helper — called from per-class emitters that have description fields.
 *
 * @param subject   - Subject NamedNode.
 * @param input     - Parsed record.
 * @param vocabBase - Vocabulary base IRI.
 * @param graphNode - Named graph NamedNode.
 * @param factory   - RDF/JS data factory.
 * @param quads     - Mutable output array.
 */
function pushDescription(
  subject:   NamedNode,
  input:     Readonly<Record<string, unknown>>,
  vocabBase: string,
  graphNode: NamedNode,
  factory:   DataFactory,
  quads:     Quad[],
): void {
  const xsdString = factory.namedNode(XSD_STRING_IRI);
  // Prefer description_text (AONPRD scrape convention), fall back to description.
  const desc = typeof input['description_text'] === 'string'
    ? input['description_text']
    : typeof input['description'] === 'string'
      ? input['description']
      : null;
  if (desc !== null) {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'description', factory),
      factory.literal(desc, xsdString),
      graphNode,
    ));
  }
}

// ---------------------------------------------------------------------------
// Quad emitters per class
// ---------------------------------------------------------------------------

/**
 * Emits quads for a classified feat record.
 *
 * Emits (all in graph `<graphs:feat>`):
 * - `<instances:tail>  rdf:type                     <vocabulary:Feat>`
 * - `<instances:tail>  rdfs:label                   "name"@en`
 * - `<instances:tail>  <vocabulary:name>             "name"^^xsd:string`
 * - `<instances:tail>  <vocabulary:level>            level^^xsd:integer`
 * - `<instances:tail>  <vocabulary:rarity>           <vocabulary:Rarity-rarity>`
 * - `<instances:tail>  <vocabulary:trait>            <vocabulary:Trait-traitX>` (per trait)
 * - `<instances:tail>  <vocabulary:actionCost>       _:costNode` (reified ActionCost bnode)
 * - `<instances:tail>  <vocabulary:hasPrerequisite>  <instances:feat-slug>` (per prereq)
 * - `<instances:slug>  <vocabulary:isPrerequisiteFor> <instances:tail>` (inverse)
 * - `<instances:tail>  <vocabulary:description>      "..."^^xsd:string`
 * - `<instances:tail>  dct:source                   <sourceUrl>`
 *
 * @param subject      - Subject NamedNode.
 * @param input        - Parsed record.
 * @param vocabBase    - Vocabulary base IRI.
 * @param instanceBase - Instance base IRI.
 * @param graphNode    - Named graph NamedNode.
 * @param factory      - RDF/JS data factory.
 * @returns Array of quads.
 */
function emitFeatQuads(
  subject:      NamedNode,
  input:        Readonly<Record<string, unknown>>,
  vocabBase:    string,
  instanceBase: string,
  graphNode:    NamedNode,
  factory:      DataFactory,
): Quad[] {
  const quads: Quad[] = [];
  const rdfType    = factory.namedNode(RDF_TYPE_IRI);
  const xsdString  = factory.namedNode(XSD_STRING_IRI);
  const xsdInteger = factory.namedNode(XSD_INTEGER_IRI);

  quads.push(factory.quad(subject, rdfType, vocab(vocabBase, 'Feat', factory), graphNode));

  // Item 1: rdfs:label
  pushRdfsLabel(subject, input, graphNode, factory, quads);

  if (typeof input['name'] === 'string') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'name', factory),
      factory.literal(input['name'], xsdString),
      graphNode,
    ));
  }

  if (typeof input['level'] === 'number') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'level', factory),
      factory.literal(String(input['level']), xsdInteger),
      graphNode,
    ));
  }

  if (typeof input['rarity'] === 'string') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'rarity', factory),
      vocab(vocabBase, `Rarity-${input['rarity']}`, factory),
      graphNode,
    ));
  }

  const traits = input['traits'];
  if (Array.isArray(traits)) {
    for (const trait of traits) {
      if (typeof trait === 'string') {
        quads.push(factory.quad(
          subject,
          vocab(vocabBase, 'trait', factory),
          vocab(vocabBase, `Trait-${trait}`, factory),
          graphNode,
        ));
      }
    }
  }

  // Item 3: reified ActionCost resource (skolemized IRI from subject + fragment)
  if (typeof input['action_cost'] === 'string') {
    const costNode = factory.namedNode(`${subject.value}#actionCost`);
    quads.push(factory.quad(subject, vocab(vocabBase, 'actionCost', factory), costNode, graphNode));
    quads.push(factory.quad(costNode, rdfType, vocab(vocabBase, 'ActionCost', factory), graphNode));
    quads.push(factory.quad(
      costNode,
      vocab(vocabBase, 'actionSymbol', factory),
      factory.literal(input['action_cost'], xsdString),
      graphNode,
    ));
  }

  // Item 5: hasPrerequisite + inverse isPrerequisiteFor
  const prereqLinks = input['prerequisites_links'];
  if (Array.isArray(prereqLinks) && prereqLinks.length > 0) {
    // Structured links from ripperoni (preferred when present)
    for (const link of prereqLinks) {
      if (link !== null && typeof link === 'object' && !Array.isArray(link)) {
        const linkObj = link as Record<string, unknown>;
        const href = typeof linkObj['href'] === 'string' ? linkObj['href'] : null;
        const linkName = typeof linkObj['name'] === 'string' ? linkObj['name'] : null;
        if (href !== null) {
          const prereqNode = factory.namedNode(href);
          quads.push(factory.quad(subject, vocab(vocabBase, 'hasPrerequisite', factory), prereqNode, graphNode));
          quads.push(factory.quad(prereqNode, vocab(vocabBase, 'isPrerequisiteFor', factory), subject, graphNode));
        } else if (linkName !== null) {
          const prereqIri = factory.namedNode(`${instanceBase}feat-${slugify(linkName)}`);
          quads.push(factory.quad(subject, vocab(vocabBase, 'hasPrerequisite', factory), prereqIri, graphNode));
          quads.push(factory.quad(prereqIri, vocab(vocabBase, 'isPrerequisiteFor', factory), subject, graphNode));
        }
      }
    }
  } else {
    // Fallback: plain string or array of strings
    const prereqs = input['prerequisites'];
    if (typeof prereqs === 'string' && prereqs.length > 0) {
      const prereqIri = factory.namedNode(`${instanceBase}feat-${slugify(prereqs)}`);
      quads.push(factory.quad(subject, vocab(vocabBase, 'hasPrerequisite', factory), prereqIri, graphNode));
      quads.push(factory.quad(prereqIri, vocab(vocabBase, 'isPrerequisiteFor', factory), subject, graphNode));
    } else if (Array.isArray(prereqs)) {
      for (const prereq of prereqs) {
        if (typeof prereq === 'string' && prereq.length > 0) {
          const prereqIri = factory.namedNode(`${instanceBase}feat-${slugify(prereq)}`);
          quads.push(factory.quad(subject, vocab(vocabBase, 'hasPrerequisite', factory), prereqIri, graphNode));
          quads.push(factory.quad(prereqIri, vocab(vocabBase, 'isPrerequisiteFor', factory), subject, graphNode));
        }
      }
    }
  }

  // Item 8: description
  pushDescription(subject, input, vocabBase, graphNode, factory, quads);

  // Item 7: dct:source
  pushDctSource(subject, input, graphNode, factory, quads);

  return quads;
}

/**
 * Emits quads for a classified spell record.
 *
 * Emits (all in graph `<graphs:spell>`):
 * - `<instances:tail>  rdf:type               <vocabulary:Spell>`
 * - `<instances:tail>  rdfs:label             "name"@en`
 * - `<instances:tail>  <vocabulary:name>       "name"^^xsd:string`
 * - `<instances:tail>  <vocabulary:level>      level^^xsd:integer`
 * - `<instances:tail>  <vocabulary:rarity>     <vocabulary:Rarity-rarity>`
 * - `<instances:tail>  <vocabulary:school>     <vocabulary:School-school>` (when present)
 * - `<instances:tail>  <vocabulary:tradition>  <vocabulary:Tradition-X>` (per tradition)
 * - `<instances:tail>  <vocabulary:trait>      <vocabulary:Trait-X>` (per trait)
 * - `<instances:tail>  <vocabulary:description> "..."^^xsd:string`
 * - `<instances:tail>  dct:source              <sourceUrl>`
 *
 * @param subject   - Subject NamedNode.
 * @param input     - Parsed record.
 * @param vocabBase - Vocabulary base IRI.
 * @param graphNode - Named graph NamedNode.
 * @param factory   - RDF/JS data factory.
 * @returns Array of quads.
 */
function emitSpellQuads(
  subject:   NamedNode,
  input:     Readonly<Record<string, unknown>>,
  vocabBase: string,
  graphNode: NamedNode,
  factory:   DataFactory,
): Quad[] {
  const quads: Quad[] = [];
  const rdfType    = factory.namedNode(RDF_TYPE_IRI);
  const xsdString  = factory.namedNode(XSD_STRING_IRI);
  const xsdInteger = factory.namedNode(XSD_INTEGER_IRI);

  quads.push(factory.quad(subject, rdfType, vocab(vocabBase, 'Spell', factory), graphNode));

  // Item 1: rdfs:label
  pushRdfsLabel(subject, input, graphNode, factory, quads);

  if (typeof input['name'] === 'string') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'name', factory),
      factory.literal(input['name'], xsdString),
      graphNode,
    ));
  }

  if (typeof input['level'] === 'number') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'level', factory),
      factory.literal(String(input['level']), xsdInteger),
      graphNode,
    ));
  }

  if (typeof input['rarity'] === 'string') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'rarity', factory),
      vocab(vocabBase, `Rarity-${input['rarity']}`, factory),
      graphNode,
    ));
  }

  // Item 4: spell school as second-axis IRI
  if (typeof input['school'] === 'string') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'school', factory),
      vocab(vocabBase, `School-${input['school']}`, factory),
      graphNode,
    ));
  }

  const traditions = input['traditions'];
  if (Array.isArray(traditions)) {
    for (const trad of traditions) {
      if (typeof trad === 'string') {
        quads.push(factory.quad(
          subject,
          vocab(vocabBase, 'tradition', factory),
          vocab(vocabBase, `Tradition-${trad}`, factory),
          graphNode,
        ));
      }
    }
  }

  const traits = input['traits'];
  if (Array.isArray(traits)) {
    for (const trait of traits) {
      if (typeof trait === 'string') {
        quads.push(factory.quad(
          subject,
          vocab(vocabBase, 'trait', factory),
          vocab(vocabBase, `Trait-${trait}`, factory),
          graphNode,
        ));
      }
    }
  }

  // Item 8: description
  pushDescription(subject, input, vocabBase, graphNode, factory, quads);

  // Item 7: dct:source
  pushDctSource(subject, input, graphNode, factory, quads);

  return quads;
}

/**
 * Emits quads for a classified monster record.
 *
 * Emits (all in graph `<graphs:monster>`):
 * - `<instances:tail>  rdf:type           <vocabulary:Monster>`
 * - `<instances:tail>  rdfs:label         "name"@en`
 * - `<instances:tail>  <vocabulary:name>   "name"^^xsd:string`
 * - `<instances:tail>  <vocabulary:level>  level^^xsd:integer`
 * - `<instances:tail>  <vocabulary:rarity> <vocabulary:Rarity-rarity>`
 * - `<instances:tail>  <vocabulary:trait>  <vocabulary:Trait-X>` (per trait)
 * - `<instances:tail>  <vocabulary:size>   <vocabulary:Size-size>` (IRI, not literal)
 * - `<instances:tail>  <vocabulary:statBlock> _:statNode` (per stat field present)
 * - `<instances:tail>  <vocabulary:description> "..."^^xsd:string`
 * - `<instances:tail>  dct:source         <sourceUrl>`
 *
 * @param subject   - Subject NamedNode.
 * @param input     - Parsed record.
 * @param vocabBase - Vocabulary base IRI.
 * @param graphNode - Named graph NamedNode.
 * @param factory   - RDF/JS data factory.
 * @returns Array of quads.
 */
function emitMonsterQuads(
  subject:   NamedNode,
  input:     Readonly<Record<string, unknown>>,
  vocabBase: string,
  graphNode: NamedNode,
  factory:   DataFactory,
): Quad[] {
  const quads: Quad[] = [];
  const rdfType    = factory.namedNode(RDF_TYPE_IRI);
  const xsdString  = factory.namedNode(XSD_STRING_IRI);
  const xsdInteger = factory.namedNode(XSD_INTEGER_IRI);

  quads.push(factory.quad(subject, rdfType, vocab(vocabBase, 'Monster', factory), graphNode));

  // Item 1: rdfs:label
  pushRdfsLabel(subject, input, graphNode, factory, quads);

  if (typeof input['name'] === 'string') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'name', factory),
      factory.literal(input['name'], xsdString),
      graphNode,
    ));
  }

  if (typeof input['level'] === 'number') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'level', factory),
      factory.literal(String(input['level']), xsdInteger),
      graphNode,
    ));
  }

  if (typeof input['rarity'] === 'string') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'rarity', factory),
      vocab(vocabBase, `Rarity-${input['rarity']}`, factory),
      graphNode,
    ));
  }

  const traits = input['traits'];
  if (Array.isArray(traits)) {
    for (const trait of traits) {
      if (typeof trait === 'string') {
        quads.push(factory.quad(
          subject,
          vocab(vocabBase, 'trait', factory),
          vocab(vocabBase, `Trait-${trait}`, factory),
          graphNode,
        ));
      }
    }
  }

  // Item 9: size as IRI not literal
  if (typeof input['size'] === 'string') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'size', factory),
      vocab(vocabBase, `Size-${input['size']}`, factory),
      graphNode,
    ));
  }

  // Item 2: stat-block resource reification (skolemized IRI from subject + stat field)
  for (const statField of STAT_BLOCK_FIELDS) {
    const statVal = input[statField];
    if (statVal === null || statVal === undefined) continue;
    const numVal = typeof statVal === 'number' ? statVal : null;
    if (numVal === null) continue;

    const statNode = factory.namedNode(`${subject.value}#stat-${statField}`);
    quads.push(factory.quad(subject, vocab(vocabBase, 'statBlock', factory), statNode, graphNode));
    quads.push(factory.quad(statNode, rdfType, vocab(vocabBase, 'StatBlock', factory), graphNode));
    quads.push(factory.quad(
      statNode,
      vocab(vocabBase, 'statName', factory),
      factory.literal(statField, xsdString),
      graphNode,
    ));
    quads.push(factory.quad(
      statNode,
      vocab(vocabBase, 'statValue', factory),
      factory.literal(String(numVal), xsdInteger),
      graphNode,
    ));
  }

  // Item 8: description
  pushDescription(subject, input, vocabBase, graphNode, factory, quads);

  // Item 7: dct:source
  pushDctSource(subject, input, graphNode, factory, quads);

  return quads;
}

/**
 * Emits quads for a classified action record.
 *
 * Emits (all in graph `<graphs:action>`):
 * - `<instances:tail>  rdf:type              <vocabulary:Action>`
 * - `<instances:tail>  rdfs:label            "name"@en`
 * - `<instances:tail>  <vocabulary:name>      "name"^^xsd:string`
 * - `<instances:tail>  <vocabulary:rarity>   <vocabulary:Rarity-rarity>`
 * - `<instances:tail>  <vocabulary:trait>    <vocabulary:Trait-X>` (per trait)
 * - `<instances:tail>  <vocabulary:actionCost> _:costNode` (reified ActionCost bnode)
 * - `<instances:tail>  <vocabulary:description> "..."^^xsd:string`
 * - `<instances:tail>  dct:source            <sourceUrl>`
 *
 * @param subject   - Subject NamedNode.
 * @param input     - Parsed record.
 * @param vocabBase - Vocabulary base IRI.
 * @param graphNode - Named graph NamedNode.
 * @param factory   - RDF/JS data factory.
 * @returns Array of quads.
 */
function emitActionQuads(
  subject:   NamedNode,
  input:     Readonly<Record<string, unknown>>,
  vocabBase: string,
  graphNode: NamedNode,
  factory:   DataFactory,
): Quad[] {
  const quads: Quad[] = [];
  const rdfType   = factory.namedNode(RDF_TYPE_IRI);
  const xsdString = factory.namedNode(XSD_STRING_IRI);

  quads.push(factory.quad(subject, rdfType, vocab(vocabBase, 'Action', factory), graphNode));

  // Item 1: rdfs:label
  pushRdfsLabel(subject, input, graphNode, factory, quads);

  if (typeof input['name'] === 'string') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'name', factory),
      factory.literal(input['name'], xsdString),
      graphNode,
    ));
  }

  if (typeof input['rarity'] === 'string') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'rarity', factory),
      vocab(vocabBase, `Rarity-${input['rarity']}`, factory),
      graphNode,
    ));
  }

  const traits = input['traits'];
  if (Array.isArray(traits)) {
    for (const trait of traits) {
      if (typeof trait === 'string') {
        quads.push(factory.quad(
          subject,
          vocab(vocabBase, 'trait', factory),
          vocab(vocabBase, `Trait-${trait}`, factory),
          graphNode,
        ));
      }
    }
  }

  // Item 3: reified ActionCost resource (skolemized IRI from subject + fragment)
  if (typeof input['action_cost'] === 'string') {
    const costNode = factory.namedNode(`${subject.value}#actionCost`);
    quads.push(factory.quad(subject, vocab(vocabBase, 'actionCost', factory), costNode, graphNode));
    quads.push(factory.quad(costNode, rdfType, vocab(vocabBase, 'ActionCost', factory), graphNode));
    quads.push(factory.quad(
      costNode,
      vocab(vocabBase, 'actionSymbol', factory),
      factory.literal(input['action_cost'], xsdString),
      graphNode,
    ));
  }

  // Item 8: description
  pushDescription(subject, input, vocabBase, graphNode, factory, quads);

  // Item 7: dct:source
  pushDctSource(subject, input, graphNode, factory, quads);

  return quads;
}

/**
 * Emits quads for a classified equipment record.
 *
 * Emits (all in graph `<graphs:equipment>`):
 * - `<instances:tail>  rdf:type              <vocabulary:Equipment>`
 * - `<instances:tail>  rdfs:label            "name"@en`
 * - `<instances:tail>  <vocabulary:name>      "name"^^xsd:string`
 * - `<instances:tail>  <vocabulary:rarity>   <vocabulary:Rarity-rarity>`
 * - `<instances:tail>  <vocabulary:trait>    <vocabulary:Trait-X>` (per trait)
 * - `<instances:tail>  <vocabulary:itemLevel> level^^xsd:integer` (when present)
 * - `<instances:tail>  <vocabulary:description> "..."^^xsd:string`
 * - `<instances:tail>  dct:source            <sourceUrl>`
 *
 * @param subject   - Subject NamedNode.
 * @param input     - Parsed record.
 * @param vocabBase - Vocabulary base IRI.
 * @param graphNode - Named graph NamedNode.
 * @param factory   - RDF/JS data factory.
 * @returns Array of quads.
 */
function emitEquipmentQuads(
  subject:   NamedNode,
  input:     Readonly<Record<string, unknown>>,
  vocabBase: string,
  graphNode: NamedNode,
  factory:   DataFactory,
): Quad[] {
  const quads: Quad[] = [];
  const rdfType    = factory.namedNode(RDF_TYPE_IRI);
  const xsdString  = factory.namedNode(XSD_STRING_IRI);
  const xsdInteger = factory.namedNode(XSD_INTEGER_IRI);

  quads.push(factory.quad(subject, rdfType, vocab(vocabBase, 'Equipment', factory), graphNode));

  // Item 1: rdfs:label
  pushRdfsLabel(subject, input, graphNode, factory, quads);

  if (typeof input['name'] === 'string') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'name', factory),
      factory.literal(input['name'], xsdString),
      graphNode,
    ));
  }

  if (typeof input['rarity'] === 'string') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'rarity', factory),
      vocab(vocabBase, `Rarity-${input['rarity']}`, factory),
      graphNode,
    ));
  }

  const traits = input['traits'];
  if (Array.isArray(traits)) {
    for (const trait of traits) {
      if (typeof trait === 'string') {
        quads.push(factory.quad(
          subject,
          vocab(vocabBase, 'trait', factory),
          vocab(vocabBase, `Trait-${trait}`, factory),
          graphNode,
        ));
      }
    }
  }

  if (typeof input['item_level'] === 'number') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'itemLevel', factory),
      factory.literal(String(input['item_level']), xsdInteger),
      graphNode,
    ));
  }

  // Item 8: description
  pushDescription(subject, input, vocabBase, graphNode, factory, quads);

  // Item 7: dct:source
  pushDctSource(subject, input, graphNode, factory, quads);

  return quads;
}

/**
 * Generic emitter for types that share the minimal BaseShape:
 * name, rarity, traits. Used for weapon, armor, shield, ancestry, class,
 * background, condition, trait, hazard, generic, and unknown.
 *
 * Emits (all in graph `<graphs:className>`):
 * - `<instances:tail>  rdf:type              <vocabulary:ClassName>`
 * - `<instances:tail>  rdfs:label            "name"@en`
 * - `<instances:tail>  <vocabulary:name>      "name"^^xsd:string`
 * - `<instances:tail>  <vocabulary:rarity>   <vocabulary:Rarity-rarity>` (when present)
 * - `<instances:tail>  <vocabulary:trait>    <vocabulary:Trait-X>` (per trait)
 * - `<instances:tail>  skos:broader          <vocabulary:TraitCategory-cat>` (trait class only)
 * - `<instances:tail>  dct:source            <sourceUrl>`
 *
 * @param className - RDF class local name (e.g. `'Weapon'`, `'Ancestry'`).
 * @param subject   - Subject NamedNode.
 * @param input     - Parsed record.
 * @param vocabBase - Vocabulary base IRI.
 * @param graphNode - Named graph NamedNode.
 * @param factory   - RDF/JS data factory.
 * @returns Array of quads.
 */
function emitBaseQuads(
  className: string,
  subject:   NamedNode,
  input:     Readonly<Record<string, unknown>>,
  vocabBase: string,
  graphNode: NamedNode,
  factory:   DataFactory,
): Quad[] {
  const quads: Quad[] = [];
  const rdfType   = factory.namedNode(RDF_TYPE_IRI);
  const xsdString = factory.namedNode(XSD_STRING_IRI);

  quads.push(factory.quad(subject, rdfType, vocab(vocabBase, className, factory), graphNode));

  // Item 1: rdfs:label
  pushRdfsLabel(subject, input, graphNode, factory, quads);

  if (typeof input['name'] === 'string') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'name', factory),
      factory.literal(input['name'], xsdString),
      graphNode,
    ));
  }

  if (typeof input['rarity'] === 'string') {
    quads.push(factory.quad(
      subject,
      vocab(vocabBase, 'rarity', factory),
      vocab(vocabBase, `Rarity-${input['rarity']}`, factory),
      graphNode,
    ));
  }

  const traits = input['traits'];
  if (Array.isArray(traits)) {
    for (const trait of traits) {
      if (typeof trait === 'string') {
        quads.push(factory.quad(
          subject,
          vocab(vocabBase, 'trait', factory),
          vocab(vocabBase, `Trait-${trait}`, factory),
          graphNode,
        ));
      }
    }
  }

  // Item 6: Trait skos:broader hierarchy (trait class only)
  if (className === 'Trait') {
    const category = input['category'];
    if (typeof category === 'string' && category.length > 0) {
      quads.push(factory.quad(
        subject,
        factory.namedNode(SKOS_BROADER_IRI),
        vocab(vocabBase, `TraitCategory-${category}`, factory),
        graphNode,
      ));
    }
  }

  // Item 7: dct:source
  pushDctSource(subject, input, graphNode, factory, quads);

  return quads;
}

// ---------------------------------------------------------------------------
// Task: aonprd:squash
// ---------------------------------------------------------------------------

/** Name under which the aonprd squash task is registered. */
export const AONPRD_SQUASH_TASK_NAME = 'aonprd:squash' as const;

/**
 * Pipeline task that emits class-appropriate quads for each classified record.
 *
 * @remarks
 * Branches on `state.classification.type` to call the appropriate quad emitter.
 * All IRIs are derived from `state.context.prefixes` — no IRIs are hardcoded.
 * Records with `state.classification === null` (quarantined) emit no quads.
 *
 * @param next  - Advance function; called unconditionally.
 * @param state - Mutable pipeline state.
 */
const aonprdSquashTask = async (
  next:  NextFnInterface,
  state: PipelineStateInterface,
): Promise<void> => {
  const ctx            = state.context;
  const classification = state.classification;

  if (ctx !== undefined && classification !== null) {
    const prefixes  = ctx.prefixes;
    const factory   = ctx.factory;
    const dataset   = ctx.dataset;
    const input     = state.input;

    const vocabBase     = prefixes.vocabulary.base;
    const instanceBase  = prefixes.instances.base;
    const graphBase     = prefixes.graphs.base;

    const urlTail   = deriveUrlTail(input);
    const subject   = instance(instanceBase, urlTail, factory);
    const className = classification.type;
    const graphNode = graph(graphBase, className, factory);

    const dispatch: Record<string, () => Quad[]> = {
      feat:       () => emitFeatQuads(subject, input, vocabBase, instanceBase, graphNode, factory),
      spell:      () => emitSpellQuads(subject, input, vocabBase, graphNode, factory),
      monster:    () => emitMonsterQuads(subject, input, vocabBase, graphNode, factory),
      action:     () => emitActionQuads(subject, input, vocabBase, graphNode, factory),
      equipment:  () => emitEquipmentQuads(subject, input, vocabBase, graphNode, factory),
      weapon:     () => emitBaseQuads('Weapon',     subject, input, vocabBase, graphNode, factory),
      armor:      () => emitBaseQuads('Armor',      subject, input, vocabBase, graphNode, factory),
      shield:     () => emitBaseQuads('Shield',     subject, input, vocabBase, graphNode, factory),
      ancestry:   () => emitBaseQuads('Ancestry',   subject, input, vocabBase, graphNode, factory),
      class:      () => emitBaseQuads('Class',      subject, input, vocabBase, graphNode, factory),
      background: () => emitBaseQuads('Background', subject, input, vocabBase, graphNode, factory),
      condition:  () => emitBaseQuads('Condition',  subject, input, vocabBase, graphNode, factory),
      trait:      () => emitBaseQuads('Trait',      subject, input, vocabBase, graphNode, factory),
      hazard:     () => emitBaseQuads('Hazard',     subject, input, vocabBase, graphNode, factory),
      generic:    () => emitBaseQuads('Generic',    subject, input, vocabBase, graphNode, factory),
      unknown:    () => emitBaseQuads('Unknown',    subject, input, vocabBase, graphNode, factory),
    };

    const emitter = dispatch[className];
    if (emitter !== undefined) {
      for (const quad of emitter()) {
        dataset.add(quad);
      }
    }
  }

  await next();
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers the `aonprd:squash` task in the global {@link TaskRegistry}.
 *
 * @remarks
 * Safe to call multiple times — `TaskRegistry.register` overwrites existing
 * entries, so repeated calls are idempotent.
 */
export function registerAonprdPlugin(): void {
  TaskRegistry.register(AONPRD_SQUASH_TASK_NAME, aonprdSquashTask);
}
