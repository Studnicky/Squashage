import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { SubjectIriPolicy } from '../../../src/induction/SubjectIriPolicy.js';
import type { TargetConfigInterface } from '../../../src/config/SquashageConfig.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

const BASE = 'https://example.org/instances/';

/** Minimal TargetConfigInterface fixture with a subjectIri block. */
function targetConfig(
  from: string,
  sanitize: 'url-tail' | 'url-host-path' | 'slug' | 'verbatim',
  fallback?: string,
): TargetConfigInterface {
  return {
    input:  './input',
    output: { kind: 'file', path: './out.trig' },
    subjectIri: { from, sanitize, fallback },
  } as unknown as TargetConfigInterface;
}

/** Minimal config with NO subjectIri block (triggers legacy hash path). */
const NO_SUBJECT_IRI_CONFIG: TargetConfigInterface = {
  input:  './input',
  output: { kind: 'file', path: './out.trig' },
} as unknown as TargetConfigInterface;

/** Expected legacy sha1 IRI for given path+line. */
function expectedHash(recordPath: string, recordLine: number): string {
  const key  = `${recordPath}:${String(recordLine)}`;
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 8);
  return `${BASE}record/${hash}`;
}

// ─── url-tail sanitize ────────────────────────────────────────────────────────

describe('SubjectIriPolicy — sanitize: url-tail', () => {
  it('strips protocol and host, keeps path+query', () => {
    const policy  = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/url', 'url-tail'),
      BASE,
    );
    const result  = policy.resolve({ url: 'https://aonprd.com/Spells.aspx?ID=42' }, '/file', 1);
    // url-tail yields "/Spells.aspx?ID=42"; toAbsoluteIri strips the leading /
    // before prepending runBase, so the final IRI has a single slash separator.
    assert.equal(result, `${BASE}Spells.aspx?ID=42`);
  });

  it('falls back to raw value when value is not a valid URL', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/name', 'url-tail'),
      BASE,
    );
    const result = policy.resolve({ name: 'just-a-slug' }, '/file', 1);
    // Not a URL → URL ctor throws → returns value unchanged → relative → prepend base
    assert.equal(result, `${BASE}just-a-slug`);
  });

  it('drops fragment from URL', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/url', 'url-tail'),
      BASE,
    );
    const result = policy.resolve({ url: 'https://example.org/path#frag' }, '/f', 1);
    // url-tail yields "/path" (no fragment); leading slash stripped by toAbsoluteIri.
    assert.equal(result, `${BASE}path`);
  });
});

// ─── url-host-path sanitize ───────────────────────────────────────────────────

describe('SubjectIriPolicy — sanitize: url-host-path', () => {
  it('strips protocol, keeps host+path, drops query and fragment', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/link', 'url-host-path'),
      BASE,
    );
    const result = policy.resolve(
      { link: 'https://aonprd.com/Feats.aspx?ID=1&name=Power+Attack' },
      '/f',
      1,
    );
    assert.equal(result, `${BASE}aonprd.com/Feats.aspx`);
  });

  it('handles plain hostname URL', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/url', 'url-host-path'),
      BASE,
    );
    const result = policy.resolve({ url: 'http://foo.bar/' }, '/f', 1);
    // pathname is "/" → host + "/"
    assert.equal(result, `${BASE}foo.bar/`);
  });
});

// ─── slug sanitize ────────────────────────────────────────────────────────────

describe('SubjectIriPolicy — sanitize: slug', () => {
  it('lowercases and replaces non-alphanumeric runs with hyphens', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/name', 'slug'),
      BASE,
    );
    const result = policy.resolve({ name: 'Power Attack' }, '/f', 1);
    assert.equal(result, `${BASE}power-attack`);
  });

  it('trims leading and trailing hyphens', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/name', 'slug'),
      BASE,
    );
    const result = policy.resolve({ name: '   --Fireball--   ' }, '/f', 1);
    assert.equal(result, `${BASE}fireball`);
  });

  it('collapses multiple non-alphanumeric characters into one hyphen', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/name', 'slug'),
      BASE,
    );
    const result = policy.resolve({ name: 'A   B___C' }, '/f', 1);
    assert.equal(result, `${BASE}a-b-c`);
  });
});

// ─── verbatim sanitize ────────────────────────────────────────────────────────

describe('SubjectIriPolicy — sanitize: verbatim', () => {
  it('returns the resolved string unchanged when already an absolute IRI', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/iri', 'verbatim'),
      BASE,
    );
    const result = policy.resolve(
      { iri: 'https://data.example.org/spells/fireball' },
      '/f',
      1,
    );
    assert.equal(result, 'https://data.example.org/spells/fireball');
  });

  it('prepends runBase when value is relative', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/slug', 'verbatim'),
      BASE,
    );
    const result = policy.resolve({ slug: 'my-record' }, '/f', 1);
    assert.equal(result, `${BASE}my-record`);
  });
});

// ─── fallback pointer ─────────────────────────────────────────────────────────

describe('SubjectIriPolicy — fallback pointer', () => {
  it('uses fallback when `from` resolves to undefined', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/missing_field', 'slug', '/name'),
      BASE,
    );
    const result = policy.resolve({ name: 'Acid Arrow' }, '/f', 1);
    assert.equal(result, `${BASE}acid-arrow`);
  });

  it('uses `from` when both `from` and `fallback` are present', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/primary', 'slug', '/backup'),
      BASE,
    );
    const result = policy.resolve({ primary: 'Haste', backup: 'Slow' }, '/f', 1);
    assert.equal(result, `${BASE}haste`);
  });

  it('falls through to hash when both `from` and `fallback` resolve to undefined', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/absent', 'slug', '/also_absent'),
      BASE,
    );
    const result = policy.resolve({}, './records/foo.json', 7);
    assert.equal(result, expectedHash('./records/foo.json', 7));
  });
});

