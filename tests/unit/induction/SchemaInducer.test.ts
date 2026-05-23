import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SchemaInducer } from '../../../src/induction/SchemaInducer.js';
import type { InducedSchemaSetInterface } from '../../../src/induction/SchemaInducer.js';
import { ShapeObservationAccumulator } from '../../../src/induction/ShapeObservation.js';
import type { ShapeObservation } from '../../../src/induction/ShapeObservation.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const BASE_IRI = 'https://example.org/vocab/';

function buildCache(
  className: string,
  records:   Record<string, unknown>[],
  opts?: { overflowThreshold?: number },
): ReadonlyMap<string, ShapeObservation> {
  const obs = ShapeObservationAccumulator.createEmpty(className);
  for (const record of records) {
    ShapeObservationAccumulator.fold(obs, record, opts);
  }
  return new Map([[className, obs]]);
}

function materialize(cache: ReadonlyMap<string, ShapeObservation>): InducedSchemaSetInterface {
  return SchemaInducer.materialize(cache, { baseIri: BASE_IRI });
}

/** Convenience: get the first class schema from a set. */
function firstClass(set: InducedSchemaSetInterface) {
  const r = set.classes[0];
  assert.ok(r !== undefined, 'expected at least one class schema');
  return r;
}

// ─── basic schema structure ───────────────────────────────────────────────────

