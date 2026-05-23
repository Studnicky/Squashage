import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ShapeObservationAccumulator,
} from '../../../src/induction/ShapeObservation.js';
import type { PropertyObservation, ShapeObservation } from '../../../src/induction/ShapeObservation.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function fresh(className = 'Feat'): ShapeObservation {
  return ShapeObservationAccumulator.createEmpty(className);
}

function foldAll(obs: ShapeObservation, records: Record<string, unknown>[]): void {
  for (const record of records) {
    ShapeObservationAccumulator.fold(obs, record);
  }
}

// ─── createEmpty ──────────────────────────────────────────────────────────────

describe('ShapeObservationAccumulator.createEmpty', () => {
  it('initialises className, recordCount=0, and empty properties map', () => {
    const obs = fresh('Spell');
    assert.equal(obs.className, 'Spell');
    assert.equal(obs.recordCount, 0);
    assert.equal(obs.properties.size, 0);
  });
});

// ─── fold: basic presence and type histogram ──────────────────────────────────

describe('ShapeObservationAccumulator.fold — basic presence', () => {
  it('increments recordCount on each fold', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { name: 'Fireball' });
    assert.equal(obs.recordCount, 1);
    ShapeObservationAccumulator.fold(obs, { name: 'Haste' });
    assert.equal(obs.recordCount, 2);
  });

  it('tracks presenceCount for a property present in every record', () => {
    const obs = fresh();
    foldAll(obs, [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
    const prop = obs.properties.get('name') as PropertyObservation;
    assert.equal(prop.presenceCount, 3);
  });

  it('tracks presenceCount for a property absent from some records', () => {
    const obs = fresh();
    foldAll(obs, [{ name: 'A' }, {}, { name: 'C' }]);
    const prop = obs.properties.get('name') as PropertyObservation;
    assert.equal(prop.presenceCount, 2);
    assert.equal(obs.recordCount, 3);
  });

  it('does not create a property entry for absent keys', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { a: 1 });
    assert.equal(obs.properties.has('b'), false);
  });
});

// ─── fold: type histogram ─────────────────────────────────────────────────────

describe('ShapeObservationAccumulator.fold — type histogram', () => {
  it('records the correct type for a string value', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { kind: 'feat' });
    const prop = obs.properties.get('kind') as PropertyObservation;
    assert.equal(prop.typeHistogram.get('string'), 1);
  });

  it('records integer type for whole-number values', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { level: 3 });
    const prop = obs.properties.get('level') as PropertyObservation;
    assert.equal(prop.typeHistogram.get('integer'), 1);
    assert.equal(prop.typeHistogram.has('number'), false);
  });

  it('records number type for fractional values', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { ratio: 1.5 });
    const prop = obs.properties.get('ratio') as PropertyObservation;
    assert.equal(prop.typeHistogram.get('number'), 1);
  });

  it('records boolean type', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { active: true });
    const prop = obs.properties.get('active') as PropertyObservation;
    assert.equal(prop.typeHistogram.get('boolean'), 1);
  });

  it('records null type', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { description: null });
    const prop = obs.properties.get('description') as PropertyObservation;
    assert.equal(prop.typeHistogram.get('null'), 1);
  });

  it('records array type', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { tags: ['a', 'b'] });
    const prop = obs.properties.get('tags') as PropertyObservation;
    assert.equal(prop.typeHistogram.get('array'), 1);
  });

  it('records object type', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { meta: { x: 1 } });
    const prop = obs.properties.get('meta') as PropertyObservation;
    assert.equal(prop.typeHistogram.get('object'), 1);
  });

  it('accumulates mixed types across multiple records', () => {
    const obs = fresh();
    foldAll(obs, [
      { value: 'string-val' },
      { value: 42 },
      { value: null },
    ]);
    const prop = obs.properties.get('value') as PropertyObservation;
    assert.equal(prop.typeHistogram.get('string'),  1);
    assert.equal(prop.typeHistogram.get('integer'), 1);
    assert.equal(prop.typeHistogram.get('null'),    1);
  });
});

// ─── fold: distinctValues and overflow ───────────────────────────────────────

