/**
 * Unit tests for RefinementApplier — `parents` operation (step 15).
 *
 * Verifies that the `parents` DSL field correctly emits `allOf: [{ $ref }]`
 * entries on the final schema, merges with pre-existing `allOf`, respects
 * `parentsBase` overrides, derives `finalsBase` from the draft `$id`, and
 * emits warnings for invalid parent names.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RefinementApplier } from '../../../src/induction/RefinementApplier.js';
import type { RefineSpec } from '../../../src/induction/RefinementApplier.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const SCHEMA_URL = 'https://squashage.dev/schemas/refinement.schema.json';

/**
 * Builds a minimal draft schema.
 *
 * @param id   - The draft `$id` (defaults to a canonical inferred URL).
 * @param allOf - Pre-existing `allOf` entries on the draft, if any.
 */
function makeDraft(
  id      = 'https://x/schemas/inferred/Feat.draft.json',
  allOf?: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    $schema:    'https://json-schema.org/draft/2020-12/schema',
    $id:        id,
    title:      'Feat',
    type:       'object',
    properties: { name: { type: 'string' } },
  };
  if (allOf !== undefined) {
    base['allOf'] = allOf;
  }
  return base;
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

// ─── single parent ────────────────────────────────────────────────────────────

describe('RefinementApplier — parents: single parent', () => {
  it('emits allOf with one $ref entry for the named parent', () => {
    const draft = makeDraft();
    const { final, warnings } = apply(draft, { parents: ['ContentEntry'] });

    const allOf = final['allOf'] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(allOf), 'allOf present');
    assert.equal(allOf.length, 1);
    assert.equal(allOf[0]!['$ref'], 'https://x/schemas/ContentEntry.schema.json');
    assert.equal(warnings.length, 0);
  });
});

// ─── multiple parents (branching inheritance) ─────────────────────────────────

describe('RefinementApplier — parents: multiple parents', () => {
  it('emits allOf entries in the order given', () => {
    const draft = makeDraft();
    const { final, warnings } = apply(draft, { parents: ['ContentEntry', 'Provenance'] });

    const allOf = final['allOf'] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(allOf));
    assert.equal(allOf.length, 2);
    assert.equal(allOf[0]!['$ref'], 'https://x/schemas/ContentEntry.schema.json');
    assert.equal(allOf[1]!['$ref'], 'https://x/schemas/Provenance.schema.json');
    assert.equal(warnings.length, 0);
  });
});

// ─── pre-existing allOf is preserved ─────────────────────────────────────────

describe('RefinementApplier — parents: preserves pre-existing allOf', () => {
  it('appends new entries to any existing allOf without overwriting', () => {
    const existingRef = { $ref: 'https://other.example/schemas/Other.schema.json' };
    const draft = makeDraft('https://x/schemas/inferred/Feat.draft.json', [existingRef]);
    const { final, warnings } = apply(draft, { parents: ['ContentEntry'] });

    const allOf = final['allOf'] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(allOf));
    assert.equal(allOf.length, 2, 'original entry retained, new entry appended');
    assert.equal(allOf[0]!['$ref'], 'https://other.example/schemas/Other.schema.json');
    assert.equal(allOf[1]!['$ref'], 'https://x/schemas/ContentEntry.schema.json');
    assert.equal(warnings.length, 0);
  });
});

// ─── parentsBase override ─────────────────────────────────────────────────────

describe('RefinementApplier — parents: parentsBase override', () => {
  it('uses explicit parentsBase verbatim instead of deriving from $id', () => {
    const draft = makeDraft('https://x/schemas/inferred/Feat.draft.json');
    const { final, warnings } = apply(draft, {
      parents:     ['ContentEntry'],
      parentsBase: 'https://other.example/schemas',
    });

    const allOf = final['allOf'] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(allOf));
    assert.equal(allOf[0]!['$ref'], 'https://other.example/schemas/ContentEntry.schema.json');
    assert.equal(warnings.length, 0);
  });
});

// ─── finalsBase derivation from $id ──────────────────────────────────────────

describe('RefinementApplier — parents: finalsBase derivation from $id', () => {
  it('strips /inferred/<leaf> to produce the finals directory', () => {
    const draft = makeDraft('https://x/schemas/inferred/Feat.draft.json');
    const { final } = apply(draft, { parents: ['ContentEntry'] });

    const allOf = final['allOf'] as Array<Record<string, unknown>>;
    // finalsBase should be "https://x/schemas" (no trailing slash, no /inferred)
    assert.equal(allOf[0]!['$ref'], 'https://x/schemas/ContentEntry.schema.json');
  });

  it('falls back to direct directory when $id has no /inferred segment', () => {
    // e.g. draft is already at the final location or a non-standard path
    const draft = makeDraft('https://x/schemas/Feat.draft.json');
    const { final, warnings } = apply(draft, { parents: ['NamedThing'] });

    const allOf = final['allOf'] as Array<Record<string, unknown>>;
    // No /inferred to strip — directory is "https://x/schemas"
    assert.equal(allOf[0]!['$ref'], 'https://x/schemas/NamedThing.schema.json');
    assert.equal(warnings.length, 0);
  });
});

// ─── warning on orphan (invalid) parent name ─────────────────────────────────

describe('RefinementApplier — parents: warning on invalid parent name', () => {
  it('emits a warning for the empty-string entry and skips it, but keeps valid entries', () => {
    const draft = makeDraft();
    const { final, warnings } = apply(draft, { parents: ['', 'Valid'] });

    // Exactly one warning for the empty-string entry.
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, 'PARENTS_INVALID_NAME');

    // The valid entry still appears.
    const allOf = final['allOf'] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(allOf));
    assert.equal(allOf.length, 1);
    assert.equal(allOf[0]!['$ref'], 'https://x/schemas/Valid.schema.json');
  });

  it('emits a warning for a name that fails the identifier pattern', () => {
    const draft = makeDraft();
    const { warnings } = apply(draft, { parents: ['123Bad'] });

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, 'PARENTS_INVALID_NAME');
  });

  it('emits no allOf entry when all parent names are invalid', () => {
    const draft = makeDraft();
    const { final, warnings } = apply(draft, { parents: ['', '456'] });

    assert.equal(warnings.length, 2);
    assert.equal(final['allOf'], undefined);
  });
});

// ─── no-op when parents absent ────────────────────────────────────────────────

describe('RefinementApplier — parents: no-op when not provided', () => {
  it('leaves schema unchanged when parents is absent', () => {
    const draft = makeDraft();
    const { final, warnings } = apply(draft, {});

    assert.equal(final['allOf'], undefined);
    assert.equal(warnings.length, 0);
  });

  it('leaves schema unchanged when parents is empty array', () => {
    const draft = makeDraft();
    const { final, warnings } = apply(draft, { parents: [] });

    assert.equal(final['allOf'], undefined);
    assert.equal(warnings.length, 0);
  });
});

// ─── determinism ─────────────────────────────────────────────────────────────

describe('RefinementApplier — parents: determinism', () => {
  it('two identical applies produce byte-identical output', () => {
    const draft = makeDraft();
    const spec  = makeSpec({ parents: ['ContentEntry', 'Provenance'] });

    const { final: a } = RefinementApplier.apply(draft, spec);
    const { final: b } = RefinementApplier.apply(draft, spec);

    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});