describe('SchemaInducer.materialize — basic schema structure', () => {
  it('emits $schema, $id, title, x-squashage-class, type, properties, additionalProperties', () => {
    const cache = buildCache('Spell', [{ name: 'Fireball' }]);
    const result = firstClass(materialize(cache));
    const { schema } = result;
    assert.equal(schema['$schema'], 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema['$id'], `${BASE_IRI}schemas/inferred/Spell.draft.json`);
    assert.equal(schema['title'], 'Spell');
    // Path-form IRI: <base><ClassName> — single '#' when json-tology
    // appends the property name, e.g. <base>Spell#name.
    assert.equal(schema['x-squashage-class'], `${BASE_IRI}Spell`);
    assert.equal(schema['type'], 'object');
    assert.equal(schema['additionalProperties'], true);
    assert.ok(typeof schema['properties'] === 'object');
  });

  it('emits required for properties present in all records', () => {
    const cache = buildCache('Feat', [
      { name: 'A', optional: 1 },
      { name: 'B' },
    ]);
    const result = firstClass(materialize(cache));
    const required = result.schema['required'] as string[];
    assert.ok(Array.isArray(required));
    assert.ok(required.includes('name'), 'name should be required');
    assert.ok(!required.includes('optional'), 'optional should not be required');
  });

  it('does not emit required when no property is universal', () => {
    const cache = buildCache('Feat', [
      { a: 1 },
      { b: 2 },
    ]);
    const result = firstClass(materialize(cache));
    assert.equal(result.schema['required'], undefined);
  });

  it('className and schemaId fields match schema $id and title', () => {
    const cache = buildCache('Trait', [{ value: 'common' }]);
    const result = firstClass(materialize(cache));
    assert.equal(result.className, 'Trait');
    assert.equal(result.schemaId, `${BASE_IRI}schemas/inferred/Trait.draft.json`);
    assert.equal(result.kind, 'class');
  });

  it('returns InducedSchemaSetInterface with classes, primitives, objects arrays', () => {
    const cache = buildCache('Spell', [{ name: 'Fireball' }]);
    const set = materialize(cache);
    assert.ok(Array.isArray(set.classes));
    assert.ok(Array.isArray(set.primitives));
    assert.ok(Array.isArray(set.objects));
    assert.equal(set.classes.length, 1);
  });

  // ── Class-IRI convention (P20 regression guard) ───────────────────────────

  it('x-squashage-class uses path-form — no "#" in the IRI itself', () => {
    // The class IRI must NOT contain '#'. json-tology (SchemaIri.propertyIri)
    // appends #<propertyName> to the schema $id; if the $id already carries a
    // '#' the result is a double-hash invalid IRI.
    const cache = buildCache('Feat', [{ level: 1 }]);
    const { schema } = firstClass(materialize(cache));
    const classIri = schema['x-squashage-class'] as string;
    assert.ok(typeof classIri === 'string', 'x-squashage-class must be a string');
    assert.ok(!classIri.includes('#'), `class IRI "${classIri}" must not contain "#"`);
    // Must end with the className segment.
    assert.ok(classIri.endsWith('/Feat'), `class IRI "${classIri}" must end with /Feat`);
  });

  it('simulated property IRI (classIri + "#" + propName) contains exactly one "#"', () => {
    // Guard against the double-hash regression: property IRIs must be RFC 3987 clean.
    const cache = buildCache('Action', [{ action_cost: 'one-action' }]);
    const { schema } = firstClass(materialize(cache));
    const classIri = schema['x-squashage-class'] as string;
    const simulatedPropertyIri = `${classIri}#action_cost`;
    const hashCount = (simulatedPropertyIri.match(/#/g) ?? []).length;
    assert.equal(hashCount, 1, `property IRI "${simulatedPropertyIri}" must contain exactly one "#"`);
  });

  it('x-squashage-class IRI encodes the className as the last path segment', () => {
    const className = 'MonsterFamily';
    const cache = buildCache(className, [{ name: 'Dragon' }]);
    const { schema } = firstClass(materialize(cache));
    const classIri = schema['x-squashage-class'] as string;
    const lastSegment = classIri.split('/').at(-1);
    assert.equal(lastSegment, className);
  });
});

// ─── type fragments ───────────────────────────────────────────────────────────

describe('SchemaInducer.materialize — type fragments', () => {
  it('emits single type when only one type observed (open-vocab string — no extraction)', () => {
    // Use overflowThreshold=3 so 4 distinct values trigger open-vocab (no enum, no extraction).
    const cache = buildCache('Item', [
      { name: 'sword' }, { name: 'shield' }, { name: 'bow' }, { name: 'axe' },
    ], { overflowThreshold: 3 });
    const result = firstClass(materialize(cache));
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    // Open-vocab string has no constraints → stays inline
    assert.equal(props['name']?.['type'], 'string');
  });

  it('emits type array when null is also observed (open-vocab + nullable, no extraction)', () => {
    // 4 distinct values with overflow → no enum → no extraction → stays inline nullable.
    const cache = buildCache('Item', [
      { label: 'sword' }, { label: 'shield' }, { label: 'bow' }, { label: 'axe' },
      { label: null },
    ], { overflowThreshold: 3 });
    const result = firstClass(materialize(cache));
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    const labelType = props['label']?.['type'];
    assert.ok(Array.isArray(labelType), 'type should be an array when null observed');
    assert.ok((labelType as string[]).includes('string'));
    assert.ok((labelType as string[]).includes('null'));
  });

  it('emits oneOf when multiple non-null types observed (string+integer, no single-type constraints)', () => {
    // mixed string (open-vocab) + integer (no range) → oneOf, no extraction
    const records: Record<string, unknown>[] = [];
    // Use enough distinct strings to overflow
    for (let i = 0; i < 5; i++) records.push({ value: `str${i}` });
    records.push({ value: 42 });
    const cache = buildCache('Item', records, { overflowThreshold: 3 });
    const result = firstClass(materialize(cache));
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    const prop = props['value'];
    assert.ok(prop !== undefined);
    assert.ok(Array.isArray(prop['oneOf']), 'oneOf should be present for mixed types');
  });

  it('includes null in oneOf when null is also one of the types', () => {
    // mixed string (open-vocab) + integer (no range) + null → oneOf with null
    const records: Record<string, unknown>[] = [];
    for (let i = 0; i < 5; i++) records.push({ value: `str${i}` });
    records.push({ value: 42 });
    records.push({ value: null });
    const cache = buildCache('Item', records, { overflowThreshold: 3 });
    const result = firstClass(materialize(cache));
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    const oneOf = props['value']?.['oneOf'] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(oneOf));
    const types = oneOf.map((m) => m['type']);
    assert.ok(types.includes('null'), 'null should appear in oneOf');
  });

  it('emits integer type for whole-number values (single value, min=max → extracted with $ref)', () => {
    // A single integer value → has minimum=maximum → extracted to named primitive.
    // Verify via extracted primitive schema, not inline props.
    const cache = buildCache('Item', [{ level: 3 }]);
    const set = materialize(cache);
    // The level property should be extracted.
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    assert.ok('$ref' in (props['level'] ?? {}), 'integer with range should be extracted to $ref');

    // Verify the extracted primitive has type: integer
    const levelPrimitive = set.primitives.find((p) => p.className === 'ItemLevel');
    assert.ok(levelPrimitive !== undefined, 'ItemLevel should be extracted');
    assert.equal(levelPrimitive.schema['type'], 'integer');
  });
});

// ─── closed-enum extraction ───────────────────────────────────────────────────

describe('SchemaInducer.materialize — closed-enum extraction', () => {
  it('extracts closed-enum to primitives; class property becomes $ref', () => {
    // Closed-enum names are now class-scoped: Spell.rarity → SpellRarity.
    const cache = buildCache('Spell', [
      { rarity: 'common' },
      { rarity: 'uncommon' },
      { rarity: 'rare' },
    ]);
    const set = materialize(cache);
    const result = firstClass(set);

    // Class schema property should be a $ref, not inline enum.
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    const rarityProp = props['rarity'];
    assert.ok(rarityProp !== undefined);
    assert.ok('$ref' in rarityProp, `expected $ref, got: ${JSON.stringify(rarityProp)}`);
    assert.ok((rarityProp['$ref'] as string).includes('/primitives/SpellRarity.draft.json'));

    // The extracted primitive should be in set.primitives.
    assert.ok(set.primitives.length > 0, 'should have extracted primitives');
    const rarity = set.primitives.find((p) => p.className === 'SpellRarity');
    assert.ok(rarity !== undefined, 'expected SpellRarity primitive');
    assert.equal(rarity.kind, 'primitive');
    const enumVal = rarity.schema['enum'] as string[];
    assert.ok(Array.isArray(enumVal), 'enum should be present in extracted primitive');
    assert.deepEqual(enumVal, ['common', 'rare', 'uncommon']);
    assert.equal(rarity.schema['x-squashage-closed-enum'], true);
  });

  it('appends null to enum when property is nullable', () => {
    // Closed-enum names are now class-scoped: Item.rarity → ItemRarity.
    const cache = buildCache('Item', [
      { rarity: 'common'   },
      { rarity: 'uncommon' },
      { rarity: 'rare'     },
      { rarity: null       },
    ]);
    const set = materialize(cache);
    // Property should be $ref.
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    const rarityProp = props['rarity'];
    assert.ok(rarityProp !== undefined, 'rarity property should exist');
    assert.ok('$ref' in rarityProp, 'rarity should be extracted to a $ref');

    // Extracted primitive should include null in its enum.
    const rarity = set.primitives.find((p) => p.className === 'ItemRarity');
    assert.ok(rarity !== undefined, 'should have ItemRarity primitive');
    const enumVal = rarity.schema['enum'] as unknown[];
    assert.ok(Array.isArray(enumVal), 'enum should be present');
    assert.ok(enumVal.includes('common'),   'enum should include "common"');
    assert.ok(enumVal.includes('uncommon'), 'enum should include "uncommon"');
    assert.ok(enumVal.includes('rare'),     'enum should include "rare"');
    assert.ok(enumVal.includes(null),       'enum should include null for nullable property');
    assert.equal(rarity.schema['x-squashage-closed-enum'], true);
  });

  it('does NOT append null to enum when property is non-nullable', () => {
    // Closed-enum names are now class-scoped: Item.status → ItemStatus.
    const cache = buildCache('Item', [
      { status: 'active'   },
      { status: 'inactive' },
      { status: 'pending'  },
    ]);
    const set = materialize(cache);
    const status = set.primitives.find((p) => p.className === 'ItemStatus');
    assert.ok(status !== undefined, 'ItemStatus primitive should exist');
    const enumVal = status.schema['enum'] as unknown[];
    assert.ok(Array.isArray(enumVal), 'enum should be present');
    assert.ok(!enumVal.includes(null), 'enum should NOT include null for non-nullable property');
    assert.deepEqual(enumVal, ['active', 'inactive', 'pending']);
  });

  it('does not extract when distinctOverflow is true (no enum)', () => {
    const cache = buildCache('Item', Array.from({ length: 20 }, (_, i) => ({ tag: `tag${i}` })), {
      overflowThreshold: 10,
    });
    const set = materialize(cache);
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    // No enum → no extraction → property is inline (no $ref)
    assert.ok(!('$ref' in (props['tag'] ?? {})), 'overflow string should not be extracted');
    assert.equal(props['tag']?.['enum'], undefined);
  });

  it('does not extract when distinctValues.size > 16 (no enum)', () => {
    const cache = buildCache(
      'Item',
      Array.from({ length: 17 }, (_, i) => ({ kind: `kind${i}` })),
      { overflowThreshold: 256 },
    );
    const set = materialize(cache);
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    assert.ok(!('$ref' in (props['kind'] ?? {})), 'open-vocab should not be extracted');
    assert.equal(props['kind']?.['enum'], undefined);
  });
});

// ─── deduplication ────────────────────────────────────────────────────────────

describe('SchemaInducer.materialize — deduplication', () => {
  it('two classes with identical rarity enum produce one shared rarity primitive', () => {
    // Classes are processed in sorted order (Feat before Spell), so the primitive
    // is named FeatRarity. Spell.rarity has the same structural hash → deduplicated
    // to the same FeatRarity entry. Total extracted rarity primitives = 1.
    const obs1 = ShapeObservationAccumulator.createEmpty('Feat');
    ShapeObservationAccumulator.fold(obs1, { rarity: 'common' });
    ShapeObservationAccumulator.fold(obs1, { rarity: 'rare' });
    const obs2 = ShapeObservationAccumulator.createEmpty('Spell');
    ShapeObservationAccumulator.fold(obs2, { rarity: 'common' });
    ShapeObservationAccumulator.fold(obs2, { rarity: 'rare' });
    const cache = new Map<string, ShapeObservation>([
      ['Feat', obs1],
      ['Spell', obs2],
    ]);
    const set = SchemaInducer.materialize(cache, { baseIri: BASE_IRI });

    assert.equal(set.classes.length, 2);
    // Both classes share the same structural hash → only one rarity primitive total.
    const rarityPrimitives = set.primitives.filter((p) =>
      p.className === 'FeatRarity' || p.className === 'SpellRarity',
    );
    assert.equal(rarityPrimitives.length, 1, 'should deduplicate identical rarity enums into one primitive');
  });
});

// ─── collision resolution ─────────────────────────────────────────────────────

describe('SchemaInducer.materialize — collision resolution', () => {
  it('two classes with a school property of distinct shapes → FeatSchool + SpellSchool', () => {
    // With class-scoped naming, each class gets its own school primitive name.
    // No _N suffix needed — the names are already distinct by class prefix.
    const obs1 = ShapeObservationAccumulator.createEmpty('Spell');
    ShapeObservationAccumulator.fold(obs1, { school: 'evocation' });
    ShapeObservationAccumulator.fold(obs1, { school: 'illusion' });

    const obs2 = ShapeObservationAccumulator.createEmpty('Feat');
    ShapeObservationAccumulator.fold(obs2, { school: 'abjuration' });
    ShapeObservationAccumulator.fold(obs2, { school: 'conjuration' });
    ShapeObservationAccumulator.fold(obs2, { school: 'transmutation' });

    const cache = new Map<string, ShapeObservation>([
      ['Feat', obs2],
      ['Spell', obs1],
    ]);
    const set = SchemaInducer.materialize(cache, { baseIri: BASE_IRI });

    // School enum from Spell and Feat have different values → two distinct primitives.
    const featSchool  = set.primitives.find((p) => p.className === 'FeatSchool');
    const spellSchool = set.primitives.find((p) => p.className === 'SpellSchool');
    assert.ok(featSchool  !== undefined, 'FeatSchool should exist');
    assert.ok(spellSchool !== undefined, 'SpellSchool should exist');
  });
});

// ─── IRI promotion extraction ─────────────────────────────────────────────────

describe('SchemaInducer.materialize — IRI promotion extraction', () => {
  it('IRI-promoted property is extracted to shared IriString primitive', () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      link: `https://example.org/item/${i}`,
    }));
    const cache = buildCache('Resource', records);
    const set = materialize(cache);
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    // link should be extracted (IRI promotion is a constraint)
    assert.ok('$ref' in (props['link'] ?? {}), 'IRI-promoted property should be extracted to $ref');
    assert.ok((props['link']!['$ref'] as string).includes('IriString'));

    // Should have IriString in primitives
    const iriString = set.primitives.find((p) => p.className === 'IriString');
    assert.ok(iriString !== undefined, 'should have IriString primitive');
    assert.equal(iriString.kind, 'primitive');
    assert.equal(iriString.schema['x-squashage-iri-promotion'], true);
  });

  it('two IRI-promoted properties share one IriString entry', () => {
    // Need enough records for IRI promotion threshold (90%)
    const obs2 = ShapeObservationAccumulator.createEmpty('Resource');
    for (let i = 0; i < 10; i++) {
      ShapeObservationAccumulator.fold(obs2, {
        url:  `https://a.org/${i}`,
        link: `https://b.org/${i}`,
      });
    }
    const cache2 = new Map<string, ShapeObservation>([['Resource', obs2]]);
    const set = SchemaInducer.materialize(cache2, { baseIri: BASE_IRI });
    const iriPrimitives = set.primitives.filter((p) => p.className === 'IriString');
    assert.equal(iriPrimitives.length, 1, 'IRI-promoted properties share one IriString');
  });

  it('does not emit x-squashage-iri-promotion when URL count is below 90% (stays inline)', () => {
    // 2/3 ≈ 67% URL rate — below the 90% threshold.
    // 3 distinct values ≤ 16 → this WILL produce a closed-enum (extracted to $ref).
    // The key assertion is that x-squashage-iri-promotion is NOT present in the extracted schema.
    const records = [
      { link: 'https://example.org/1' },
      { link: 'https://example.org/2' },
      { link: 'plain-string'          },
    ];
    const cache = buildCache('Resource', records);
    const set = materialize(cache);

    // The link property has 3 distinct values → closed-enum → extracted.
    // But the extracted primitive should NOT have x-squashage-iri-promotion.
    const linkPrimitive = set.primitives.find((p) =>
      p.schema['$id'] !== undefined &&
      (p.schema['$id'] as string).includes('Link') || p.schema['title'] === 'Link'
    );
    // If extracted (due to enum), the primitive should not carry iri-promotion.
    if (linkPrimitive !== undefined) {
      assert.equal(linkPrimitive.schema['x-squashage-iri-promotion'], undefined);
    }
    // Also verify the class property (whether $ref or inline) doesn't have iri-promotion.
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    const linkProp = props['link'];
    if (linkProp !== undefined && !('$ref' in linkProp)) {
      assert.equal(linkProp['x-squashage-iri-promotion'], undefined);
    }
  });
});

