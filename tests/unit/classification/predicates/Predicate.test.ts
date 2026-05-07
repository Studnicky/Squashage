/**
 * @fileoverview Unit tests for the {@link Predicate} deterministic engine.
 *
 * @remarks
 * Covers all thirteen leaf operators (positive + negative), path resolution
 * edge cases (nested objects, array indexing, `~0`/`~1` escapes, missing paths),
 * compile-time rejection of invalid inputs, and multi-level composition.
 *
 * @category Classification
 * @since 2.2.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Predicate } from '../../../../src/classification/predicates/Predicate.js';
import type { RawPredicate } from '../../../../src/classification/predicates/Predicate.js';
import { OutputConfigError } from '../../../../src/errors/OutputConfigError.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Compiles and immediately evaluates a predicate against a record. */
function check(raw: RawPredicate, record: unknown): boolean {
  return Predicate.evaluate(Predicate.compile(raw), record);
}

/** Asserts that Predicate.compile throws an OutputConfigError. */
function assertCompileThrows(raw: unknown, pattern?: RegExp): void {
  assert.throws(
    () => Predicate.compile(raw as RawPredicate),
    (err: unknown) => {
      assert.ok(err instanceof OutputConfigError, `Expected OutputConfigError, got ${String(err)}`);
      if (pattern !== undefined) {
        assert.match(err.message, pattern);
      }
      return true;
    },
  );
}

// ── equals ───────────────────────────────────────────────────────────────────

describe('Predicate — equals', () => {
  it('matches a string value', () => {
    assert.equal(check({ path: '/type', equals: 'feat' }, { type: 'feat' }), true);
  });

  it('does not match a different string value', () => {
    assert.equal(check({ path: '/type', equals: 'feat' }, { type: 'spell' }), false);
  });
});

// ── notEquals ────────────────────────────────────────────────────────────────

describe('Predicate — notEquals', () => {
  it('matches when value differs', () => {
    assert.equal(check({ path: '/status', notEquals: 'disabled' }, { status: 'active' }), true);
  });

  it('does not match when value is equal', () => {
    assert.equal(check({ path: '/status', notEquals: 'disabled' }, { status: 'disabled' }), false);
  });
});

// ── in ───────────────────────────────────────────────────────────────────────

describe('Predicate — in', () => {
  it('matches when value is in the set', () => {
    assert.equal(check({ path: '/tier', in: ['common', 'rare', 'legendary'] }, { tier: 'rare' }), true);
  });

  it('does not match when value is absent from the set', () => {
    assert.equal(check({ path: '/tier', in: ['common', 'rare'] }, { tier: 'mythical' }), false);
  });

  it('matches a number in a mixed-type array', () => {
    assert.equal(check({ path: '/code', in: [1, 'two', true, null] }, { code: 'two' }), true);
  });

  it('does not match null when null is absent from the set', () => {
    assert.equal(check({ path: '/code', in: [1, 2, 3] }, { code: null }), false);
  });
});

// ── notIn ────────────────────────────────────────────────────────────────────

describe('Predicate — notIn', () => {
  it('matches when value is not in the set', () => {
    assert.equal(check({ path: '/flag', notIn: ['a', 'b'] }, { flag: 'c' }), true);
  });

  it('does not match when value is in the set', () => {
    assert.equal(check({ path: '/flag', notIn: ['a', 'b'] }, { flag: 'a' }), false);
  });
});

// ── exists ────────────────────────────────────────────────────────────────────

describe('Predicate — exists', () => {
  it('matches when the key is present', () => {
    assert.equal(check({ path: '/name', exists: true }, { name: 'Bulbasaur' }), true);
  });

  it('matches when the key is present but null', () => {
    assert.equal(check({ path: '/name', exists: true }, { name: null }), true);
  });

  it('does not match when the key is absent', () => {
    assert.equal(check({ path: '/name', exists: true }, { level: 1 }), false);
  });
});

// ── missing ───────────────────────────────────────────────────────────────────

describe('Predicate — missing', () => {
  it('matches when the key is absent', () => {
    assert.equal(check({ path: '/deprecated', missing: true }, { name: 'Pikachu' }), true);
  });

  it('does not match when the key is present', () => {
    assert.equal(check({ path: '/deprecated', missing: true }, { deprecated: true }), false);
  });
});

// ── type ──────────────────────────────────────────────────────────────────────

