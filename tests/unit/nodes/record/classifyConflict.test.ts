import test from 'node:test';
import assert from 'node:assert/strict';

import { Batch } from '@studnicky/dagonizer';
import { ClassifyConflictNode } from '../../../../src/nodes/record/classifyConflict.js';
import { SquashageRecordState } from '../../../../src/state/SquashageRecordState.js';
import type { SquashageServices } from '../../../../src/services/SquashageServices.js';

const source = { target: 'aonprd', path: '/r/a.json' } as const;
const ctx = { services: {} as SquashageServices };

async function runNode(
  node: ClassifyConflictNode,
  state: SquashageRecordState,
  context: { services: SquashageServices },
): Promise<string> {
  const result = await node.execute(
    Batch.of(state),
    context as unknown as Parameters<typeof node.execute>[1],
  );
  const keys = [...result.keys()];
  if (keys.length === 0) throw new Error('node produced no output port');
  return keys[0] as string;
}

test('happy path', async (t) => {
  await t.test('single agreeing classifier → resolved', async () => {
    const node = new ClassifyConflictNode({ onConflict: 'quarantine', evidence: true });
    const s = new SquashageRecordState(source, '/r/a.json', 0);
    s.proposals['classify:rules'] = {
      source: 'classify:rules', className: 'feat', priority: 20, confidence: 1, reasons: ['r1'],
    };
    const out = await runNode(node, s, ctx);
    assert.equal(out, 'resolved');
    assert.equal(s.classification?.type, 'feat');
    assert.equal(s.classification?.engine, 'classify:rules');
  });

  await t.test('two classifiers agree → resolved with joined engine', async () => {
    const node = new ClassifyConflictNode({ onConflict: 'quarantine', evidence: true });
    const s = new SquashageRecordState(source, '/r/a.json', 0);
    s.proposals['classify:rules'] = { source: 'classify:rules', className: 'feat', priority: 20, confidence: 1, reasons: ['r1'] };
    s.proposals['classify:structural'] = { source: 'classify:structural', className: 'feat', priority: 10, confidence: 1, reasons: ['r2'] };
    const out = await runNode(node, s, ctx);
    assert.equal(out, 'resolved');
    assert.equal(s.classification?.type, 'feat');
    assert.match(s.classification!.engine, /classify:rules.*classify:structural|classify:structural.*classify:rules/);
  });
});

test('edge cases', async (t) => {
  await t.test('different classes with clear priority winner → resolved', async () => {
    const node = new ClassifyConflictNode({ onConflict: 'quarantine', evidence: false });
    const s = new SquashageRecordState(source, '/r/a.json', 0);
    s.proposals['a'] = { source: 'a', className: 'feat',  priority: 20, confidence: 1, reasons: [] };
    s.proposals['b'] = { source: 'b', className: 'spell', priority: 10, confidence: 1, reasons: [] };
    const out = await runNode(node, s, ctx);
    assert.equal(out, 'resolved');
    assert.equal(s.classification?.type, 'feat');
  });

  await t.test('only sentinel proposals → unknown', async () => {
    const node = new ClassifyConflictNode({ onConflict: 'quarantine', evidence: true });
    const s = new SquashageRecordState(source, '/r/a.json', 0);
    s.proposals['x'] = { source: 'x', className: '__source__', priority: 0, confidence: 1, reasons: [] };
    const out = await runNode(node, s, ctx);
    assert.equal(out, 'unknown');
    assert.equal(s.quarantineBucket, 'unknown');
    assert.equal(s.classification, null);
  });
});

test('unhappy path', async (t) => {
  await t.test('tie at top priority + quarantine policy → tie', async () => {
    const node = new ClassifyConflictNode({ onConflict: 'quarantine', evidence: false });
    const s = new SquashageRecordState(source, '/r/a.json', 0);
    s.proposals['a'] = { source: 'a', className: 'feat',  priority: 20, confidence: 1, reasons: [] };
    s.proposals['b'] = { source: 'b', className: 'spell', priority: 20, confidence: 1, reasons: [] };
    const out = await runNode(node, s, ctx);
    assert.equal(out, 'tie');
    assert.equal(s.quarantineBucket, 'conflicts');
  });

  await t.test('tie at top priority + pickPriority → lex-first wins, candidates listed', async () => {
    const node = new ClassifyConflictNode({ onConflict: 'pickPriority', evidence: false });
    const s = new SquashageRecordState(source, '/r/a.json', 0);
    s.proposals['a'] = { source: 'a', className: 'feat',  priority: 20, confidence: 1, reasons: [] };
    s.proposals['b'] = { source: 'b', className: 'spell', priority: 20, confidence: 1, reasons: [] };
    const out = await runNode(node, s, ctx);
    assert.equal(out, 'resolved');
    assert.equal(s.classification?.type, 'feat');
    assert.deepEqual(s.classification?.candidates, ['feat', 'spell']);
  });
});