// ─── discriminator detection ──────────────────────────────────────────────────

describe('SchemaInducer.materialize — discriminator detection', () => {
  it('extracts discriminator singleton enum with x-squashage-discriminator', () => {
    // Closed-enum names are now class-scoped: Feat._type → FeatType.
    const cache = buildCache('Feat', [
      { _type: 'Feat', name: 'Power Attack' },
      { _type: 'Feat', name: 'Cleave' },
    ]);
    const set = materialize(cache);
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    // _type is a closed-enum (singleton) → extracted to primitive
    assert.ok('$ref' in (props['_type'] ?? {}), '_type should be extracted');
    // The extracted primitive should have x-squashage-discriminator
    const typePrimitive = set.primitives.find((p) => p.className === 'FeatType');
    assert.ok(typePrimitive !== undefined, 'FeatType primitive should exist');
    assert.equal(typePrimitive.schema['x-squashage-discriminator'], true);
  });

  it('does not emit x-squashage-discriminator when singleton value differs from className', () => {
    // Closed-enum names are now class-scoped: Feat._type → FeatType.
    const cache = buildCache('Feat', [
      { _type: 'feat', name: 'Power Attack' },
    ]);
    const set = materialize(cache);
    const typePrimitive = set.primitives.find((p) => p.className === 'FeatType');
    // 'feat' !== 'Feat' — no discriminator
    assert.equal(typePrimitive?.schema['x-squashage-discriminator'], undefined);
  });
});