describe('Predicate — type', () => {
  it('matches string type', () => {
    assert.equal(check({ path: '/name', type: 'string' }, { name: 'Charizard' }), true);
  });

  it('rejects number where string expected', () => {
    assert.equal(check({ path: '/name', type: 'string' }, { name: 42 }), false);
  });

  it('matches number type', () => {
    assert.equal(check({ path: '/level', type: 'number' }, { level: 6 }), true);
  });

  it('matches boolean type', () => {
    assert.equal(check({ path: '/legendary', type: 'boolean' }, { legendary: false }), true);
  });

  it('matches null type (value === null)', () => {
    assert.equal(check({ path: '/evolvesFrom', type: 'null' }, { evolvesFrom: null }), true);
  });

  it('rejects undefined where null expected', () => {
    assert.equal(check({ path: '/evolvesFrom', type: 'null' }, {}), false);
  });

  it('matches object type (plain object, not array, not null)', () => {
    assert.equal(check({ path: '/stats', type: 'object' }, { stats: { hp: 45 } }), true);
  });

  it('rejects array where object expected', () => {
    assert.equal(check({ path: '/moves', type: 'object' }, { moves: ['tackle'] }), false);
  });

  it('rejects null where object expected', () => {
    assert.equal(check({ path: '/stats', type: 'object' }, { stats: null }), false);
  });

  it('matches array type', () => {
    assert.equal(check({ path: '/moves', type: 'array' }, { moves: ['tackle', 'growl'] }), true);
  });

  it('rejects plain object where array expected', () => {
    assert.equal(check({ path: '/moves', type: 'array' }, { moves: {} }), false);
  });
});

// ── regex ─────────────────────────────────────────────────────────────────────

describe('Predicate — regex', () => {
  it('matches a string satisfying the anchored pattern', () => {
    assert.equal(check({ path: '/name', regex: '^Bulba.*$' }, { name: 'Bulbasaur' }), true);
  });

  it('does not match a string that fails the pattern', () => {
    assert.equal(check({ path: '/name', regex: '^Bulba.*$' }, { name: 'Charmander' }), false);
  });

  it('rejects unanchored pattern (missing ^) at compile time', () => {
    assertCompileThrows({ path: '/name', regex: 'Bulba.*$' }, /anchored/i);
  });

  it('rejects unanchored pattern (missing $) at compile time', () => {
    assertCompileThrows({ path: '/name', regex: '^Bulba.*' }, /anchored/i);
  });

  it('returns false for non-string values', () => {
    assert.equal(check({ path: '/level', regex: '^\\d+$' }, { level: 42 }), false);
  });
});

// ── length ────────────────────────────────────────────────────────────────────

describe('Predicate — length', () => {
  it('matches a string whose length satisfies gte+lte', () => {
    assert.equal(check({ path: '/name', length: { gte: 3, lte: 10 } }, { name: 'Eevee' }), true);
  });

  it('does not match a string that is too short', () => {
    assert.equal(check({ path: '/name', length: { gte: 10 } }, { name: 'Eevee' }), false);
  });

  it('matches an array of exact length (eq: 0)', () => {
    assert.equal(check({ path: '/moves', length: { eq: 0 } }, { moves: [] }), true);
  });

  it('does not match a non-empty array when eq: 0', () => {
    assert.equal(check({ path: '/moves', length: { eq: 0 } }, { moves: ['tackle'] }), false);
  });

  it('matches an empty string when eq: 0', () => {
    assert.equal(check({ path: '/alias', length: { eq: 0 } }, { alias: '' }), true);
  });

  it('returns false for a number (not string or array)', () => {
    assert.equal(check({ path: '/level', length: { gte: 1 } }, { level: 42 }), false);
  });

  it('returns false for a plain object', () => {
    assert.equal(check({ path: '/stats', length: { gte: 1 } }, { stats: { hp: 45 } }), false);
  });
});

// ── range ─────────────────────────────────────────────────────────────────────

describe('Predicate — range', () => {
  it('matches a value inside an open interval (gt + lt)', () => {
    assert.equal(check({ path: '/score', range: { gt: 0, lt: 10 } }, { score: 5 }), true);
  });

  it('does not match the lower bound of an open interval', () => {
    assert.equal(check({ path: '/score', range: { gt: 0, lt: 10 } }, { score: 0 }), false);
  });

  it('does not match the upper bound of an open interval', () => {
    assert.equal(check({ path: '/score', range: { gt: 0, lt: 10 } }, { score: 10 }), false);
  });

  it('matches the bounds of a closed interval (gte + lte)', () => {
    assert.equal(check({ path: '/level', range: { gte: 1, lte: 151 } }, { level: 1 }), true);
    assert.equal(check({ path: '/level', range: { gte: 1, lte: 151 } }, { level: 151 }), true);
  });

  it('returns false for a non-number', () => {
    assert.equal(check({ path: '/score', range: { gte: 0 } }, { score: 'high' }), false);
  });

  it('returns false for Infinity', () => {
    assert.equal(check({ path: '/score', range: { gte: 0 } }, { score: Infinity }), false);
  });

  it('returns false for NaN', () => {
    assert.equal(check({ path: '/score', range: { gte: 0 } }, { score: NaN }), false);
  });
});