describe('ShapeObservationAccumulator.fold — distinct values', () => {
  it('tracks distinct string values up to overflow threshold', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { kind: 'feat' }, { overflowThreshold: 10 });
    const prop = obs.properties.get('kind') as PropertyObservation;
    assert.equal(prop.distinctValues.has('feat'), true);
    assert.equal(prop.distinctOverflow, false);
  });

  it('sets distinctOverflow when threshold is reached', () => {
    const obs = fresh();
    for (let i = 0; i < 5; i++) {
      ShapeObservationAccumulator.fold(obs, { tag: `tag-${i}` }, { overflowThreshold: 5 });
    }
    const prop = obs.properties.get('tag') as PropertyObservation;
    assert.equal(prop.distinctOverflow, true);
  });

  it('does not add new distinct values once overflowed', () => {
    const obs = fresh();
    for (let i = 0; i < 5; i++) {
      ShapeObservationAccumulator.fold(obs, { tag: `tag-${i}` }, { overflowThreshold: 5 });
    }
    // Add one more after overflow
    ShapeObservationAccumulator.fold(obs, { tag: 'brand-new' }, { overflowThreshold: 5 });
    const prop = obs.properties.get('tag') as PropertyObservation;
    assert.equal(prop.distinctValues.has('brand-new'), false);
  });

  it('default overflow threshold is 256', () => {
    const obs = fresh();
    for (let i = 0; i < 255; i++) {
      ShapeObservationAccumulator.fold(obs, { v: `v${i}` });
    }
    const prop = obs.properties.get('v') as PropertyObservation;
    assert.equal(prop.distinctOverflow, false);
    // One more should tip it over
    ShapeObservationAccumulator.fold(obs, { v: 'v255' });
    assert.equal(prop.distinctOverflow, true);
  });

  it('tracks duplicate string values (distinctValues is a Set; no double counting)', () => {
    const obs = fresh();
    foldAll(obs, [{ kind: 'feat' }, { kind: 'feat' }, { kind: 'feat' }]);
    const prop = obs.properties.get('kind') as PropertyObservation;
    assert.equal(prop.distinctValues.size, 1);
    assert.equal(prop.typeHistogram.get('string'), 3);
  });
});

// ─── fold: urlPatternCount ────────────────────────────────────────────────────

describe('ShapeObservationAccumulator.fold — urlPatternCount', () => {
  it('increments urlPatternCount for http:// values', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { link: 'http://example.org/foo' });
    const prop = obs.properties.get('link') as PropertyObservation;
    assert.equal(prop.urlPatternCount, 1);
  });

  it('increments urlPatternCount for https:// values', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { link: 'https://example.org/foo' });
    const prop = obs.properties.get('link') as PropertyObservation;
    assert.equal(prop.urlPatternCount, 1);
  });

  it('does not increment urlPatternCount for non-URL strings', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { name: 'Fireball' });
    const prop = obs.properties.get('name') as PropertyObservation;
    assert.equal(prop.urlPatternCount, 0);
  });

  it('accumulates urlPatternCount across multiple records', () => {
    const obs = fresh();
    foldAll(obs, [
      { src: 'https://a.org/1' },
      { src: 'not-a-url' },
      { src: 'https://b.org/2' },
    ]);
    const prop = obs.properties.get('src') as PropertyObservation;
    assert.equal(prop.urlPatternCount, 2);
  });
});

// ─── fold: numericRange ───────────────────────────────────────────────────────

describe('ShapeObservationAccumulator.fold — numericRange', () => {
  it('initialises min and max from the first numeric value', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { level: 5 });
    const prop = obs.properties.get('level') as PropertyObservation;
    assert.deepEqual(prop.numericRange, { min: 5, max: 5 });
  });

  it('updates min when a smaller value is seen', () => {
    const obs = fresh();
    foldAll(obs, [{ level: 5 }, { level: 2 }]);
    const prop = obs.properties.get('level') as PropertyObservation;
    assert.equal(prop.numericRange?.min, 2);
  });

  it('updates max when a larger value is seen', () => {
    const obs = fresh();
    foldAll(obs, [{ level: 5 }, { level: 10 }]);
    const prop = obs.properties.get('level') as PropertyObservation;
    assert.equal(prop.numericRange?.max, 10);
  });

  it('tracks min/max across many records correctly', () => {
    const obs = fresh();
    foldAll(obs, [
      { price: 3.5 },
      { price: 1.2 },
      { price: 7.8 },
      { price: 4.0 },
    ]);
    const prop = obs.properties.get('price') as PropertyObservation;
    assert.equal(prop.numericRange?.min, 1.2);
    assert.equal(prop.numericRange?.max, 7.8);
  });

  it('is undefined for string-only properties', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { name: 'Fireball' });
    const prop = obs.properties.get('name') as PropertyObservation;
    assert.equal(prop.numericRange, undefined);
  });
});

// ─── fold: recursive array items ─────────────────────────────────────────────