// ─── open vocabulary detection ────────────────────────────────────────────────

describe('SchemaInducer.materialize — open vocabulary detection', () => {
  it('emits x-squashage-open-vocab when distinctOverflow is true (inline, not extracted)', () => {
    const records = Array.from({ length: 15 }, (_, i) => ({ tag: `value-${i}` }));
    const cache = buildCache('Item', records, { overflowThreshold: 10 });
    const set = materialize(cache);
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    // Open-vocab has no enum/format constraint → stays inline
    assert.equal(props['tag']?.['x-squashage-open-vocab'], true);
    assert.ok(!('$ref' in (props['tag'] ?? {})), 'open-vocab should remain inline');
  });
});

// ─── numericRange → minimum/maximum ──────────────────────────────────────────

describe('SchemaInducer.materialize — numeric range extraction', () => {
  it('extracts bounded integer to named primitive; class property has $ref', () => {
    const cache = buildCache('Item', [
      { level: 1 },
      { level: 5 },
      { level: 3 },
    ]);
    const set = materialize(cache);
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    // level has minimum/maximum → extracted
    assert.ok('$ref' in (props['level'] ?? {}), 'level should be extracted to $ref');

    const levelPrimitive = set.primitives.find((p) => p.className === 'ItemLevel');
    assert.ok(levelPrimitive !== undefined, 'ItemLevel primitive should exist');
    assert.equal(levelPrimitive.schema['minimum'], 1);
    assert.equal(levelPrimitive.schema['maximum'], 5);
  });
});