// ── all ───────────────────────────────────────────────────────────────────────

describe('Predicate — all', () => {
  it('returns true when all children match', () => {
    assert.equal(
      check(
        { all: [{ path: '/type', equals: 'feat' }, { path: '/level', range: { gte: 1 } }] },
        { type: 'feat', level: 25 },
      ),
      true,
    );
  });

  it('returns false when any child does not match', () => {
    assert.equal(
      check(
        { all: [{ path: '/type', equals: 'feat' }, { path: '/level', range: { gte: 200 } }] },
        { type: 'feat', level: 25 },
      ),
      false,
    );
  });

  it('returns true for an empty all array', () => {
    assert.equal(check({ all: [] }, {}), true);
  });
});

// ── any ───────────────────────────────────────────────────────────────────────

describe('Predicate — any', () => {
  it('returns true when at least one child matches', () => {
    assert.equal(
      check(
        { any: [{ path: '/type', equals: 'spell' }, { path: '/type', equals: 'feat' }] },
        { type: 'feat' },
      ),
      true,
    );
  });

  it('returns false when no child matches', () => {
    assert.equal(
      check(
        { any: [{ path: '/type', equals: 'spell' }, { path: '/type', equals: 'item' }] },
        { type: 'feat' },
      ),
      false,
    );
  });

  it('returns false for an empty any array', () => {
    assert.equal(check({ any: [] }, {}), false);
  });
});

// ── not ───────────────────────────────────────────────────────────────────────

describe('Predicate — not', () => {
  it('inverts a matching predicate to false', () => {
    assert.equal(check({ not: { path: '/type', equals: 'feat' } }, { type: 'feat' }), false);
  });

  it('inverts a non-matching predicate to true', () => {
    assert.equal(check({ not: { path: '/type', equals: 'spell' } }, { type: 'feat' }), true);
  });
});

// ── path resolution ───────────────────────────────────────────────────────────

describe('Predicate — path resolution', () => {
  it('resolves a nested object path', () => {
    assert.equal(
      check({ path: '/stats/hp', range: { gte: 45 } }, { stats: { hp: 45 } }),
      true,
    );
  });

  it('resolves an array index', () => {
    assert.equal(
      check({ path: '/types/0', equals: 'fire' }, { types: ['fire', 'flying'] }),
      true,
    );
  });

  it('resolves a second array index', () => {
    assert.equal(
      check({ path: '/types/1', equals: 'flying' }, { types: ['fire', 'flying'] }),
      true,
    );
  });

  it('returns false for an out-of-bounds array index', () => {
    assert.equal(
      check({ path: '/types/5', exists: true }, { types: ['fire'] }),
      false,
    );
  });

  it('resolves ~1 as "/" in a segment name', () => {
    // Path "/a~1b/c" decodes to segment "a/b" then "c".
    assert.equal(
      check({ path: '/a~1b/c', equals: 42 }, { 'a/b': { c: 42 } }),
      true,
    );
  });

  it('resolves ~0 as "~" in a segment name', () => {
    assert.equal(
      check({ path: '/a~0b', equals: 'ok' }, { 'a~b': 'ok' }),
      true,
    );
  });

  it('returns missing sentinel for a path through a primitive', () => {
    assert.equal(check({ path: '/name/sub', exists: true }, { name: 'Pikachu' }), false);
  });

  it('returns missing sentinel for a path through null', () => {
    assert.equal(check({ path: '/parent/id', exists: true }, { parent: null }), false);
  });

  it('missing operator returns true for absent key', () => {
    assert.equal(check({ path: '/legendary', missing: true }, { name: 'Mewtwo' }), true);
  });

  it('notEquals returns false when path is missing (not found ≠ notEquals)', () => {
    // notEquals requires the key to be found; absent → false.
    assert.equal(check({ path: '/legendary', notEquals: true }, { name: 'Mewtwo' }), false);
  });

  it('notIn returns false when path is missing', () => {
    assert.equal(check({ path: '/tier', notIn: ['rare'] }, {}), false);
  });
});

// ── compile-time rejection ─────────────────────────────────────────────────────