// ─── hash fallback (no subjectIri config) ─────────────────────────────────────

describe('SubjectIriPolicy — hash fallback (no config)', () => {
  it('emits sha1 hash IRI when no subjectIri block is present', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(NO_SUBJECT_IRI_CONFIG, BASE);
    const result = policy.resolve({ name: 'ignored' }, './input/foo.json', 1);
    assert.equal(result, expectedHash('./input/foo.json', 1));
  });

  it('is byte-identical to the legacy deriveSubjectIri formula', () => {
    const recordPath = './some/deep/path.json';
    const recordLine = 42;
    const policy     = SubjectIriPolicy.fromTargetConfig(NO_SUBJECT_IRI_CONFIG, BASE);
    const result     = policy.resolve({}, recordPath, recordLine);
    assert.equal(result, expectedHash(recordPath, recordLine));
  });
});

// ─── JSON Pointer escaping (RFC 6901) ─────────────────────────────────────────

describe('SubjectIriPolicy — JSON Pointer escaping', () => {
  it('unescapes ~1 as / allowing a key that contains a literal slash', () => {
    // A key literally named "_source/url" (slash in the key) is encoded as "_source~1url".
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/_source~1url', 'verbatim'),
      BASE,
    );
    // The object has a top-level key whose name contains a literal slash.
    const result = policy.resolve(
      { '_source/url': 'https://example.org/thing' },
      '/f',
      1,
    );
    assert.equal(result, 'https://example.org/thing');
  });

  it('unescapes ~0 as ~ in pointer tokens', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/tilde~0key', 'verbatim'),
      BASE,
    );
    const result = policy.resolve({ 'tilde~key': 'value-here' }, '/f', 1);
    assert.equal(result, `${BASE}value-here`);
  });

  it('unescapes ~1 before ~0 (order matters per RFC 6901)', () => {
    // Key literally contains "~/" — encoded as "~0~1"
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/a~0~1b', 'verbatim'),
      BASE,
    );
    const result = policy.resolve({ 'a~/b': 'correct' }, '/f', 1);
    assert.equal(result, `${BASE}correct`);
  });
});

// ─── absolute IRI passthrough ─────────────────────────────────────────────────

describe('SubjectIriPolicy — absolute IRI passthrough', () => {
  it('does not prepend runBase when value already starts with http://', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/url', 'verbatim'),
      BASE,
    );
    const result = policy.resolve({ url: 'http://data.org/record/1' }, '/f', 1);
    assert.equal(result, 'http://data.org/record/1');
  });

  it('does not prepend runBase when value already starts with https://', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/url', 'verbatim'),
      BASE,
    );
    const result = policy.resolve({ url: 'https://data.org/record/1' }, '/f', 1);
    assert.equal(result, 'https://data.org/record/1');
  });

  it('prepends runBase when value starts with neither http:// nor https://', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/id', 'verbatim'),
      BASE,
    );
    const result = policy.resolve({ id: 'urn:example:thing' }, '/f', 1);
    // "urn:…" is not absolute http/https → prepended
    assert.equal(result, `${BASE}urn:example:thing`);
  });
});

// ─── determinism ──────────────────────────────────────────────────────────────

describe('SubjectIriPolicy — determinism', () => {
  it('same input produces byte-identical output across two invocations', () => {
    const policy   = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/name', 'slug'),
      BASE,
    );
    const instance = { name: 'Fireball' };
    const first    = policy.resolve(instance, './records/spells.json', 10);
    const second   = policy.resolve(instance, './records/spells.json', 10);
    assert.equal(first, second);
  });

  it('hash fallback is deterministic across invocations', () => {
    const policy  = SubjectIriPolicy.fromTargetConfig(NO_SUBJECT_IRI_CONFIG, BASE);
    const first   = policy.resolve({}, './data/records.json', 99);
    const second  = policy.resolve({}, './data/records.json', 99);
    assert.equal(first, second);
  });
});

// ─── per-class overrides (Phase 7 stub) ──────────────────────────────────────

describe('SubjectIriPolicy — per-class overrides', () => {
  it('uses per-class override when className matches', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/name', 'slug'),
      BASE,
    );
    policy.withOverride('Spell', { from: '/url', sanitize: 'url-tail' });
    const result = policy.resolve(
      { name: 'Fireball', url: 'https://aonprd.com/Spells.aspx?ID=1' },
      '/f',
      1,
      'Spell',
    );
    // Override applies url-tail to /url; leading slash stripped by toAbsoluteIri.
    assert.equal(result, `${BASE}Spells.aspx?ID=1`);
  });

  it('falls back to target policy when className has no override', () => {
    const policy = SubjectIriPolicy.fromTargetConfig(
      targetConfig('/name', 'slug'),
      BASE,
    );
    policy.withOverride('Spell', { from: '/url', sanitize: 'url-tail' });
    const result = policy.resolve(
      { name: 'Fireball', url: 'https://aonprd.com/Spells.aspx?ID=1' },
      '/f',
      1,
      'Feat',  // no override registered
    );
    // Target policy applies slug to /name
    assert.equal(result, `${BASE}fireball`);
  });
});
