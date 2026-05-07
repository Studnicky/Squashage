import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FILE_EXTENSIONS,
  MIME_TYPES,
  RDF_FORMATS,
  Formats,
} from '../../../src/rdf/Formats.js';

describe('FILE_EXTENSIONS', () => {
  it('maps turtle to .ttl', () => {
    assert.equal(FILE_EXTENSIONS['turtle'], '.ttl');
  });

  it('maps trig to .trig', () => {
    assert.equal(FILE_EXTENSIONS['trig'], '.trig');
  });

  it('maps ntriples to .nt', () => {
    assert.equal(FILE_EXTENSIONS['ntriples'], '.nt');
  });

  it('maps nquads to .nq', () => {
    assert.equal(FILE_EXTENSIONS['nquads'], '.nq');
  });

  it('maps jsonld to .jsonld', () => {
    assert.equal(FILE_EXTENSIONS['jsonld'], '.jsonld');
  });
});

describe('MIME_TYPES', () => {
  it('maps turtle to text/turtle', () => {
    assert.equal(MIME_TYPES['turtle'], 'text/turtle');
  });

  it('maps trig to application/trig', () => {
    assert.equal(MIME_TYPES['trig'], 'application/trig');
  });

  it('maps ntriples to application/n-triples', () => {
    assert.equal(MIME_TYPES['ntriples'], 'application/n-triples');
  });

  it('maps nquads to application/n-quads', () => {
    assert.equal(MIME_TYPES['nquads'], 'application/n-quads');
  });

  it('maps jsonld to application/ld+json', () => {
    assert.equal(MIME_TYPES['jsonld'], 'application/ld+json');
  });
});

describe('RDF_FORMATS', () => {
  it('contains exactly the five v0.x formats in priority order', () => {
    assert.deepEqual(Array.from(RDF_FORMATS), ['turtle', 'trig', 'ntriples', 'nquads', 'jsonld']);
  });

  it('is readonly / frozen', () => {
    assert.equal(Object.isFrozen(RDF_FORMATS), true);
  });
});

describe('Formats.formatFromExtension', () => {
  it('returns turtle for .ttl', () => {
    assert.equal(Formats.formatFromExtension('foo.ttl'), 'turtle');
  });

  it('returns trig for .trig', () => {
    assert.equal(Formats.formatFromExtension('foo.trig'), 'trig');
  });

  it('returns ntriples for .nt', () => {
    assert.equal(Formats.formatFromExtension('foo.nt'), 'ntriples');
  });

  it('returns nquads for .nq', () => {
    assert.equal(Formats.formatFromExtension('foo.nq'), 'nquads');
  });

  it('returns jsonld for .jsonld', () => {
    assert.equal(Formats.formatFromExtension('foo.jsonld'), 'jsonld');
  });

  it('is case-insensitive — .TTL returns turtle', () => {
    assert.equal(Formats.formatFromExtension('foo.TTL'), 'turtle');
  });

  it('is case-insensitive — .TRIG returns trig', () => {
    assert.equal(Formats.formatFromExtension('data.TRIG'), 'trig');
  });

  it('returns undefined for an unknown extension', () => {
    assert.equal(Formats.formatFromExtension('foo.csv'), undefined);
  });

  it('returns undefined for .json (only .jsonld is recognised)', () => {
    assert.equal(Formats.formatFromExtension('foo.json'), undefined);
  });

  it('returns undefined for a path with no extension', () => {
    assert.equal(Formats.formatFromExtension('noextension'), undefined);
  });

  it('handles a path with multiple dots correctly', () => {
    assert.equal(Formats.formatFromExtension('bulk.data.nq'), 'nquads');
  });
});

describe('Formats.extensionForFormat', () => {
  it('returns .ttl for turtle', () => {
    assert.equal(Formats.extensionForFormat('turtle'), '.ttl');
  });

  it('returns .jsonld for jsonld', () => {
    assert.equal(Formats.extensionForFormat('jsonld'), '.jsonld');
  });
});

describe('Formats.mimeForFormat', () => {
  it('returns application/n-quads for nquads', () => {
    assert.equal(Formats.mimeForFormat('nquads'), 'application/n-quads');
  });

  it('returns text/turtle for turtle', () => {
    assert.equal(Formats.mimeForFormat('turtle'), 'text/turtle');
  });
});

describe('Formats.supportsQuads', () => {
  it('trig supports quads', () => {
    assert.equal(Formats.supportsQuads('trig'), true);
  });

  it('nquads supports quads', () => {
    assert.equal(Formats.supportsQuads('nquads'), true);
  });

  it('jsonld supports quads', () => {
    assert.equal(Formats.supportsQuads('jsonld'), true);
  });

  it('turtle does not support quads', () => {
    assert.equal(Formats.supportsQuads('turtle'), false);
  });

  it('ntriples does not support quads', () => {
    assert.equal(Formats.supportsQuads('ntriples'), false);
  });
});

describe('Formats.isRdfFormat', () => {
  it('returns true for turtle', () => {
    assert.equal(Formats.isRdfFormat('turtle'), true);
  });

  it('returns true for trig', () => {
    assert.equal(Formats.isRdfFormat('trig'), true);
  });

  it('returns true for ntriples', () => {
    assert.equal(Formats.isRdfFormat('ntriples'), true);
  });

  it('returns true for nquads', () => {
    assert.equal(Formats.isRdfFormat('nquads'), true);
  });

  it('returns true for jsonld', () => {
    assert.equal(Formats.isRdfFormat('jsonld'), true);
  });

  it('returns false for rdfxml', () => {
    assert.equal(Formats.isRdfFormat('rdfxml'), false);
  });

  it('returns false for n3', () => {
    assert.equal(Formats.isRdfFormat('n3'), false);
  });

  it('returns false for a number', () => {
    assert.equal(Formats.isRdfFormat(42), false);
  });

  it('returns false for null', () => {
    assert.equal(Formats.isRdfFormat(null), false);
  });

  it('returns false for an empty string', () => {
    assert.equal(Formats.isRdfFormat(''), false);
  });
});
