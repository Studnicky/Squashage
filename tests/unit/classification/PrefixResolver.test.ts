/**
 * @fileoverview Unit tests for {@link PrefixResolver}.
 *
 * @remarks
 * Covers all derivation paths described in the task spec:
 *
 * 1. Config wins — `targetConfig.ontology.prefixes` fills all three pairs → `source === 'config'`.
 * 2. Derived from `_source.url` embedded in path — `2e.aonprd.com` → `aonprd`.
 * 3. Derived from `_source.path` that IS a URL — same derivation path.
 * 4. Fallback — no config, no sampleSource → all three pairs use synthetic namespace.
 * 5. Determinism — same inputs always return deep-equal results.
 * 6. Sanitize edge cases — target names with spaces, dots, slashes, mixed case.
 * 7. Host heuristic coverage — bulbagarden, aonprd, www.example.org, co.uk (degenerate).
 * 8. Empty target slug throws `OutputConfigError`.
 *
 * @category Classification
 * @since 0.1.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PrefixResolver }      from '../../../src/classification/PrefixResolver.js';
import type { PrefixResolutionInterface } from '../../../src/classification/PrefixResolver.js';
import { OutputConfigError }   from '../../../src/errors/OutputConfigError.js';
import type { InputSourceInterface } from '../../../src/types/PipelineState.js';
import type { TargetConfigInterface } from '../../../src/config/SquashageConfig.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal {@link TargetConfigInterface} for testing.
 * `output` satisfies the schema but is irrelevant to PrefixResolver.
 */
function buildTargetConfig(
  ontology?: Record<string, unknown>,
): TargetConfigInterface {
  return {
    input:    './data',
    pipeline: ['json:read'],
    output:   { kind: 'file', path: './out.ttl' },
    ontology: ontology as Readonly<Record<string, unknown>> | undefined,
  };
}

/**
 * Builds a minimal {@link InputSourceInterface}.
 */
function buildSource(path: string, target = 'test'): InputSourceInterface {
  return { target, path };
}

// ---------------------------------------------------------------------------
// Suite 1 — Config wins
// ---------------------------------------------------------------------------

