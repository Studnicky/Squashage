import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { SquashageConfig } from '../../../src/config/SquashageConfig.js';
import { SquashageConfigError } from '../../../src/errors/SquashageConfigError.js';

/** Absolute path to the repo-root example config bundled with the project. */
const EXAMPLE_CONFIG_PATH = join(import.meta.dirname, '..', '..', '..', 'squashage.config.example.json');

describe('SquashageConfig.loadFromFile()', () => {
  it('loads the example config and finds the expected target key', () => {
    const cfg = SquashageConfig.loadFromFile(EXAMPLE_CONFIG_PATH);
    assert.ok(cfg.targets['your-target'], 'expected target key to be present');
  });

  it('example config has the expected input.format', () => {
    const cfg = SquashageConfig.loadFromFile(EXAMPLE_CONFIG_PATH);
    assert.equal(cfg.input.format, 'json');
  });

  it('example config target has output.kind === "file"', () => {
    const cfg = SquashageConfig.loadFromFile(EXAMPLE_CONFIG_PATH);
    const target = cfg.targets['your-target'];
    assert.ok(target !== undefined);
    assert.equal(target.output.kind, 'file');
  });

  it('throws SquashageConfigError for a missing file with the path in the message', () => {
    assert.throws(
      () => SquashageConfig.loadFromFile('/tmp/squashage-test-does-not-exist.json'),
      (err: unknown) => {
        assert.ok(err instanceof SquashageConfigError);
        assert.match(err.message, /squashage-test-does-not-exist/);
        return true;
      },
    );
  });
});

describe('SquashageConfig.validate()', () => {
  it('accepts a minimal valid config', () => {
    const raw = {
      input:   { basePath: './output', format: 'json' },
      targets: {
        foo: {
          input:    './output/foo',
          pipeline: ['json:read', 'foo:squash', 'rdfjs:finalize'],
          output:   { kind: 'file', path: './graphs/foo.trig' },
        },
      },
    };
    const cfg = SquashageConfig.validate(raw);
    assert.equal(cfg.input.basePath, './output');
    assert.ok(cfg.targets['foo'] !== undefined);
  });

  it('throws SquashageConfigError for invalid JSON (non-object)', () => {
    assert.throws(
      () => SquashageConfig.validate('not-an-object'),
      (err: unknown) => {
        assert.ok(err instanceof SquashageConfigError);
        return true;
      },
    );
  });

  it('throws SquashageConfigError when output block is missing', () => {
    const raw = {
      input:   { basePath: './output', format: 'json' },
      targets: {
        foo: {
          input:    './output/foo',
          pipeline: ['json:read'],
          // output deliberately omitted
        },
      },
    };
    assert.throws(
      () => SquashageConfig.validate(raw),
      (err: unknown) => {
        assert.ok(err instanceof SquashageConfigError);
        assert.match(err.message, /output/);
        return true;
      },
    );
  });

  it('throws SquashageConfigError when output.format is an unsupported value', () => {
    const raw = {
      input:   { basePath: './output', format: 'json' },
      targets: {
        foo: {
          input:    './output/foo',
          pipeline: ['json:read', 'rdfjs:finalize'],
          output:   { kind: 'file', path: './graphs/foo.rdf', format: 'rdfxml' },
        },
      },
    };
    assert.throws(
      () => SquashageConfig.validate(raw),
      (err: unknown) => {
        assert.ok(err instanceof SquashageConfigError);
        assert.match(err.message, /rdfxml|format/i);
        return true;
      },
    );
  });

  it('throws SquashageConfigError when mode is stream and canonicalize is true', () => {
    const raw = {
      input:   { basePath: './output', format: 'json' },
      targets: {
        foo: {
          input:    './output/foo',
          pipeline: ['json:read', 'rdfjs:finalize'],
          output:   {
            kind:         'file',
            path:         './graphs/foo.trig',
            mode:         'stream',
            canonicalize: true,
          },
        },
      },
    };
    assert.throws(
      () => SquashageConfig.validate(raw),
      (err: unknown) => {
        assert.ok(err instanceof SquashageConfigError);
        return true;
      },
    );
  });

  it('accepts stream mode without canonicalize or validate (compatible)', () => {
    const raw = {
      input:   { basePath: './output', format: 'json' },
      targets: {
        foo: {
          input:    './output/foo',
          pipeline: ['json:read', 'rdfjs:finalize'],
          output:   { kind: 'file', path: './graphs/foo.trig', mode: 'stream' },
        },
      },
    };
    const cfg = SquashageConfig.validate(raw);
    assert.equal(cfg.targets['foo']?.output.mode, 'stream');
  });
});

