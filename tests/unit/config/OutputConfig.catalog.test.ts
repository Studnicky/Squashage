/**
 * @fileoverview Unit tests for output.catalog schema additions.
 *
 * Validates:
 * - catalog.enabled=true requires bucketing.enabled=true
 * - catalog schema properties are accepted
 * - rewriteRoots items are validated
 *
 * @module tests/unit/config/OutputConfig.catalog.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import AjvModule        from 'ajv';
import addFormatsModule from 'ajv-formats';

import type { AjvCtorType, AddFormatsFnInterface } from '../../../src/types/AjvInterop.js';
import { OUTPUT_SCHEMA } from '../../../src/config/OutputConfig.js';

const Ajv        = (AjvModule        as unknown as { default?: AjvCtorType }).default        ?? (AjvModule        as unknown as AjvCtorType);
const addFormats = (addFormatsModule as unknown as { default?: AddFormatsFnInterface }).default ?? (addFormatsModule as unknown as AddFormatsFnInterface);

function buildAjv() {
  const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: false });
  addFormats(ajv);
  return ajv;
}

describe('OutputConfig — catalog schema', () => {
  const ajv = buildAjv();
  const validate = ajv.compile(OUTPUT_SCHEMA);

  it('accepts catalog.enabled=true when bucketing.enabled=true', () => {
    const cfg = {
      kind:    'file',
      path:    './graphs/aonprd',
      format:  'trig',
      bucketing: { enabled: true },
      catalog:   { enabled: true },
    };
    const ok = validate(cfg);
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('rejects catalog.enabled=true when bucketing is absent', () => {
    const cfg = {
      kind:   'file',
      path:   './graphs/aonprd',
      catalog: { enabled: true },
    };
    const ok = validate(cfg);
    assert.equal(ok, false, 'catalog.enabled=true without bucketing should fail');
  });

  it('rejects catalog.enabled=true when bucketing.enabled=false', () => {
    const cfg = {
      kind:     'file',
      path:     './graphs/aonprd',
      bucketing: { enabled: false },
      catalog:   { enabled: true },
    };
    const ok = validate(cfg);
    assert.equal(ok, false, 'catalog.enabled=true with bucketing.enabled=false should fail');
  });

  it('accepts catalog.enabled=false without bucketing', () => {
    const cfg = {
      kind:   'file',
      path:   './graphs/aonprd.trig',
      catalog: { enabled: false },
    };
    const ok = validate(cfg);
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('accepts catalog with filename override', () => {
    const cfg = {
      kind:    'file',
      path:    './graphs/aonprd',
      bucketing: { enabled: true },
      catalog:   { enabled: true, filename: 'my-catalog.xml' },
    };
    const ok = validate(cfg);
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('accepts catalog with prefer=system', () => {
    const cfg = {
      kind:    'file',
      path:    './graphs/aonprd',
      bucketing: { enabled: true },
      catalog:   { enabled: true, prefer: 'system' },
    };
    const ok = validate(cfg);
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('rejects unknown prefer value', () => {
    const cfg = {
      kind:    'file',
      path:    './graphs/aonprd',
      bucketing: { enabled: true },
      catalog:   { enabled: true, prefer: 'unknown' },
    };
    const ok = validate(cfg);
    assert.equal(ok, false, 'unknown prefer value should fail');
  });

  it('accepts rewriteRoots array', () => {
    const cfg = {
      kind:    'file',
      path:    './graphs/aonprd',
      bucketing: { enabled: true },
      catalog:   {
        enabled: true,
        rewriteRoots: [
          { uriStartString: 'https://example.org/graph/', rewritePrefix: './' },
        ],
      },
    };
    const ok = validate(cfg);
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('rejects rewriteRoots item missing required fields', () => {
    const cfg = {
      kind:    'file',
      path:    './graphs/aonprd',
      bucketing: { enabled: true },
      catalog:   {
        enabled: true,
        rewriteRoots: [{ uriStartString: 'https://example.org/' }],
      },
    };
    const ok = validate(cfg);
    assert.equal(ok, false, 'rewriteRoots item missing rewritePrefix should fail');
  });

  it('rejects additional properties in catalog', () => {
    const cfg = {
      kind:    'file',
      path:    './graphs/aonprd',
      bucketing: { enabled: true },
      catalog:   { enabled: true, unknownProp: 'bad' },
    };
    const ok = validate(cfg);
    assert.equal(ok, false, 'unknown catalog property should fail');
  });
});
