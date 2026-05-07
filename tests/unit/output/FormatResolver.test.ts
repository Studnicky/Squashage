import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FormatResolver }    from '../../../src/output/FormatResolver.js';
import { OutputConfigError } from '../../../src/errors/OutputConfigError.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid OutputConfigInterface with a given path (and optional format). */
function cfg(path: string, format?: string) {
  // We cast here because in tests we want to exercise the runtime guard path
  // where format may be an invalid string. The schema would reject it at load
  // time; the resolver's guard catches it at runtime.
  return { kind: 'file' as const, path, ...(format !== undefined ? { format } : {}) } as
    Parameters<typeof FormatResolver.resolve>[0];
}

// ---------------------------------------------------------------------------
// Explicit format wins
// ---------------------------------------------------------------------------

describe('FormatResolver.resolve — explicit format wins', () => {
  it('returns turtle when format is set to turtle', () => {
    assert.equal(FormatResolver.resolve(cfg('./out.trig', 'turtle')), 'turtle');
  });

  it('returns trig when format is set to trig', () => {
    assert.equal(FormatResolver.resolve(cfg('./out.ttl', 'trig')), 'trig');
  });

  it('returns nquads when format is set to nquads', () => {
    assert.equal(FormatResolver.resolve(cfg('./out.nt', 'nquads')), 'nquads');
  });

  it('returns ntriples when format is set to ntriples', () => {
    assert.equal(FormatResolver.resolve(cfg('./out.trig', 'ntriples')), 'ntriples');
  });

  it('returns jsonld when format is set to jsonld', () => {
    assert.equal(FormatResolver.resolve(cfg('./out.ttl', 'jsonld')), 'jsonld');
  });

  it('throws OutputConfigError when explicit format is unrecognised', () => {
    assert.throws(
      () => FormatResolver.resolve(cfg('./out.ttl', 'rdfxml')),
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError, 'should be OutputConfigError');
        assert.ok(err.message.includes('rdfxml'), 'message should name the bad format');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Extension fallback
// ---------------------------------------------------------------------------

describe('FormatResolver.resolve — extension fallback', () => {
  it('resolves .ttl to turtle', () => {
    assert.equal(FormatResolver.resolve(cfg('./graphs/aonprd.ttl')), 'turtle');
  });

  it('resolves .trig to trig', () => {
    assert.equal(FormatResolver.resolve(cfg('./graphs/aonprd.trig')), 'trig');
  });

  it('resolves .nt to ntriples', () => {
    assert.equal(FormatResolver.resolve(cfg('./graphs/aonprd.nt')), 'ntriples');
  });

  it('resolves .nq to nquads', () => {
    assert.equal(FormatResolver.resolve(cfg('./graphs/aonprd.nq')), 'nquads');
  });

  it('resolves .jsonld to jsonld', () => {
    assert.equal(FormatResolver.resolve(cfg('./graphs/aonprd.jsonld')), 'jsonld');
  });

  it('resolves uppercase extension (.TTL)', () => {
    assert.equal(FormatResolver.resolve(cfg('./graphs/data.TTL')), 'turtle');
  });
});

// ---------------------------------------------------------------------------
// Error on missing
// ---------------------------------------------------------------------------

describe('FormatResolver.resolve — error on missing', () => {
  it('throws OutputConfigError when extension is unrecognised', () => {
    assert.throws(
      () => FormatResolver.resolve(cfg('./out/data.csv')),
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError, 'should be OutputConfigError');
        assert.ok(err.message.includes('./out/data.csv'), 'message should include the path');
        assert.ok(err.message.includes('format'), 'message should mention format');
        return true;
      },
    );
  });

  it('throws OutputConfigError when path has no extension', () => {
    assert.throws(
      () => FormatResolver.resolve(cfg('./out/dataset')),
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError);
        return true;
      },
    );
  });
});