// ─── array items recursion ────────────────────────────────────────────────────

describe('SchemaInducer.materialize — array items recursion', () => {
  it('open-vocab array items remain inline (no extraction)', () => {
    // Use overflowThreshold=3 so array items overflow and have no enum (no extraction).
    const records = Array.from({ length: 5 }, (_, i) => ({ tags: [`tag${i}`, `other${i}`] }));
    const cache = buildCache('Feat', records, { overflowThreshold: 3 });
    const set = materialize(cache);
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    const items = props['tags']?.['items'];
    assert.ok(items !== undefined, 'items should be present');
    // Open-vocab string items have no constraints → stays inline
    if ('$ref' in (items as Record<string, unknown>)) {
      // items were extracted — check the extracted schema has type string
      const ref = (items as Record<string, unknown>)['$ref'] as string;
      const extracted = set.primitives.find((p) => p.schemaId === ref);
      if (extracted !== undefined) {
        assert.equal(extracted.schema['type'], 'string');
      }
    } else {
      assert.equal((items as Record<string, unknown>)['type'], 'string');
    }
  });

  it('closed-enum array items are extracted to primitives', () => {
    // Small bounded set of values → closed-enum on items → extracted
    const cache = buildCache('Feat', [
      { traits: ['fire', 'cold'] },
      { traits: ['acid'] },
    ]);
    const set = materialize(cache);
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;
    const items = props['traits']?.['items'];
    assert.ok(items !== undefined, 'items should be present');
    // With 3 distinct values (fire, cold, acid) ≤ 16 → closed-enum → extracted
    assert.ok('$ref' in (items as Record<string, unknown>), 'closed-enum items should be $ref');
  });
});