describe('PrefixResolver — config wins', () => {
  it('returns source === config when all three pairs come from ontology.prefixes + baseIri', () => {
    const cfg = buildTargetConfig({
      baseIri:  'https://2e.aonprd.com/ontology/',
      prefixes: {
        aon:   'https://2e.aonprd.com/',
        aong:  'https://squashage.dev/graph/aonprd/',
      },
    });

    const result = PrefixResolver.resolve('aon', cfg, undefined);

    assert.equal(result.source, 'config');
    assert.equal(result.instances.base,  'https://2e.aonprd.com/');
    assert.equal(result.instances.prefix, 'aon');
    assert.equal(result.graphs.base,     'https://squashage.dev/graph/aonprd/');
    assert.equal(result.graphs.prefix,   'aong');
    assert.equal(result.vocabulary.base, 'https://2e.aonprd.com/ontology/');
    // prefix derived from last path segment of baseIri → 'ontology'
    assert.equal(result.vocabulary.prefix, 'ontology');
  });

  it('uses hash-terminated prefix entry as vocabulary when no baseIri', () => {
    const cfg = buildTargetConfig({
      prefixes: {
        ex:   'https://example.com/',
        exvoc: 'https://example.com/vocab#',
      },
    });

    const result = PrefixResolver.resolve('ex', cfg, undefined);
    assert.equal(result.vocabulary.base,   'https://example.com/vocab#');
    assert.equal(result.vocabulary.prefix, 'exvoc');
  });

  it('picks the lex-sorted first hash entry when multiple hash IRIs exist', () => {
    const cfg = buildTargetConfig({
      prefixes: {
        zzz:  'https://z.example.com/vocab#',
        aaa:  'https://a.example.com/vocab#',
        mmm:  'https://m.example.com/vocab#',
      },
    });

    const result = PrefixResolver.resolve('test', cfg, undefined);
    assert.equal(result.vocabulary.base, 'https://a.example.com/vocab#');
    assert.equal(result.vocabulary.prefix, 'aaa');
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Derived from sampleSource URL in path
// ---------------------------------------------------------------------------

describe('PrefixResolver — derived from _source.path URL', () => {
  it('extracts instance base from https://2e.aonprd.com/ path URL', () => {
    const cfg    = buildTargetConfig();
    const source = buildSource('https://2e.aonprd.com/Feats.aspx?ID=750', 'aonprd');

    const result = PrefixResolver.resolve('aonprd', cfg, source);

    assert.equal(result.instances.base,   'https://2e.aonprd.com/');
    assert.equal(result.instances.prefix, 'aonprd');
    assert.equal(result.source, 'fallback',
      'graphs and vocabulary both fall back so overall source is fallback');
  });

  it('falls back for graphs and vocabulary when only sampleSource URL is available', () => {
    const cfg    = buildTargetConfig();
    const source = buildSource('https://2e.aonprd.com/Feats.aspx?ID=750', 'aonprd');

    const result = PrefixResolver.resolve('aonprd', cfg, source);

    assert.equal(result.graphs.base,      'https://squashage.dev/graph/aonprd/');
    assert.equal(result.graphs.prefix,    'aonprdg');
    assert.equal(result.vocabulary.base,  'https://squashage.dev/vocabulary/aonprd#');
    assert.equal(result.vocabulary.prefix, 'aonprd');
  });

  it('source is derived when instance is derived and no fallback needed', () => {
    // Provide config prefix for graphs so no fallback fires for graphs.
    // But vocabulary still falls back → overall is fallback.
    // To get source === 'derived', ALL three pairs must not fall back and at least one is derived.
    const cfg = buildTargetConfig({
      prefixes: {
        aonprdg:    'https://squashage.dev/graph/aonprd/',
        aonprd:     'https://squashage.dev/vocabulary/aonprd#',
      },
    });
    const source = buildSource('https://2e.aonprd.com/Feats.aspx?ID=750', 'aonprd');

    const result = PrefixResolver.resolve('aonprd', cfg, source);

    assert.equal(result.instances.base,   'https://2e.aonprd.com/');
    assert.equal(result.instances.prefix, 'aonprd');
    // graphs comes from config (contains /graph/)
    assert.equal(result.graphs.base, 'https://squashage.dev/graph/aonprd/');
    // vocab comes from config (hash-terminated)
    assert.equal(result.vocabulary.base, 'https://squashage.dev/vocabulary/aonprd#');
    assert.equal(result.source, 'derived');
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Fallback (no config, no usable sampleSource)
// ---------------------------------------------------------------------------

describe('PrefixResolver — fallback', () => {
  it('falls back to all synthetic namespaces when no config and no sampleSource', () => {
    const cfg    = buildTargetConfig();
    const result = PrefixResolver.resolve('aonprd', cfg, undefined);

    assert.equal(result.source, 'fallback');
    assert.equal(result.instances.base,    'https://squashage.dev/instance/aonprd/');
    assert.equal(result.instances.prefix,  'aonprd');
    assert.equal(result.graphs.base,       'https://squashage.dev/graph/aonprd/');
    assert.equal(result.graphs.prefix,     'aonprdg');
    assert.equal(result.vocabulary.base,   'https://squashage.dev/vocabulary/aonprd#');
    assert.equal(result.vocabulary.prefix, 'aonprd');
  });

  it('falls back when sampleSource path is a filesystem path, not a URL', () => {
    const cfg    = buildTargetConfig();
    const source = buildSource('./output/aonprd/feats-750.json', 'aonprd');

    const result = PrefixResolver.resolve('aonprd', cfg, source);

    assert.equal(result.source, 'fallback');
    assert.equal(result.instances.base, 'https://squashage.dev/instance/aonprd/');
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Determinism
// ---------------------------------------------------------------------------

describe('PrefixResolver — determinism', () => {
  it('returns deep-equal results for identical inputs called twice', () => {
    const cfg    = buildTargetConfig();
    const source = buildSource('https://2e.aonprd.com/Feats.aspx?ID=1', 'aonprd');

    const r1 = PrefixResolver.resolve('aonprd', cfg, source);
    const r2 = PrefixResolver.resolve('aonprd', cfg, source);

    assert.deepEqual(r1, r2);
  });

  it('returns deep-equal results with undefined sampleSource called twice', () => {
    const cfg = buildTargetConfig();

    const r1 = PrefixResolver.resolve('aonprd', cfg, undefined);
    const r2 = PrefixResolver.resolve('aonprd', cfg, undefined);

    assert.deepEqual(r1, r2);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Sanitize edge cases
// ---------------------------------------------------------------------------

describe('PrefixResolver — sanitize', () => {
  it('lowercases and slugifies target with spaces', () => {
    const cfg    = buildTargetConfig();
    const result = PrefixResolver.resolve('My Target Name', cfg, undefined);

    assert.equal(result.instances.prefix,  'my-target-name');
    assert.equal(result.instances.base,    'https://squashage.dev/instance/my-target-name/');
    assert.equal(result.graphs.prefix,     'my-target-nameg');
    assert.equal(result.vocabulary.prefix, 'my-target-name');
  });

  it('slugifies target with dots and slashes', () => {
    const cfg    = buildTargetConfig();
    const result = PrefixResolver.resolve('path/to.target', cfg, undefined);

    assert.equal(result.instances.prefix, 'path-to-target');
    assert.equal(result.source, 'fallback');
  });

  it('slugifies target with UPPERCASE', () => {
    const cfg    = buildTargetConfig();
    const result = PrefixResolver.resolve('AoNPRD', cfg, undefined);

    assert.equal(result.instances.prefix, 'aonprd');
  });

  it('throws OutputConfigError when target sanitizes to empty', () => {
    const cfg = buildTargetConfig();

    assert.throws(
      () => PrefixResolver.resolve('...', cfg, undefined),
      (err: unknown) => {
        assert.ok(err instanceof OutputConfigError, `Expected OutputConfigError, got ${String(err)}`);
        assert.match(err.message, /empty slug/i);
        return true;
      },
    );
  });

  it('throws OutputConfigError when target is only hyphens after sanitize', () => {
    const cfg = buildTargetConfig();

    assert.throws(
      () => PrefixResolver.resolve('---', cfg, undefined),
      (err: unknown) => err instanceof OutputConfigError,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — Host heuristic
// ---------------------------------------------------------------------------

describe('PrefixResolver — host heuristic', () => {
  const resolveHost = (host: string): PrefixResolutionInterface => {
    const cfg    = buildTargetConfig();
    const source = buildSource(`https://${host}/SomePage`, 'test');
    return PrefixResolver.resolve('test', cfg, source);
  };

  it('2e.aonprd.com → prefix aonprd', () => {
    const result = resolveHost('2e.aonprd.com');
    assert.equal(result.instances.prefix, 'aonprd');
    assert.equal(result.instances.base,   'https://2e.aonprd.com/');
  });

  it('wiki.bulbagarden.net → prefix bulbagarden', () => {
    const result = resolveHost('wiki.bulbagarden.net');
    assert.equal(result.instances.prefix, 'bulbagarden');
    assert.equal(result.instances.base,   'https://wiki.bulbagarden.net/');
  });

  it('www.example.org → prefix example', () => {
    const result = resolveHost('www.example.org');
    assert.equal(result.instances.prefix, 'example');
    assert.equal(result.instances.base,   'https://www.example.org/');
  });

  it('co.uk (degenerate — all labels filtered) → falls back for instances', () => {
    const cfg    = buildTargetConfig();
    const source = buildSource('https://co.uk/SomePage', 'test');
    const result = PrefixResolver.resolve('test', cfg, source);

    // Host heuristic yields nothing → instance base falls back to synthetic namespace.
    assert.equal(result.instances.base, 'https://squashage.dev/instance/test/');
    assert.equal(result.source, 'fallback');
  });

  it('m.reddit.com → prefix reddit (m is trivial)', () => {
    const result = resolveHost('m.reddit.com');
    assert.equal(result.instances.prefix, 'reddit');
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — Config prefix graph detection
// ---------------------------------------------------------------------------

describe('PrefixResolver — graph base from config', () => {
  it('detects graph base by /graph/ path segment in IRI', () => {
    const cfg = buildTargetConfig({
      prefixes: {
        mygraph: 'https://custom.example.com/graph/mydata/',
      },
    });

    const result = PrefixResolver.resolve('mydata', cfg, undefined);
    assert.equal(result.graphs.base,   'https://custom.example.com/graph/mydata/');
    assert.equal(result.graphs.prefix, 'mygraph');
  });

  it('detects graph base by conventional <slug>g prefix label', () => {
    const slug = 'aonprd';
    const cfg  = buildTargetConfig({
      prefixes: {
        aonprdg: 'https://custom.example.com/any-path/',
      },
    });

    const result = PrefixResolver.resolve(slug, cfg, undefined);
    assert.equal(result.graphs.base,   'https://custom.example.com/any-path/');
    assert.equal(result.graphs.prefix, 'aonprdg');
  });
});