describe('Predicate — compile-time rejection', () => {
  it('rejects empty path ""', () => {
    assertCompileThrows({ path: '', equals: 1 }, /empty/i);
  });

  it('rejects path not starting with "/"', () => {
    assertCompileThrows({ path: 'name', equals: 'x' }, /must start with/i);
  });

  it('rejects unknown operator key', () => {
    assertCompileThrows({ path: '/x', unknownOp: 1 } as unknown as RawPredicate, /Unknown predicate operator/i);
  });

  it('rejects illegal escape ~2 in path segment', () => {
    assertCompileThrows({ path: '/a~2b', equals: 1 }, /Invalid escape/i);
  });

  it('rejects regex without leading ^', () => {
    assertCompileThrows({ path: '/name', regex: 'foo$' }, /anchored/i);
  });

  it('rejects regex without trailing $', () => {
    assertCompileThrows({ path: '/name', regex: '^foo' }, /anchored/i);
  });

  it('rejects regex with neither ^ nor $', () => {
    assertCompileThrows({ path: '/name', regex: 'foo' }, /anchored/i);
  });
});

// ── deep structural equality ──────────────────────────────────────────────────

describe('Predicate — deep structural equality (equals / in)', () => {
  it('equals matches a structurally identical nested object', () => {
    assert.equal(
      check(
        { path: '/data', equals: { a: [1, { b: 2 }] } },
        { data: { a: [1, { b: 2 }] } },
      ),
      true,
    );
  });

  it('equals rejects an object with a differing deep value', () => {
    assert.equal(
      check(
        { path: '/data', equals: { a: [1, { b: 2 }] } },
        { data: { a: [1, { b: 99 }] } },
      ),
      false,
    );
  });

  it('equals rejects an object with extra keys', () => {
    assert.equal(
      check(
        { path: '/data', equals: { a: 1 } },
        { data: { a: 1, b: 2 } },
      ),
      false,
    );
  });

  it('in uses deep equality to match an object in the array', () => {
    assert.equal(
      check(
        { path: '/tag', in: [{ x: 1 }, { x: 2 }] },
        { tag: { x: 2 } },
      ),
      true,
    );
  });
});

// ── multi-level composition ────────────────────────────────────────────────────

describe('Predicate — multi-level composition', () => {
  it('3-level deep all/any/not returns true for matching record', () => {
    const raw: RawPredicate = {
      all: [
        { path: '/type', equals: 'feat' },
        {
          any: [
            { path: '/legendary', equals: true },
            {
              all: [
                { not: { path: '/legendary', equals: true } },
                { path: '/level', range: { gte: 1, lte: 151 } },
              ],
            },
          ],
        },
      ],
    };
    // Power Attack: not legendary, level 1 — inner all passes → any passes → outer all passes.
    assert.equal(check(raw, { type: 'feat', legendary: false, level: 1 }), true);
  });

  it('3-level deep all/any/not returns false for non-matching record', () => {
    const raw: RawPredicate = {
      all: [
        { path: '/type', equals: 'feat' },
        {
          any: [
            { path: '/legendary', equals: true },
            {
              all: [
                { not: { path: '/legendary', equals: true } },
                { path: '/level', range: { gte: 1, lte: 151 } },
              ],
            },
          ],
        },
      ],
    };
    // High level feat: level 150 passes inner range — should still pass.
    assert.equal(check(raw, { type: 'feat', legendary: false, level: 150 }), true);
    // High level feat: level 10, not legendary → inner all fails → any only has legendary path → fails.
    assert.equal(check(raw, { type: 'feat', legendary: false, level: 152 }), false);
    // Wrong type → outer all fails.
    assert.equal(check(raw, { type: 'spell', legendary: false, level: 1 }), false);
  });

  it('not wrapping an all wrapping multiple conditions', () => {
    const raw: RawPredicate = {
      not: {
        all: [
          { path: '/a', equals: 1 },
          { path: '/b', equals: 2 },
        ],
      },
    };
    assert.equal(check(raw, { a: 1, b: 2 }), false); // all passes → not flips to false
    assert.equal(check(raw, { a: 1, b: 9 }), true);  // all fails → not flips to true
  });
});

// ── array index edge cases ────────────────────────────────────────────────────

describe('Predicate — array index edge cases', () => {
  it('fractional numeric segment resolves to missing', () => {
    assert.equal(check({ path: '/arr/1.5', exists: true }, { arr: [0, 1, 2] }), false);
  });

  it('negative numeric segment resolves to missing', () => {
    assert.equal(check({ path: '/arr/-1', exists: true }, { arr: [0, 1, 2] }), false);
  });

  it('leading-zero segment "01" resolves to missing for arrays', () => {
    assert.equal(check({ path: '/arr/01', exists: true }, { arr: [0, 1, 2] }), false);
  });

  it('non-numeric segment resolves to missing for arrays', () => {
    assert.equal(check({ path: '/arr/foo', exists: true }, { arr: [0, 1] }), false);
  });
});
