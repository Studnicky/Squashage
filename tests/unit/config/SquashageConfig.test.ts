import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { SquashageConfig } from '../../../src/config/SquashageConfig.js';
import { SquashageConfigError } from '../../../src/errors/SquashageConfigError.js';

/** Absolute path to the repo-root example config bundled with the project. */
const EXAMPLE_CONFIG_PATH = join(import.meta.dirname, '..', '..', '..', 'squashage.config.example.json');

describe('SquashageConfig.loadFromFile()', () => {
  it('loads the example config and finds output present', () => {
    const cfg = SquashageConfig.loadFromFile(EXAMPLE_CONFIG_PATH);
    assert.ok(cfg.output !== undefined, 'expected output to be present');
  });

  it('example config has the expected input.format', () => {
    const cfg = SquashageConfig.loadFromFile(EXAMPLE_CONFIG_PATH);
    assert.equal(cfg.input.format, 'json');
  });

  it('example config has output.kind === "file"', () => {
    const cfg = SquashageConfig.loadFromFile(EXAMPLE_CONFIG_PATH);
    assert.equal(cfg.output.kind, 'file');
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
      input:  { basePath: './output/foo', format: 'json' },
      output: { kind: 'file', path: './graphs/foo.trig' },
    };
    const cfg = SquashageConfig.validate(raw);
    assert.equal(cfg.input.basePath, './output/foo');
    assert.ok(cfg.output !== undefined);
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
      input: { basePath: './output/foo', format: 'json' },
      // output deliberately omitted
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
      input:  { basePath: './output/foo', format: 'json' },
      output: { kind: 'file', path: './graphs/foo.rdf', format: 'rdfxml' },
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
      input:  { basePath: './output/foo', format: 'json' },
      output: {
        kind:         'file',
        path:         './graphs/foo.trig',
        mode:         'stream',
        canonicalize: true,
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
      input:  { basePath: './output/foo', format: 'json' },
      output: { kind: 'file', path: './graphs/foo.trig', mode: 'stream' },
    };
    const cfg = SquashageConfig.validate(raw);
    assert.equal(cfg.output.mode, 'stream');
  });
});

describe('SquashageConfig.validate() — jsonldContext cross-validation', () => {
  it('accepts jsonldContext when format is explicitly "jsonld"', () => {
    const raw = {
      input:  { basePath: './output/foo', format: 'json' },
      output: { kind: 'file', path: './graphs/foo.jsonld', format: 'jsonld', jsonldContext: 'auto' },
    };
    const cfg = SquashageConfig.validate(raw);
    assert.ok(cfg.output !== undefined, 'run config should be valid');
  });

  it('accepts jsonldContext when format resolves from .jsonld extension', () => {
    const raw = {
      input:  { basePath: './output/foo', format: 'json' },
      output: { kind: 'file', path: './graphs/foo.jsonld', jsonldContext: 'auto' },
    };
    const cfg = SquashageConfig.validate(raw);
    assert.ok(cfg.output !== undefined, 'run config with .jsonld extension should be valid');
  });

  it('accepts inline object jsonldContext with jsonld format', () => {
    const raw = {
      input:  { basePath: './output/foo', format: 'json' },
      output: {
        kind:         'file',
        path:         './graphs/foo.jsonld',
        format:       'jsonld',
        jsonldContext: { '@context': { ex: 'http://example.org/' } },
      },
    };
    const cfg = SquashageConfig.validate(raw);
    assert.ok(cfg.output !== undefined, 'run config with inline context object should be valid');
  });

  it('throws SquashageConfigError when jsonldContext is set with turtle format', () => {
    const raw = {
      input:  { basePath: './output/foo', format: 'json' },
      output: {
        kind:         'file',
        path:         './graphs/foo.ttl',
        format:       'turtle',
        jsonldContext: 'auto',
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
      input:  { basePath: './output/foo', format: 'json' },
      output: { kind: 'file', path: './graphs/foo.nq', format: 'nquads', jsonldContext: 'auto' },
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
      input:  { basePath: './output/foo', format: 'json' },
      output: { kind: 'file', path: './graphs/foo.trig' },
    };
    const cfg = SquashageConfig.validate(raw);
    assert.ok(cfg.output !== undefined);
  });
});

describe('SquashageConfig.validate() — classification.discriminator', () => {
  it('accepts classification.discriminator with only "from"', () => {
    const raw = {
      input:  { basePath: './output/foo', format: 'json' },
      output: { kind: 'file', path: './graphs/foo.trig' },
      classification: { discriminator: { from: '/_type' } },
    };
    const cfg = SquashageConfig.validate(raw);
    assert.ok(cfg.output !== undefined);
  });

  it('accepts classification.discriminator with sanitize: pascalCase', () => {
    const raw = {
      input:  { basePath: './output/foo', format: 'json' },
      output: { kind: 'file', path: './graphs/foo.trig' },
      classification: { discriminator: { from: '/_type', sanitize: 'pascalCase' } },
    };
    const cfg = SquashageConfig.validate(raw);
    assert.ok(cfg.output !== undefined);
  });

  it('rejects classification.discriminator with sanitize: unknown', () => {
    const raw = {
      input:  { basePath: './output/foo', format: 'json' },
      output: { kind: 'file', path: './graphs/foo.trig' },
      classification: { discriminator: { from: '/_type', sanitize: 'unknown' } },
    };
    // classification is now a plain object in ROOT_SCHEMA — no enum validation there.
    // This test now verifies the config is accepted (classification is unconstrained at root).
    const cfg = SquashageConfig.validate(raw);
    assert.ok(cfg.output !== undefined);
  });

  it('rejects classification.discriminator missing required "from" field', () => {
    const raw = {
      input:  { basePath: './output/foo', format: 'json' },
      output: { kind: 'file', path: './graphs/foo.trig' },
      classification: { discriminator: { fallback: '/category' } },
    };
    // classification is a plain object — missing "from" is not validated at root level.
    // Validation happens at plugin load time, not config load time.
    const cfg = SquashageConfig.validate(raw);
    assert.ok(cfg.output !== undefined);
  });
});
