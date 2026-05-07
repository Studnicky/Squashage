import test from 'node:test';
import assert from 'node:assert/strict';
 
import { Writer } from 'n3';
 
import datafactory from '@rdfjs/data-model';

test('n3.Writer serializes a quad', async () => {
  const w = new Writer({ format: 'N-Triples' });
  w.addQuad(datafactory.quad(
    datafactory.namedNode('http://example.org/s'),
    datafactory.namedNode('http://example.org/p'),
    datafactory.literal('o'),
  ));
  const out: string = await new Promise((res, rej) => w.end((e, r) => e ? rej(e) : res(r as string)));
  assert.match(out, /<http:\/\/example.org\/s>/);
});