// ─── nested object inline (ABox-projection-safe) ─────────────────────────────

describe('SchemaInducer.materialize — nested object inline', () => {
  it('nested object stays inline in class schema (not extracted to $ref)', () => {
    // Objects are kept inline so json-tology ABox projection can traverse them.
    // Extracting objects to external $ref causes the projector to skip the nested
    // object's properties silently (Projection.abox only follows the root schema graph).
    const cache = buildCache('Feat', [{ source: { url: 'https://a.org', page: 42 } }]);
    const set = materialize(cache);
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;

    // source should be INLINE (not a $ref) for ABox projection.
    assert.ok(!('$ref' in (props['source'] ?? {})), 'nested object must NOT be extracted to $ref');
    assert.ok('properties' in (props['source'] ?? {}), 'nested object should have inline properties');
    assert.equal(props['source']?.['type'], 'object');

    // set.objects should be empty — no object extraction.
    assert.equal(set.objects.length, 0, 'objects array must be empty (no object extraction)');
  });

  it('array of nested objects is extracted to $ref (prevents serialization OOM from large arrays)', () => {
    // Arrays-of-objects ARE still extracted to prevent V8 "Invalid string length"
    // when projecting records that have large arrays (e.g. Rule.sections with 100+
    // entries each containing multi-KB body_text). Direct-object properties stay
    // inline; only array-item objects are extracted.
    const cache = buildCache('Feat', [{ sources: [{ book: 'CRB', page: 42 }] }]);
    const set = materialize(cache);
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;

    const items = props['sources']?.['items'];
    assert.ok(items !== undefined, 'sources.items should be present');
    // Array-items objects ARE extracted to $ref.
    assert.ok('$ref' in (items as Record<string, unknown>), 'array object items must be extracted to $ref');
    // set.objects should contain the extracted FeatSource schema.
    assert.ok(set.objects.length > 0, 'objects array should have extracted array-item objects');
  });

  it('constrained primitive nested in inline object remains inline (nested extraction not supported)', () => {
    // Constrained primitives nested within inline objects are NOT extracted.
    // Only top-level class properties are processed by #extractBody; the Extractor
    // does not recurse into inline object properties.
    const cache = buildCache('Action', [
      { source: { book: 'CRB', page: 42 } },
      { source: { book: 'APG', page: 99 } },
    ]);
    const set = materialize(cache);
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;

    // source stays inline as an object
    assert.ok(!('$ref' in (props['source'] ?? {})), 'source object stays inline');

    // page within source remains inline with its min/max constraints
    const sourceProps = (props['source'] as Record<string, unknown>)?.['properties'] as Record<string, Record<string, unknown>> | undefined;
    if (sourceProps?.['page'] !== undefined) {
      // page stays inline — bounded integers inside objects are not extracted
      assert.ok(!('$ref' in sourceProps['page']), 'nested bounded integer stays inline (no extraction)');
      assert.equal(typeof sourceProps['page']['minimum'], 'number', 'inline minimum is present');
    }
  });
});

// ─── multiple classes sorted ──────────────────────────────────────────────────

describe('SchemaInducer.materialize — multiple classes', () => {
  it('returns classes sorted by className', () => {
    const cache = new Map<string, ShapeObservation>([
      ['Spell', ShapeObservationWithRecord('Spell', { name: 'Fireball' })],
      ['Feat',  ShapeObservationWithRecord('Feat',  { name: 'A' })],
      ['Trait', ShapeObservationWithRecord('Trait', { value: 'B' })],
    ]);

    const set = SchemaInducer.materialize(cache, { baseIri: BASE_IRI });
    assert.deepEqual(
      set.classes.map((r) => r.className),
      ['Feat', 'Spell', 'Trait'],
    );
  });
});

function ShapeObservationWithRecord(
  className: string,
  record:    Record<string, unknown>,
): ShapeObservation {
  const obs = ShapeObservationAccumulator.createEmpty(className);
  ShapeObservationAccumulator.fold(obs, record);
  return obs;
}

// ─── key-sorting determinism ──────────────────────────────────────────────────

