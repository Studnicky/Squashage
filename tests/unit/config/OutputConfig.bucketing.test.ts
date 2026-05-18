/**
 * @fileoverview Unit tests for output.bucketing schema additions.
 *
 * Validates that the AJV cross-validation rules are enforced:
 *   - bucketing.enabled === true + output.graph is forbidden
 *   - bucketing config is otherwise accepted when valid
 *   - bucketing.strategy enum values are validated
 *   - bucketing.onUnmapped enum values are validated
 *
 * @module tests/unit/config/OutputConfig.bucketing.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import AjvModule        from 'ajv';
import addFormatsModule from 'ajv-formats';

import type { AjvCtorType, AddFormatsFnInterface } from '../../../src/types/AjvInterop.js';
import { OUTPUT_SCHEMA } from '../../../src/config/OutputConfig.js';

// AJV 8.x dual-CJS/ESM unwrap
const Ajv        = (AjvModule        as unknown as { default?: AjvCtorType }).default        ?? (AjvModule        as unknown as AjvCtorType);
const addFormats = (addFormatsModule as unknown as { default?: AddFormatsFnInterface }).default ?? (addFormatsModule as unknown as AddFormatsFnInterface);

function buildAjv() {
  const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: false });
  addFormats(ajv);
  return ajv;
}

describe('OutputConfig — bucketing schema', () => {
  const ajv = buildAjv();
  const validate = ajv.compile(OUTPUT_SCHEMA);

  it('accepts a minimal config without bucketing', () => {
    const cfg = { kind: 'file', path: './graphs/out.trig' };
    const ok = validate(cfg);
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('accepts bucketing.enabled=false', () => {
    const cfg = {
      kind: 'file',
      path: './graphs/out',
      bucketing: { enabled: false },
    };
    const ok = validate(cfg);
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('accepts bucketing.enabled=true with a directory path', () => {
    const cfg = {
      kind:    'file',
      path:    './graphs/aonprd',
      format:  'trig',
      bucketing: {
        enabled:  true,
        strategy: 'per-graph-iri',
      },
    };
    const ok = validate(cfg);
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('accepts per-config-bucket strategy with a buckets map', () => {
    const cfg = {
      kind:    'file',
      path:    './graphs/aonprd',
      format:  'trig',
      bucketing: {
        enabled:  true,
        strategy: 'per-config-bucket',
        buckets:  {
          'https://example.org/graph/a': 'graph-a',
          'https://example.org/graph/b': 'graph-b',
        },
      },
    };
    const ok = validate(cfg);
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('accepts defaultGraphFilename override', () => {
    const cfg = {
      kind:    'file',
      path:    './graphs/aonprd',
      bucketing: {
        enabled:              true,
        defaultGraphFilename: 'root',
      },
    };
    const ok = validate(cfg);
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('accepts defaultGraphCatalogIri', () => {
    const cfg = {
      kind:    'file',
      path:    './graphs/aonprd',
      bucketing: {
        enabled:                true,
        defaultGraphCatalogIri: 'urn:x-arq:DefaultGraphNode',
      },
    };
    const ok = validate(cfg);
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('accepts maxOpenFiles', () => {
    const cfg = {
      kind:    'file',
      path:    './graphs/aonprd',
      bucketing: {
        enabled:      true,
        maxOpenFiles: 128,
      },
    };
    const ok = validate(cfg);
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('rejects bucketing.enabled=true when output.graph is set', () => {
    const cfg = {
      kind:    'file',
      path:    './graphs/aonprd',
      graph:   'https://example.org/graph/default',
      bucketing: {
        enabled: true,
      },
    };
    const ok = validate(cfg);
    assert.equal(ok, false, 'should reject bucketing.enabled=true + output.graph');
  });

  it('rejects an invalid strategy value', () => {
    const cfg = {
      kind: 'file',
      path: './graphs/aonprd',
      bucketing: {
        enabled:  true,
        strategy: 'per-template',
      },
    };
    const ok = validate(cfg);
    assert.equal(ok, false, 'should reject unknown strategy');
  });

  it('rejects an invalid onUnmapped value', () => {
    const cfg = {
      kind: 'file',
      path: './graphs/aonprd',
      bucketing: {
        enabled:    true,
        onUnmapped: 'quarantine',
      },
    };
    const ok = validate(cfg);
    assert.equal(ok, false, 'should reject unknown onUnmapped value');
  });

  it('rejects additional properties in bucketing', () => {
    const cfg = {
      kind: 'file',
      path: './graphs/aonprd',
      bucketing: {
        enabled:   true,
        unknownProp: 'bad',
      },
    };
    const ok = validate(cfg);
    assert.equal(ok, false, 'should reject unknown bucketing property');
  });

  it('accepts all onUnmapped values', () => {
    for (const onUnmapped of ['other', 'drop', 'fail'] as const) {
      const cfg = {
        kind: 'file',
        path: './graphs/aonprd',
        bucketing: { enabled: true, onUnmapped },
      };
      const ok = validate(cfg);
      assert.ok(ok, `onUnmapped=${onUnmapped} should be valid — errors: ${JSON.stringify(validate.errors)}`);
    }
  });
});
