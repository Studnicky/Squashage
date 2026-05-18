/**
 * @fileoverview Unit tests for {@link OasisCatalog}.
 *
 * Tests cover:
 * - XML well-formedness (declaration, root element, namespace)
 * - <uri> entries with relative paths
 * - <rewriteURI> entries
 * - <system> entries
 * - <public> entries
 * - <systemSuffix> entries
 * - XML special-char escaping in IRI values
 * - prefer attribute
 * - Default-graph sentinel handling (via defaultGraphCatalogIri convention)
 * - Empty entries list
 *
 * @module tests/unit/output/OasisCatalog.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OasisCatalog } from '../../../src/output/OasisCatalog.js';
import type {
  CatalogEntryInterface,
  UriEntryInterface,
  RewriteUriEntryInterface,
} from '../../../src/output/OasisCatalog.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple check: does the XML start with the declaration? */
function hasXmlDecl(xml: string): boolean {
  return xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>');
}

/** Returns the value of a named attribute in an XML string. */
function attrValue(xml: string, attr: string): string | undefined {
  const re = new RegExp(`${attr}="([^"]*)"`, 'g');
  const m = re.exec(xml);
  return m?.[1];
}

/** Returns all occurrences of an element tag. */
function countElements(xml: string, tag: string): number {
  const re = new RegExp(`<${tag}\\s`, 'g');
  return (xml.match(re) ?? []).length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OasisCatalog.escape', () => {
  it('escapes & → &amp;', () => {
    assert.equal(OasisCatalog.escape('a&b'), 'a&amp;b');
  });
  it('escapes < → &lt;', () => {
    assert.equal(OasisCatalog.escape('a<b'), 'a&lt;b');
  });
  it('escapes > → &gt;', () => {
    assert.equal(OasisCatalog.escape('a>b'), 'a&gt;b');
  });
  it('escapes " → &quot;', () => {
    assert.equal(OasisCatalog.escape('"val"'), '&quot;val&quot;');
  });
  it("escapes ' → &apos;", () => {
    assert.equal(OasisCatalog.escape("it's"), 'it&apos;s');
  });
  it('leaves plain strings untouched', () => {
    assert.equal(OasisCatalog.escape('https://example.org/graph/a'), 'https://example.org/graph/a');
  });
  it('escapes multiple special chars', () => {
    assert.equal(OasisCatalog.escape('<a&b>'), '&lt;a&amp;b&gt;');
  });
});

describe('OasisCatalog.build — empty entries', () => {
  it('produces valid XML with root element and no children', () => {
    const xml = OasisCatalog.build([]);
    assert.ok(hasXmlDecl(xml));
    assert.ok(xml.includes('<catalog '));
    assert.ok(xml.includes('</catalog>'));
    assert.ok(xml.includes('urn:oasis:names:tc:entity:xmlns:xml:catalog'));
  });

  it('uses prefer="public" by default', () => {
    const xml = OasisCatalog.build([]);
    assert.equal(attrValue(xml, 'prefer'), 'public');
  });

  it('respects prefer="system" option', () => {
    const xml = OasisCatalog.build([], { prefer: 'system' });
    assert.equal(attrValue(xml, 'prefer'), 'system');
  });
});

describe('OasisCatalog.build — <uri> entries', () => {
  it('emits one <uri> per entry', () => {
    const entries: UriEntryInterface[] = [
      { kind: 'uri', name: 'https://example.org/graph/a', uri: './graph-a.trig' },
      { kind: 'uri', name: 'https://example.org/graph/b', uri: './graph-b.trig' },
    ];
    const xml = OasisCatalog.build(entries);
    assert.equal(countElements(xml, 'uri'), 2);
  });

  it('uri name attribute contains the graph IRI', () => {
    const xml = OasisCatalog.build([
      { kind: 'uri', name: 'https://example.org/graph/feats', uri: './feats.trig' },
    ]);
    assert.ok(xml.includes('name="https://example.org/graph/feats"'));
    assert.ok(xml.includes('uri="./feats.trig"'));
  });

  it('escapes IRIs with special characters', () => {
    const xml = OasisCatalog.build([
      { kind: 'uri', name: 'https://example.org/graph/a&b', uri: './a-b.trig' },
    ]);
    assert.ok(xml.includes('name="https://example.org/graph/a&amp;b"'));
  });

  it('does NOT include default-graph entry by default', () => {
    // The default graph has no IRI; OasisCatalog does not automatically inject one.
    // The caller is responsible for omitting default-graph entries.
    const entries: CatalogEntryInterface[] = [
      { kind: 'uri', name: 'https://example.org/graph/a', uri: './a.trig' },
    ];
    const xml = OasisCatalog.build(entries);
    // Should not contain any '__default__' reference
    assert.ok(!xml.includes('__default__'));
  });

  it('includes default-graph entry when caller provides defaultGraphCatalogIri', () => {
    // The caller (emitCatalog task) adds this entry when bucketing.defaultGraphCatalogIri is set
    const entries: CatalogEntryInterface[] = [
      { kind: 'uri', name: 'urn:x-arq:DefaultGraphNode', uri: './default.trig' },
    ];
    const xml = OasisCatalog.build(entries);
    assert.ok(xml.includes('name="urn:x-arq:DefaultGraphNode"'));
    assert.ok(xml.includes('uri="./default.trig"'));
  });
});