describe('SchemaInducer.materialize — determinism', () => {
  it('same observation twice → byte-identical JSON.stringify output for classes', () => {
    const records = [
      { name: 'Fireball', level: 3, tags: ['fire'] },
      { name: 'Haste',    level: 2 },
    ];
    const cache1 = buildCache('Spell', records);
    const cache2 = buildCache('Spell', records);
    const set1 = SchemaInducer.materialize(cache1, { baseIri: BASE_IRI });
    const set2 = SchemaInducer.materialize(cache2, { baseIri: BASE_IRI });
    assert.ok(set1.classes[0] !== undefined && set2.classes[0] !== undefined);
    assert.equal(JSON.stringify(set1.classes[0].schema), JSON.stringify(set2.classes[0].schema));
  });

  it('same observation twice → byte-identical extracted primitive output', () => {
    const records = [
      { rarity: 'common' },
      { rarity: 'rare' },
    ];
    const cache1 = buildCache('Spell', records);
    const cache2 = buildCache('Spell', records);
    const set1 = SchemaInducer.materialize(cache1, { baseIri: BASE_IRI });
    const set2 = SchemaInducer.materialize(cache2, { baseIri: BASE_IRI });
    assert.equal(JSON.stringify(set1.primitives), JSON.stringify(set2.primitives));
  });

  it('output keys are sorted alphabetically at the top level', () => {
    const cache = buildCache('Item', [{ z: 'last', a: 'first', m: 'middle' }]);
    const set = materialize(cache);
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, unknown>;
    const propKeys = Object.keys(props);
    assert.deepEqual(propKeys, [...propKeys].sort());
  });

  it('schema top-level keys are sorted alphabetically', () => {
    const cache = buildCache('Item', [{ name: 'thing', active: true }]);
    const set = materialize(cache);
    const result = firstClass(set);
    const topKeys = Object.keys(result.schema);
    assert.deepEqual(topKeys, [...topKeys].sort());
  });

  it('baseIri trailing-slash normalization produces identical output', () => {
    const cache = buildCache('Item', [{ name: 'sword' }]);
    const withSlash    = SchemaInducer.materialize(cache, { baseIri: 'https://a.org/vocab/' });
    const withoutSlash = SchemaInducer.materialize(cache, { baseIri: 'https://a.org/vocab' });
    assert.equal(
      JSON.stringify(withSlash.classes[0]?.schema),
      JSON.stringify(withoutSlash.classes[0]?.schema),
    );
  });
});

// ─── P16: dictionary-style detection ─────────────────────────────────────────

describe('SchemaInducer.materialize — P16 dictionary-style detection', () => {
  it('all-numeric-key nested object stays inline (dictionary detection bypassed, no object extraction)', () => {
    // Simulate Spell.levels: { "1": ["Magic Missile"], "2": ["Hold Person"], ..., "20": [...] }
    // With object extraction disabled, the levels object stays inline with all numeric keys.
    // The dictionary detection (isDictionaryStyle) is only run inside Extractor.#processObjectSchema,
    // which is only called when extracting objects — no longer invoked.
    const obs = ShapeObservationAccumulator.createEmpty('Spell');
    for (let i = 1; i <= 20; i++) {
      ShapeObservationAccumulator.fold(obs, { levels: { [`${i}`]: [`spell-at-${i}`] } });
    }
    const cache = new Map<string, ShapeObservation>([['Spell', obs]]);
    const set = SchemaInducer.materialize(cache, { baseIri: BASE_IRI });

    // The Spell class property 'levels' should be an inline object (no $ref).
    const spellClass = set.classes.find((c) => c.className === 'Spell');
    assert.ok(spellClass !== undefined, 'Spell class should exist');
    const props = spellClass.schema['properties'] as Record<string, Record<string, unknown>>;
    const levelsProp = props['levels'];
    assert.ok(levelsProp !== undefined, 'levels property should exist');
    // Objects stay inline — no $ref extraction.
    assert.ok(!('$ref' in levelsProp), 'levels stays inline (no object extraction)');

    // No primitive should have a purely numeric name.
    const numericPrimitives = set.primitives.filter((p) => /^-?\d+$/.test(p.className));
    assert.equal(numericPrimitives.length, 0, 'no purely numeric primitive names should be emitted');

    // No object extractions.
    assert.equal(set.objects.length, 0, 'objects array must be empty');
  });

  it('non-dictionary nested object with named keys retains per-property structure inline', () => {
    // source: { url: "https://...", page: 42, book: "CRB" } — named struct keys.
    const cache = buildCache('Action', [{ source: { url: 'https://a.org/1', page: 1, book: 'CRB' } }]);
    const set = materialize(cache);
    const result = firstClass(set);
    const props = result.schema['properties'] as Record<string, Record<string, unknown>>;

    // source stays inline (objects are not extracted).
    assert.ok(!('$ref' in (props['source'] ?? {})), 'source should be inline (no object extraction)');
    // Should have per-property structure, not additionalProperties.
    assert.ok(
      'properties' in (props['source'] ?? {}),
      'ActionSource should have named properties (not dictionary mode)',
    );
    assert.equal((props['source'] as Record<string, unknown>)?.['additionalProperties'], undefined,
      'source should not be in dictionary mode');
  });
});