describe('SquashageConfig.validate() — jsonldContext cross-validation', () => {
  it('accepts jsonldContext when format is explicitly "jsonld"', () => {
    const raw = {
      input:   { basePath: './output', format: 'json' },
      targets: {
        foo: {
          input:    './output/foo',
          pipeline: ['json:read', 'rdfjs:finalize'],
          output:   { kind: 'file', path: './graphs/foo.jsonld', format: 'jsonld', jsonldContext: 'auto' },
        },
      },
    };
    const cfg = SquashageConfig.validate(raw);
    assert.ok(cfg.targets['foo'] !== undefined, 'target should be valid');
  });

  it('accepts jsonldContext when format resolves from .jsonld extension', () => {
    const raw = {
      input:   { basePath: './output', format: 'json' },
      targets: {
        foo: {
          input:    './output/foo',
          pipeline: ['json:read', 'rdfjs:finalize'],
          output:   { kind: 'file', path: './graphs/foo.jsonld', jsonldContext: 'auto' },
        },
      },
    };
    const cfg = SquashageConfig.validate(raw);
    assert.ok(cfg.targets['foo'] !== undefined, 'target with .jsonld extension should be valid');
  });

  it('accepts inline object jsonldContext with jsonld format', () => {
    const raw = {
      input:   { basePath: './output', format: 'json' },
      targets: {
        foo: {
          input:    './output/foo',
          pipeline: ['json:read', 'rdfjs:finalize'],
          output:   {
            kind:         'file',
            path:         './graphs/foo.jsonld',
            format:       'jsonld',
            jsonldContext: { '@context': { ex: 'http://example.org/' } },
          },
        },
      },
    };
    const cfg = SquashageConfig.validate(raw);
    assert.ok(cfg.targets['foo'] !== undefined, 'target with inline context object should be valid');
  });

  it('throws SquashageConfigError when jsonldContext is set with turtle format', () => {
    const raw = {
      input:   { basePath: './output', format: 'json' },
      targets: {
        foo: {
          input:    './output/foo',
          pipeline: ['json:read', 'rdfjs:finalize'],
          output:   {
            kind:         'file',
            path:         './graphs/foo.ttl',
            format:       'turtle',
            jsonldContext: 'auto',
          },
        },
      },
    };
    assert.throws(
      () => SquashageConfig.validate(raw),
      (err: unknown) => {
        assert.ok(err instanceof SquashageConfigError, 'should throw SquashageConfigError');
        assert.match(err.message, /jsonldContext/i);
        return true;
      },
    );
  });

  it('throws SquashageConfigError when jsonldContext is set with nquads format', () => {
    const raw = {
      input:   { basePath: './output', format: 'json' },
      targets: {
        foo: {
          input:    './output/foo',
          pipeline: ['json:read', 'rdfjs:finalize'],
          output:   { kind: 'file', path: './graphs/foo.nq', format: 'nquads', jsonldContext: 'auto' },
        },
      },
    };
    assert.throws(
      () => SquashageConfig.validate(raw),
      (err: unknown) => {
        assert.ok(err instanceof SquashageConfigError);
        return true;
      },
    );
  });

  it('accepts config without jsonldContext for non-jsonld format (no error)', () => {
    const raw = {
      input:   { basePath: './output', format: 'json' },
      targets: {
        foo: {
          input:    './output/foo',
          pipeline: ['json:read', 'rdfjs:finalize'],
          output:   { kind: 'file', path: './graphs/foo.trig' },
        },
      },
    };
    const cfg = SquashageConfig.validate(raw);
    assert.ok(cfg.targets['foo'] !== undefined);
  });
});
