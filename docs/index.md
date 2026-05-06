---
layout: doc
title: Squashage
---

<div style="text-align:center;padding:2rem 0 1rem">
  <img src="/squashage.png" alt="Squashage" style="max-width:120px;margin:0 auto 1rem" />
  <h1 style="font-size:2.5rem;font-weight:700;margin:0.5rem 0">Squashage</h1>
  <p style="font-size:1.2rem;color:var(--vp-c-text-2);max-width:600px;margin:0 auto 1.5rem">Squashes JSON into graph sausage. Feed it structured JSON records. It classifies each one, reconstitutes the lot into a deterministic RDF graph, and squashes the result into a single file you can actually serve; Turtle, TriG, N-Triples, N-Quads, or JSON-LD.</p>
  <div style="display:flex;gap:0.75rem;justify-content:center;flex-wrap:wrap;margin-bottom:2rem">
    <a href="/Squashage/getting-started" class="VPButton medium brand" style="text-decoration:none;padding:0.5rem 1.25rem;border-radius:4px;background:var(--vp-button-brand-bg);color:var(--vp-button-brand-text);font-weight:500">Get started</a>
    <a href="/Squashage/walk-through" class="VPButton medium brand" style="text-decoration:none;padding:0.5rem 1.25rem;border-radius:4px;background:var(--vp-button-brand-bg);color:var(--vp-button-brand-text);font-weight:500">Walk-through</a>
    <a href="/Squashage/examples/aonprd" class="VPButton medium alt" style="text-decoration:none;padding:0.5rem 1.25rem;border-radius:4px;background:var(--vp-button-alt-bg);color:var(--vp-button-alt-text);font-weight:500">Live demo</a>
    <a href="https://github.com/Studnicky/Squashage" class="VPButton medium alt" style="text-decoration:none;padding:0.5rem 1.25rem;border-radius:4px;background:var(--vp-button-alt-bg);color:var(--vp-button-alt-text);font-weight:500">GitHub</a>
  </div>
</div>

You feed it JSON. It hands you back a graph. The graph has edges where you'd expect edges and types where you'd expect types, and it ends up in a single file you can stick on a webserver.

- **Same JSON in, same graph out.** No `Math.random`, no `Date.now`, no network after startup. Byte-identical across runs and machines.
- **One file, no fan-out.** A single build produces one serialized RDF file. Auto-derived instance/graph/vocabulary IRIs from `_source.url`. Auto-built JSON-LD `@context` from the produced quad set.
- **Open the demo offline.** The `squashage viz` CLI emits a self-contained HTML document with cytoscape inlined. Open it in any browser; no network, no `node_modules` required.

## Quick install

```bash
git clone https://github.com/Studnicky/Squashage.git
cd Squashage && npm install && npm run build
npm run viz:demo    # produces docs/public/examples/aonprd/aonprd.html
```

## Where to look next

- [Walk-through](./walk-through); end-to-end example with a real Pathfinder record, config, plugin, and JSON-LD output
- [Getting started](./getting-started); install and run the demo
- [Architecture](./architecture); pipeline phases, package boundaries, output contract
- [Classifier engines](./classification-engines); the six task classes, the predicate language
- [Live demo](./examples/aonprd); cytoscape graph of the Pathfinder/AONPRD fixture
