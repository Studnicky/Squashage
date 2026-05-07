import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  Namespaces,
  IRIUtils,
  BaseIRIResolver,
} from '../../../src/rdf/Namespaces.js';
// STANDARD_PREFIXES canonical export moved to Vocab.ts (W5); imported from there.
import { STANDARD_PREFIXES } from '../../../src/rdf/Vocab.js';

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

describe('Namespaces', () => {
  describe('for()', () => {
    it('returns a builder where property access yields a NamedNode with the correct value', () => {
      const ex = Namespaces.for('http://x/');
      assert.equal(ex.foo.value, 'http://x/foo');
    });

    it('supports hash-terminated base IRIs', () => {
      const ex = Namespaces.for('http://x#');
      assert.equal(ex.bar.value, 'http://x#bar');
    });

    it('supports calling the builder as a function', () => {
      const ex = Namespaces.for('http://x/');
      assert.equal(ex('baz').value, 'http://x/baz');
    });

    it('throws when the base IRI does not end with "/" or "#"', () => {
      assert.throws(
        () => Namespaces.for('http://x'),
        (err: unknown) => err instanceof Error && /must end with/.test(err.message),
      );
    });

    it('throws for an empty string', () => {
      assert.throws(
        () => Namespaces.for(''),
        (err: unknown) => err instanceof Error,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// IRIUtils
// ---------------------------------------------------------------------------

describe('IRIUtils', () => {
  describe('slug()', () => {
    it('lowercases and replaces non-alphanumeric runs with hyphens', () => {
      assert.equal(IRIUtils.slug('Hello World!'), 'hello-world');
    });

    it('trims leading and trailing hyphens', () => {
      assert.equal(IRIUtils.slug('!foo!'), 'foo');
    });

    it('collapses multiple separators into one hyphen', () => {
      assert.equal(IRIUtils.slug('a  --  b'), 'a-b');
    });

    it('handles an empty string', () => {
      assert.equal(IRIUtils.slug(''), '');
    });

    it('handles an all-alphanumeric string unchanged (lowercased)', () => {
      assert.equal(IRIUtils.slug('FOO123'), 'foo123');
    });
  });

  describe('join()', () => {
    it('appends directly when base ends with "/"', () => {
      assert.equal(IRIUtils.join('http://x/', 'a'), 'http://x/a');
    });

    it('appends directly when base ends with "#"', () => {
      assert.equal(IRIUtils.join('http://x#', 'a'), 'http://x#a');
    });

    it('inserts "/" when base has no trailing delimiter', () => {
      assert.equal(IRIUtils.join('http://x', 'a'), 'http://x/a');
    });

    it('handles an empty fragment', () => {
      assert.equal(IRIUtils.join('http://x/', ''), 'http://x/');
    });
  });

  describe('isAbsolute()', () => {
    it('returns true for http: IRIs', () => {
      assert.equal(IRIUtils.isAbsolute('http://example.org'), true);
    });

    it('returns true for urn: IRIs', () => {
      assert.equal(IRIUtils.isAbsolute('urn:isbn:0451450523'), true);
    });

    it('returns true for file: IRIs', () => {
      assert.equal(IRIUtils.isAbsolute('file:///etc/hosts'), true);
    });

    it('returns false for relative paths', () => {
      assert.equal(IRIUtils.isAbsolute('relative/path'), false);
    });

    it('returns false for empty string', () => {
      assert.equal(IRIUtils.isAbsolute(''), false);
    });

    it('returns false for a bare fragment', () => {
      assert.equal(IRIUtils.isAbsolute('#fragment'), false);
    });
  });

  describe('normalize()', () => {
    it('normalises percent-encoding and scheme casing', () => {
      const result = IRIUtils.normalize('http://example.org/a');
      assert.equal(result, 'http://example.org/a');
    });

    it('resolves dot segments in the path', () => {
      assert.equal(IRIUtils.normalize('http://example.org/a/../b'), 'http://example.org/b');
    });

    it('lowercases the scheme and host', () => {
      assert.equal(IRIUtils.normalize('HTTP://EXAMPLE.ORG/'), 'http://example.org/');
    });

    it('throws for non-absolute input', () => {
      assert.throws(() => IRIUtils.normalize('not-a-url'));
    });
  });
});

// ---------------------------------------------------------------------------
// BaseIRIResolver
// ---------------------------------------------------------------------------

describe('BaseIRIResolver', () => {
  describe('resolve()', () => {
    it('resolves a relative path segment against base', () => {
      assert.equal(BaseIRIResolver.resolve('http://x/a/b', 'c'), 'http://x/a/c');
    });

    it('resolves a parent-relative reference', () => {
      assert.equal(BaseIRIResolver.resolve('http://x/a/b', '../d'), 'http://x/d');
    });

    it('resolves a fragment reference', () => {
      assert.equal(BaseIRIResolver.resolve('http://x/', '#foo'), 'http://x/#foo');
    });

    it('returns the ref unchanged when ref is absolute', () => {
      assert.equal(
        BaseIRIResolver.resolve('http://x/a', 'http://y.org/z'),
        'http://y.org/z',
      );
    });

    it('throws a descriptive Error when base is not a valid URL', () => {
      assert.throws(
        () => BaseIRIResolver.resolve('not-a-url', 'path'),
        (err: unknown) => err instanceof Error && /BaseIRIResolver.resolve/.test(err.message),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// STANDARD_PREFIXES
// ---------------------------------------------------------------------------

describe('STANDARD_PREFIXES', () => {
  it('contains the rdf prefix', () => {
    assert.equal(STANDARD_PREFIXES['rdf'], 'http://www.w3.org/1999/02/22-rdf-syntax-ns#');
  });

  it('contains the rdfs prefix', () => {
    assert.equal(STANDARD_PREFIXES['rdfs'], 'http://www.w3.org/2000/01/rdf-schema#');
  });

  it('contains the owl prefix', () => {
    assert.equal(STANDARD_PREFIXES['owl'], 'http://www.w3.org/2002/07/owl#');
  });

  it('contains the xsd prefix', () => {
    assert.equal(STANDARD_PREFIXES['xsd'], 'http://www.w3.org/2001/XMLSchema#');
  });

  it('contains the sh (SHACL) prefix', () => {
    assert.equal(STANDARD_PREFIXES['sh'], 'http://www.w3.org/ns/shacl#');
  });

  it('is frozen — mutation throws in strict mode', () => {
    assert.throws(() => {
      // @ts-expect-error intentional mutation test
      (STANDARD_PREFIXES as Record<string, string>)['rdf'] = 'mutated';
    });
  });
});