describe('ShapeObservationAccumulator.fold — recursive array items', () => {
  it('creates arrayItem observation for array properties', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { tags: ['fire', 'evocation'] });
    const prop = obs.properties.get('tags') as PropertyObservation;
    assert.ok(prop.arrayItem !== undefined);
  });

  it('folds array element types into arrayItem.typeHistogram', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { tags: ['fire', 'evocation'] });
    const prop = obs.properties.get('tags') as PropertyObservation;
    assert.equal(prop.arrayItem?.typeHistogram.get('string'), 2);
  });

  it('accumulates arrayItem across multiple records', () => {
    const obs = fresh();
    foldAll(obs, [
      { tags: ['a', 'b'] },
      { tags: ['c'] },
    ]);
    const prop = obs.properties.get('tags') as PropertyObservation;
    assert.equal(prop.arrayItem?.typeHistogram.get('string'), 3);
    assert.equal(prop.arrayItem?.presenceCount, 3);
  });

  it('respects depthCap — no arrayItem when depthCap=0', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { tags: ['a', 'b'] }, { depthCap: 0 });
    const prop = obs.properties.get('tags') as PropertyObservation;
    assert.equal(prop.arrayItem, undefined);
  });
});

// ─── fold: recursive nested objects ──────────────────────────────────────────

describe('ShapeObservationAccumulator.fold — recursive nested objects', () => {
  it('creates nested observation for object-valued properties', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { source: { url: 'https://a.org' } });
    const prop = obs.properties.get('source') as PropertyObservation;
    assert.ok(prop.nested !== undefined);
    assert.ok(prop.nested.has('url'));
  });

  it('folds nested property types into the child observation', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { source: { url: 'https://a.org' } });
    const sourceProp = obs.properties.get('source') as PropertyObservation;
    const urlObs     = sourceProp.nested?.get('url') as PropertyObservation;
    assert.equal(urlObs.typeHistogram.get('string'), 1);
  });

  it('respects depthCap — no nested when depthCap=0', () => {
    const obs = fresh();
    ShapeObservationAccumulator.fold(obs, { source: { url: 'https://a.org' } }, { depthCap: 0 });
    const prop = obs.properties.get('source') as PropertyObservation;
    assert.equal(prop.nested, undefined);
  });

  it('depth cap limits recursion at the specified level', () => {
    const obs = fresh();
    // Depth 1 from root: source is level 1; source.nested is level 2; should not recurse into level 2.
    ShapeObservationAccumulator.fold(obs, {
      source: {
        nested: { deep: 'value' },
      },
    }, { depthCap: 1 });
    const sourceProp  = obs.properties.get('source') as PropertyObservation;
    const nestedProp  = sourceProp.nested?.get('nested') as PropertyObservation | undefined;
    // 'nested' property exists at depth 1 (it was seen as an object value)
    assert.ok(nestedProp !== undefined);
    // But its own 'nested' map should NOT be populated (depthCap ran out)
    assert.equal(nestedProp.nested, undefined);
  });
});

// ─── fold: determinism ───────────────────────────────────────────────────────

describe('ShapeObservationAccumulator.fold — determinism', () => {
  /**
   * Two observations built from the same records in different orders must
   * produce structurally identical results. We compare by inspecting
   * key/value equality on the resulting maps and counters.
   */
  it('same records in different orders produce identical observations', () => {
    const records = [
      { name: 'Fireball',    level: 3,  tags: ['fire', 'evocation'] },
      { name: 'Haste',       level: 2,  tags: ['transmutation']    },
      { name: 'Acid Arrow',  level: 2,  tags: ['acid', 'conjuration'] },
    ];
    const shuffled = [records[2]!, records[0]!, records[1]!];

    const obsA = fresh('Spell');
    foldAll(obsA, records);
    const obsB = fresh('Spell');
    foldAll(obsB, shuffled);

    // recordCount must match
    assert.equal(obsA.recordCount, obsB.recordCount);

    // Every property must match on all observable fields
    for (const [key, propA] of obsA.properties) {
      const propB = obsB.properties.get(key);
      assert.ok(propB !== undefined, `property "${key}" missing from obsB`);
      assert.equal(propA.presenceCount, propB.presenceCount, `presenceCount for "${key}"`);
      assert.equal(propA.urlPatternCount, propB.urlPatternCount, `urlPatternCount for "${key}"`);
      assert.equal(propA.distinctOverflow, propB.distinctOverflow, `distinctOverflow for "${key}"`);
      assert.deepEqual(propA.numericRange, propB.numericRange, `numericRange for "${key}"`);

      // typeHistogram key-value equality
      for (const [type, count] of propA.typeHistogram) {
        assert.equal(propB.typeHistogram.get(type), count, `typeHistogram[${type}] for "${key}"`);
      }

      // distinctValues set equality
      assert.deepEqual(
        [...propA.distinctValues].sort(),
        [...propB.distinctValues].sort(),
        `distinctValues for "${key}"`,
      );
    }
  });
});