describe('OasisCatalog.build — <rewriteURI> entries', () => {
  it('emits <rewriteURI> with correct attributes', () => {
    const xml = OasisCatalog.build([
      { kind: 'rewriteURI', uriStartString: 'https://example.org/graph/', rewritePrefix: './' },
    ]);
    assert.ok(xml.includes('<rewriteURI '));
    assert.ok(xml.includes('uriStartString="https://example.org/graph/"'));
    assert.ok(xml.includes('rewritePrefix="./"'));
  });
});

describe('OasisCatalog.build — <system> entries', () => {
  it('emits <system> with correct attributes', () => {
    const xml = OasisCatalog.build([
      { kind: 'system', systemId: 'https://example.org/context.jsonld', uri: './context.jsonld' },
    ]);
    assert.ok(xml.includes('<system '));
    assert.ok(xml.includes('systemId="https://example.org/context.jsonld"'));
    assert.ok(xml.includes('uri="./context.jsonld"'));
  });
});

describe('OasisCatalog.build — <public> entries', () => {
  it('emits <public> with correct attributes', () => {
    const xml = OasisCatalog.build([
      { kind: 'public', publicId: 'https://example.org/ontology', uri: './ontology.ttl' },
    ]);
    assert.ok(xml.includes('<public '));
    assert.ok(xml.includes('publicId="https://example.org/ontology"'));
    assert.ok(xml.includes('uri="./ontology.ttl"'));
  });
});

describe('OasisCatalog.build — <systemSuffix> entries', () => {
  it('emits <systemSuffix> with correct attributes', () => {
    const xml = OasisCatalog.build([
      { kind: 'systemSuffix', systemIdSuffix: '.jsonld', uri: './context.jsonld' },
    ]);
    assert.ok(xml.includes('<systemSuffix '));
    assert.ok(xml.includes('systemIdSuffix=".jsonld"'));
    assert.ok(xml.includes('uri="./context.jsonld"'));
  });
});

describe('OasisCatalog.build — mixed entries', () => {
  it('preserves entry order', () => {
    const entries: CatalogEntryInterface[] = [
      { kind: 'uri',        name: 'https://example.org/graph/a', uri: './a.trig' },
      { kind: 'rewriteURI', uriStartString: 'https://example.org/graph/', rewritePrefix: './' },
      { kind: 'system',     systemId: 'https://example.org/ctx.jsonld', uri: './ctx.jsonld' },
    ];
    const xml = OasisCatalog.build(entries);

    const uriIdx     = xml.indexOf('<uri ');
    const rewriteIdx = xml.indexOf('<rewriteURI ');
    const systemIdx  = xml.indexOf('<system ');

    assert.ok(uriIdx < rewriteIdx, 'uri should appear before rewriteURI');
    assert.ok(rewriteIdx < systemIdx, 'rewriteURI should appear before system');
  });

  it('produces well-formed XML with multiple entry types', () => {
    const entries: CatalogEntryInterface[] = [
      { kind: 'uri',    name: 'https://example.org/graph/feats', uri: './feats.trig' },
      { kind: 'public', publicId: 'https://example.org/onto',    uri: './onto.ttl' },
    ];
    const xml = OasisCatalog.build(entries);

    // Must have exactly one root element (start/end tags)
    assert.equal((xml.match(/<catalog/g) ?? []).length, 1);
    assert.equal((xml.match(/<\/catalog>/g) ?? []).length, 1);

    // Must end with newline
    assert.ok(xml.endsWith('\n'));
  });
});

describe('OasisCatalog.build — XML namespace', () => {
  it('root element declares the OASIS namespace', () => {
    const xml = OasisCatalog.build([]);
    assert.ok(xml.includes('xmlns="urn:oasis:names:tc:entity:xmlns:xml:catalog"'));
  });
});

describe('OasisCatalog.build — rewriteRoots from config', () => {
  it('multiple <rewriteURI> entries work correctly', () => {
    const entries: RewriteUriEntryInterface[] = [
      { kind: 'rewriteURI', uriStartString: 'https://a.org/', rewritePrefix: './a/' },
      { kind: 'rewriteURI', uriStartString: 'https://b.org/', rewritePrefix: './b/' },
    ];
    const xml = OasisCatalog.build(entries);
    assert.equal(countElements(xml, 'rewriteURI'), 2);
    assert.ok(xml.includes('./a/'));
    assert.ok(xml.includes('./b/'));
  });
});