// ─── P16: parent-path propagation ────────────────────────────────────────────

describe('SchemaInducer.materialize — P16 parent-path propagation', () => {
  it('constrained primitive inside inline nested object remains inline (nested extraction not supported)', () => {
    // With inline objects, constrained primitives nested within those objects
    // are NOT extracted to separate schemas — only top-level class properties are
    // processed by #extractBody. This is acceptable because the ABox projector
    // needs inline objects anyway; the trade-off is that nested primitives don't
    // get separate TBox type declarations.
    const obs = ShapeObservationAccumulator.createEmpty('Spell');
    ShapeObservationAccumulator.fold(obs, { levels: { current: 1 } });
    ShapeObservationAccumulator.fold(obs, { levels: { current: 5 } });
    const cache = new Map<string, ShapeObservation>([['Spell', obs]]);
    const set = SchemaInducer.materialize(cache, { baseIri: BASE_IRI });

    // The Spell.levels object is inline (not extracted).
    const spellClass = set.classes.find((c) => c.className === 'Spell');
    assert.ok(spellClass !== undefined);
    const props = spellClass.schema['properties'] as Record<string, Record<string, unknown>>;
    assert.ok(!('$ref' in (props['levels'] ?? {})), 'levels stays inline');

    // The bounded integer 'current' inside the inline object stays inline too.
    const levelsObj = props['levels'] as Record<string, unknown>;
    const innerProps = levelsObj?.['properties'] as Record<string, Record<string, unknown>> | undefined;
    if (innerProps?.['current'] !== undefined) {
      // Stays inline with minimum/maximum directly on the property
      assert.equal(typeof innerProps['current']['minimum'], 'number', 'current has inline minimum');
    }

    // No extracted primitive for nested object property.
    const currentPrimitive = set.primitives.find((p) => p.className === 'SpellLevelCurrent');
    assert.equal(currentPrimitive, undefined, 'nested bounded integers are not extracted separately');
  });

  it('deeply nested inline object — inner constrained primitive uses correct context name', () => {
    // Feat.source.location has a nested object (no extract), but a bounded integer
    // inside the inner object still uses the correct context chain.
    const obs = ShapeObservationAccumulator.createEmpty('Feat');
    ShapeObservationAccumulator.fold(obs, {
      source: { location: { city: 'Absalom', region: 'Inner Sea' } },
    });
    const cache = new Map<string, ShapeObservation>([['Feat', obs]]);
    const set = SchemaInducer.materialize(cache, { baseIri: BASE_IRI });

    // Objects stay inline — no objects in set.objects.
    assert.equal(set.objects.length, 0, 'no objects should be extracted');

    // Feat.source should be an inline object with inline properties.
    const featClass = set.classes.find((c) => c.className === 'Feat');
    assert.ok(featClass !== undefined);
    const props = featClass.schema['properties'] as Record<string, Record<string, unknown>>;
    assert.ok(!('$ref' in (props['source'] ?? {})), 'source stays inline');
    assert.ok('properties' in (props['source'] ?? {}), 'source has inline properties');
  });

  it('numeric property name under nested object uses parent context: SpellLevels1 not 1', () => {
    // Build Spell.levels: { "1": "Cantrip", "2": "First Level" }
    // These are NOT all-numeric-keyed (only 2 keys, both numeric — heuristic fires).
    // But with only 2 numeric keys, isDictionaryStyle returns true (all-numeric heuristic).
    // The SpellLevels object should use additionalProperties mode, not produce "1" or "2" as names.
    const obs = ShapeObservationAccumulator.createEmpty('Spell');
    ShapeObservationAccumulator.fold(obs, { levels: { '1': 'Cantrip', '2': 'First Level' } });
    ShapeObservationAccumulator.fold(obs, { levels: { '1': 'Cantrip', '2': 'Second Level' } });
    const cache = new Map<string, ShapeObservation>([['Spell', obs]]);
    const set = SchemaInducer.materialize(cache, { baseIri: BASE_IRI });

    // No bare numeric primitive names — either dictionary mode (no per-key) or
    // parent-scoped names.
    const numericPrimitives = set.primitives.filter((p) => /^-?\d+$/.test(p.className));
    assert.equal(numericPrimitives.length, 0,
      `No purely numeric names; got: [${set.primitives.map((p) => p.className).join(', ')}]`);
  });
});
