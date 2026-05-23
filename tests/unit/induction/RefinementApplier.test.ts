/**
 * Unit tests for RefinementApplier — pure-function coverage of every DSL op.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RefinementApplier } from '../../../src/induction/RefinementApplier.js';
import type { RefineSpec } from '../../../src/induction/RefinementApplier.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const SCHEMA_URL = 'https://squashage.dev/schemas/refinement.schema.json';

function makeDraft(props: Record<string, unknown> = {}, required?: string[]): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id:     'https://example.org/vocab/schemas/inferred/Feat.draft.json',
    title:   'Feat',
    type:    'object',
    properties: Object.fromEntries(
      Object.entries(props).map(([k, v]) => [k, typeof v === 'object' && v !== null ? v : { type: v }]),
    ),
    ...(required !== undefined ? { required } : {}),
  };
}

function makeSpec(overrides: Partial<RefineSpec> = {}): RefineSpec {
  return {
    $schema:   SCHEMA_URL,
    appliesTo: 'Feat',
    ...overrides,
  };
}

function apply(draft: Record<string, unknown>, spec: Partial<RefineSpec> = {}) {
  return RefinementApplier.apply(draft, makeSpec(spec));
}

// ─── drop ─────────────────────────────────────────────────────────────────────

describe('RefinementApplier — drop', () => {
  it('removes a property from the schema', () => {
    const draft = makeDraft({ name: 'string', raw_html: 'string' });
    const { final, warnings } = apply(draft, { drop: ['/raw_html'] });
    const props = final['properties'] as Record<string, unknown>;
    assert.ok(!Object.prototype.hasOwnProperty.call(props, 'raw_html'));
    assert.ok(Object.prototype.hasOwnProperty.call(props, 'name'));
    assert.equal(warnings.length, 0);
  });

  it('removes a property from required when dropped', () => {
    const draft = makeDraft({ name: 'string', raw_html: 'string' }, ['name', 'raw_html']);
    const { final } = apply(draft, { drop: ['/raw_html'] });
    const req = final['required'] as string[];
    assert.ok(!req.includes('raw_html'));
    assert.ok(req.includes('name'));
  });

  it('removes required entirely when all required props are dropped', () => {
    const draft = makeDraft({ raw_html: 'string' }, ['raw_html']);
    const { final } = apply(draft, { drop: ['/raw_html'] });
    assert.equal(final['required'], undefined);
  });

  it('warns on unresolvable drop pointer', () => {
    const draft = makeDraft({ name: 'string' });
    const { warnings } = apply(draft, { drop: ['/nonexistent'] });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, 'DROP_UNRESOLVED');
    assert.equal(warnings[0]!.pointer, '/nonexistent');
  });
});

// ─── rename ───────────────────────────────────────────────────────────────────

describe('RefinementApplier — rename', () => {
  it('relocates a property to the new name', () => {
    const draft = makeDraft({ _type: 'string', name: 'string' });
    const { final, warnings } = apply(draft, { rename: { '/_type': 'kind' } });
    const props = final['properties'] as Record<string, unknown>;
    assert.ok(!Object.prototype.hasOwnProperty.call(props, '_type'), 'old key removed');
    assert.ok(Object.prototype.hasOwnProperty.call(props, 'kind'), 'new key present');
    assert.equal(warnings.length, 0);
  });

  it('updates required references on rename', () => {
    const draft = makeDraft({ _type: 'string' }, ['_type']);
    const { final } = apply(draft, { rename: { '/_type': 'kind' } });
    const req = final['required'] as string[];
    assert.ok(!req.includes('_type'));
    assert.ok(req.includes('kind'));
  });

  it('warns on unresolvable rename pointer', () => {
    const draft = makeDraft({ name: 'string' });
    const { warnings } = apply(draft, { rename: { '/missing': 'other' } });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, 'RENAME_UNRESOLVED');
  });
});

// ─── closedEnum ───────────────────────────────────────────────────────────────

describe('RefinementApplier — closedEnum', () => {
  it('sets x-squashage-closed-enum: true', () => {
    const draft = makeDraft({ rarity: { type: 'string', examples: ['common', 'rare'] } });
    const { final, warnings } = apply(draft, { closedEnum: ['rarity'] });
    const prop = (final['properties'] as Record<string, Record<string, unknown>>)['rarity']!;
    assert.equal(prop['x-squashage-closed-enum'], true);
    assert.equal(warnings.length, 0);
  });

  it('back-fills enum from examples when absent', () => {
    const draft = makeDraft({ rarity: { type: 'string', examples: ['rare', 'common', 'uncommon'] } });
    const { final } = apply(draft, { closedEnum: ['rarity'] });
    const prop = (final['properties'] as Record<string, Record<string, unknown>>)['rarity']!;
    assert.ok(Array.isArray(prop['enum']));
    const enumVals = prop['enum'] as string[];
    assert.deepEqual(enumVals, ['common', 'rare', 'uncommon']); // sorted
  });

  it('back-fills enum from x-squashage-distinct-values when examples absent', () => {
    const draft = makeDraft({ rarity: { type: 'string', 'x-squashage-distinct-values': ['b', 'a'] } });
    const { final } = apply(draft, { closedEnum: ['rarity'] });
    const prop = (final['properties'] as Record<string, Record<string, unknown>>)['rarity']!;
    assert.deepEqual(prop['enum'], ['a', 'b']); // sorted
  });

  it('leaves existing enum unchanged', () => {
    const draft = makeDraft({ rarity: { type: 'string', enum: ['common', 'rare'] } });
    const { final } = apply(draft, { closedEnum: ['rarity'] });
    const prop = (final['properties'] as Record<string, Record<string, unknown>>)['rarity']!;
    assert.deepEqual(prop['enum'], ['common', 'rare']);
  });

  it('warns when no values available for enum back-fill', () => {
    const draft = makeDraft({ rarity: { type: 'string' } });
    const { warnings } = apply(draft, { closedEnum: ['rarity'] });
    assert.ok(warnings.some((w) => w.code === 'CLOSED_ENUM_NO_VALUES'));
  });

  it('warns on unresolvable closedEnum property', () => {
    const draft = makeDraft({ name: 'string' });
    const { warnings } = apply(draft, { closedEnum: ['missing'] });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, 'CLOSED_ENUM_UNRESOLVED');
  });
});

// ─── openVocabulary ───────────────────────────────────────────────────────────

describe('RefinementApplier — openVocabulary', () => {
  it('sets x-squashage-open-vocab: true', () => {
    const draft = makeDraft({ traits: { type: 'array' } });
    const { final, warnings } = apply(draft, { openVocabulary: ['traits'] });
    const prop = (final['properties'] as Record<string, Record<string, unknown>>)['traits']!;
    assert.equal(prop['x-squashage-open-vocab'], true);
    assert.equal(warnings.length, 0);
  });

  it('removes enum when present', () => {
    const draft = makeDraft({ traits: { type: 'string', enum: ['fire', 'cold'] } });
    const { final } = apply(draft, { openVocabulary: ['traits'] });
    const prop = (final['properties'] as Record<string, Record<string, unknown>>)['traits']!;
    assert.equal(prop['enum'], undefined);
  });

  it('warns on unresolvable openVocabulary property', () => {
    const draft = makeDraft({ name: 'string' });
    const { warnings } = apply(draft, { openVocabulary: ['missing'] });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, 'OPEN_VOCAB_UNRESOLVED');
  });
});

// ─── promoteIri ───────────────────────────────────────────────────────────────

describe('RefinementApplier — promoteIri', () => {
  it('sets x-squashage-iri-promotion: true and format: iri', () => {
    const draft = makeDraft({ url: { type: 'string' } });
    const { final, warnings } = apply(draft, { promoteIri: ['/url'] });
    const prop = (final['properties'] as Record<string, Record<string, unknown>>)['url']!;
    assert.equal(prop['x-squashage-iri-promotion'], true);
    assert.equal(prop['format'], 'iri');
    assert.equal(warnings.length, 0);
  });

  it('warns on unresolvable promoteIri pointer', () => {
    const draft = makeDraft({ name: 'string' });
    const { warnings } = apply(draft, { promoteIri: ['/missing_url'] });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, 'PROMOTE_IRI_UNRESOLVED');
  });
});

// ─── range ────────────────────────────────────────────────────────────────────

describe('RefinementApplier — range', () => {
  it('sets x-squashage-range on the property', () => {
    const draft = makeDraft({ rarity: { type: 'string' } });
    const { final, warnings } = apply(draft, { range: { rarity: 'Rarity' } });
    const prop = (final['properties'] as Record<string, Record<string, unknown>>)['rarity']!;
    assert.equal(prop['x-squashage-range'], 'Rarity');
    assert.equal(warnings.length, 0);
  });

  it('warns when range target property does not exist', () => {
    const draft = makeDraft({ name: 'string' });
    const { warnings } = apply(draft, { range: { missing: 'SomeClass' } });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, 'RANGE_UNRESOLVED');
  });
});

// ─── rdfsLabel ────────────────────────────────────────────────────────────────

describe('RefinementApplier — rdfsLabel', () => {
  it('sets top-level x-squashage-rdfs-label', () => {
    const draft = makeDraft({ name: { type: 'string' } });
    const { final, warnings } = apply(draft, { rdfsLabel: 'name' });
    assert.equal(final['x-squashage-rdfs-label'], '/name');
    assert.equal(warnings.length, 0);
  });

  it('warns when rdfsLabel property does not exist', () => {
    const draft = makeDraft({ name: 'string' });
    const { warnings } = apply(draft, { rdfsLabel: 'missing_prop' });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, 'RDFS_LABEL_UNRESOLVED');
  });
});

// ─── rdfsComment ─────────────────────────────────────────────────────────────

describe('RefinementApplier — rdfsComment', () => {
  it('sets top-level x-squashage-rdfs-comment', () => {
    const draft = makeDraft({ description: { type: 'string' } });
    const { final, warnings } = apply(draft, { rdfsComment: 'description' });
    assert.equal(final['x-squashage-rdfs-comment'], '/description');
    assert.equal(warnings.length, 0);
  });

  it('warns when rdfsComment property does not exist', () => {
    const draft = makeDraft({ name: 'string' });
    const { warnings } = apply(draft, { rdfsComment: 'missing_field' });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, 'RDFS_COMMENT_UNRESOLVED');
  });
});

// ─── subjectIriPolicy ────────────────────────────────────────────────────────

describe('RefinementApplier — subjectIriPolicy', () => {
  it('sets top-level x-squashage-subject-iri', () => {
    const draft = makeDraft({ name: 'string' });
    const { final, warnings } = apply(draft, {
      subjectIriPolicy: { from: '/_source/url', sanitize: 'url-tail' },
    });
    const policy = final['x-squashage-subject-iri'] as Record<string, unknown>;
    assert.equal(policy['from'], '/_source/url');
    assert.equal(policy['sanitize'], 'url-tail');
    assert.equal(warnings.length, 0);
  });

  it('stores fallback when provided', () => {
    const draft = makeDraft({ name: 'string' });
    const { final } = apply(draft, {
      subjectIriPolicy: { from: '/_source/url', sanitize: 'slug', fallback: '/name' },
    });
    const policy = final['x-squashage-subject-iri'] as Record<string, unknown>;
    assert.equal(policy['fallback'], '/name');
  });
});

// ─── operation ordering ───────────────────────────────────────────────────────

describe('RefinementApplier — operation ordering', () => {
  it('drop runs before rename (drop wins on the same property)', () => {
    // Both drop and rename reference /raw — drop should win (property gone).
    const draft = makeDraft({ raw: 'string' });
    const { final } = apply(draft, {
      drop:   ['/raw'],
      rename: { '/raw': 'cooked' },
    });
    const props = final['properties'] as Record<string, unknown>;
    assert.ok(!Object.prototype.hasOwnProperty.call(props, 'raw'),   'raw removed');
    assert.ok(!Object.prototype.hasOwnProperty.call(props, 'cooked'), 'cooked not created');
  });

  it('rename runs after drop (rename works on surviving property)', () => {
    const draft = makeDraft({ _type: 'string', remove_me: 'string' });
    const { final } = apply(draft, {
      drop:   ['/remove_me'],
      rename: { '/_type': 'kind' },
    });
    const props = final['properties'] as Record<string, unknown>;
    assert.ok(!Object.prototype.hasOwnProperty.call(props, 'remove_me'));
    assert.ok(!Object.prototype.hasOwnProperty.call(props, '_type'));
    assert.ok(Object.prototype.hasOwnProperty.call(props, 'kind'));
  });
});

// ─── determinism ─────────────────────────────────────────────────────────────

describe('RefinementApplier — determinism', () => {
  it('same draft + refine twice → byte-identical JSON output', () => {
    const draft = makeDraft({
      name:        { type: 'string' },
      _type:       { type: 'string' },
      rarity:      { type: 'string', examples: ['common', 'rare'] },
      description: { type: 'string' },
      raw_html:    { type: 'string' },
    }, ['name', '_type']);

    const spec = makeSpec({
      drop:          ['/raw_html'],
      rename:        { '/_type': 'kind' },
      closedEnum:    ['rarity'],
      rdfsLabel:     'name',
      rdfsComment:   'description',
    });

    const { final: a } = RefinementApplier.apply(draft, spec);
    const { final: b } = RefinementApplier.apply(draft, spec);

    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});

// ─── orphan rule warnings ────────────────────────────────────────────────────

describe('RefinementApplier — orphan rule warnings', () => {
  it('accumulates all warnings from multiple orphan rules', () => {
    const draft = makeDraft({ name: 'string' });
    const { warnings } = apply(draft, {
      drop:          ['/a'],
      rename:        { '/b': 'x' },
      closedEnum:    ['c'],
      openVocabulary: ['d'],
      promoteIri:    ['/e'],
      range:         { f: 'X' },
      rdfsLabel:     'g',
      rdfsComment:   'h',
    });
    // Each of the 8 orphan rules should produce exactly 1 warning.
    assert.equal(warnings.length, 8);
  });

  it('continues applying other valid rules after a warning', () => {
    const draft = makeDraft({ name: 'string', _type: 'string' });
    const { final, warnings } = apply(draft, {
      drop:   ['/nonexistent'],      // warns
      rename: { '/_type': 'kind' }, // valid — should still execute
    });
    assert.equal(warnings.length, 1);
    const props = final['properties'] as Record<string, unknown>;
    assert.ok(Object.prototype.hasOwnProperty.call(props, 'kind'), 'rename applied despite earlier warning');
    assert.ok(!Object.prototype.hasOwnProperty.call(props, '_type'));
  });
});

// ─── no mutation of input ─────────────────────────────────────────────────────

describe('RefinementApplier — input immutability', () => {
  it('does not mutate the input draft object', () => {
    const draft = makeDraft({ _type: 'string' }, ['_type']);
    const originalTitle  = draft['title'];
    const originalKeys   = Object.keys((draft['properties'] as object));

    apply(draft, { rename: { '/_type': 'kind' } });

    assert.equal(draft['title'], originalTitle);
    assert.deepEqual(Object.keys((draft['properties'] as object)), originalKeys);
  });
});

// ─── arrayEnumIri ─────────────────────────────────────────────────────────────

describe('RefinementApplier — arrayEnumIri', () => {
  it('sets x-squashage-array-enum-iri at top level', () => {
    const draft = makeDraft({ traits: { type: 'array', items: { type: 'string' } } });
    const { final, warnings } = apply(draft, { arrayEnumIri: { traits: 'Trait' } });
    const hint = final['x-squashage-array-enum-iri'] as Record<string, unknown>;
    assert.equal(hint['traits'], 'Trait');
    assert.equal(warnings.length, 0);
  });

  it('warns on orphan property key and excludes it from hint', () => {
    const draft = makeDraft({ traits: { type: 'array' } });
    const { final, warnings } = apply(draft, { arrayEnumIri: { traits: 'Trait', missing: 'X' } });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, 'ARRAY_ENUM_IRI_UNRESOLVED');
    const hint = final['x-squashage-array-enum-iri'] as Record<string, unknown>;
    // missing excluded; traits included
    assert.equal(hint['traits'], 'Trait');
    assert.ok(!Object.prototype.hasOwnProperty.call(hint, 'missing'));
  });

  it('does not set hint when all keys are orphans', () => {
    const draft = makeDraft({ name: 'string' });
    const { final, warnings } = apply(draft, { arrayEnumIri: { nonexistent: 'X' } });
    assert.equal(warnings.length, 1);
    assert.equal(final['x-squashage-array-enum-iri'], undefined);
  });
});

// ─── skolemSubject ────────────────────────────────────────────────────────────

describe('RefinementApplier — skolemSubject', () => {
  it('sets x-squashage-skolem-subject at top level', () => {
    const draft = makeDraft({ action_cost: { type: 'string' } });
    const { final, warnings } = apply(draft, {
      skolemSubject: {
        action_cost: { fragment: 'actionCost', type: 'ActionCost', properties: { actionSymbol: 'xsd:string' } },
      },
    });
    const hint = final['x-squashage-skolem-subject'] as Record<string, unknown>;
    assert.ok(Object.prototype.hasOwnProperty.call(hint, 'action_cost'));
    assert.equal(warnings.length, 0);
  });

  it('warns on orphan property key', () => {
    const draft = makeDraft({ name: 'string' });
    const { warnings } = apply(draft, {
      skolemSubject: { action_cost: { fragment: 'actionCost', type: 'ActionCost' } },
    });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, 'SKOLEM_SUBJECT_UNRESOLVED');
  });
});

// ─── provenanceIri ────────────────────────────────────────────────────────────

describe('RefinementApplier — provenanceIri', () => {
  it('sets x-squashage-provenance at top level', () => {
    const draft = makeDraft({ name: 'string' });
    const { final, warnings } = apply(draft, {
      provenanceIri: { predicate: 'dct:source', from: '/url' },
    });
    const hint = final['x-squashage-provenance'] as Record<string, unknown>;
    assert.equal(hint['predicate'], 'dct:source');
    assert.equal(hint['from'], '/url');
    assert.equal(warnings.length, 0);
  });

  it('accepts nested pointer in from field', () => {
    const draft = makeDraft({ name: 'string' });
    const { final } = apply(draft, {
      provenanceIri: { predicate: 'dct:source', from: '/_source/url' },
    });
    const hint = final['x-squashage-provenance'] as Record<string, unknown>;
    assert.equal(hint['from'], '/_source/url');
  });
});

// ─── predicateOverride ────────────────────────────────────────────────────────

describe('RefinementApplier — predicateOverride', () => {
  it('sets x-squashage-predicate-override at top level', () => {
    const draft = makeDraft({ category: { type: 'string' } });
    const { final, warnings } = apply(draft, { predicateOverride: { category: 'skos:broader' } });
    const hint = final['x-squashage-predicate-override'] as Record<string, unknown>;
    assert.equal(hint['category'], 'skos:broader');
    assert.equal(warnings.length, 0);
  });

  it('warns on orphan property key and excludes it', () => {
    const draft = makeDraft({ name: 'string' });
    const { final, warnings } = apply(draft, { predicateOverride: { missing: 'skos:broader' } });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, 'PREDICATE_OVERRIDE_UNRESOLVED');
    assert.equal(final['x-squashage-predicate-override'], undefined);
  });
});

// ─── inverseOf ────────────────────────────────────────────────────────────────

describe('RefinementApplier — inverseOf', () => {
  it('sets x-squashage-inverse-of at top level', () => {
    const draft = makeDraft({ name: 'string' });
    const { final, warnings } = apply(draft, { inverseOf: { hasPrerequisite: 'isPrerequisiteFor' } });
    const hint = final['x-squashage-inverse-of'] as Record<string, unknown>;
    assert.equal(hint['hasPrerequisite'], 'isPrerequisiteFor');
    assert.equal(warnings.length, 0);
  });

  it('stores inverse mapping without property-existence check (purely declarative)', () => {
    // inverseOf does not validate property existence in the draft — it operates on runtime quads
    const draft = makeDraft({ name: 'string' });
    const { final, warnings } = apply(draft, { inverseOf: { anyProp: 'inverseOfAnyProp' } });
    const hint = final['x-squashage-inverse-of'] as Record<string, unknown>;
    assert.equal(hint['anyProp'], 'inverseOfAnyProp');
    assert.equal(warnings.length, 0);
  });
});

// ─── orphan accumulation with new ops ────────────────────────────────────────

describe('RefinementApplier — orphan accumulation with Phase 10 ops', () => {
  it('accumulates warnings from arrayEnumIri, skolemSubject, and predicateOverride orphans', () => {
    const draft = makeDraft({ name: 'string' });
    const { warnings } = apply(draft, {
      arrayEnumIri:      { missing_array: 'X' },
      skolemSubject:     { missing_field: { fragment: 'f', type: 'T' } },
      predicateOverride: { missing_pred: 'dct:source' },
    });
    assert.equal(warnings.length, 3);
    const codes = warnings.map((w) => w.code).sort();
    assert.deepEqual(codes, [
      'ARRAY_ENUM_IRI_UNRESOLVED',
      'PREDICATE_OVERRIDE_UNRESOLVED',
      'SKOLEM_SUBJECT_UNRESOLVED',
    ]);
  });
});
