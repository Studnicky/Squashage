---
layout: doc
title: Viz
---

# Viz

```bash
squashage viz \
  --in ./graphs/mybuild.jsonld \
  --out mybuild.html \
  --title "My Graph"
```

Takes a JSON-LD file, produces a self-contained HTML document with sigma+graphology inlined. Open it in a browser. No network, no server, no `node_modules`.

## What you get

A two-pane layout:
- **Graph canvas** — sigma renders nodes and edges. Pan, zoom, click.
- **Detail sidebar** — click a node to see its IRI, class, and all outgoing predicates.
- **Node list** — alphabetical index of all nodes, grouped by class. Click to focus.

## How it works

The viz build happens in two stages: (1) `ChunkBuilder` reads the JSON-LD, deserializes it into a graphology `Graph`, runs force-directed layout to compute node positions, and chunks the result by size. (2) `SigmaGraphRenderer` emits a single ~170KB HTML file with the sigma+graphology bundles vendored inline as a JavaScript UMD bundle. At runtime, the HTML fetches `index.json` (chunk metadata), then each chunk file in ascending-size order, deserializing each into the graphology Graph. Sigma incrementally re-renders as chunks load. Positions are pre-computed at build time; the browser does no layout work.

## Color scheme

Node color is derived from the class IRI via a hash-to-hue function. Same class IRI → same color across every graph you render with the same version of squashage. The mapping is not configurable and not intended to be — consistency across builds matters more than custom palettes.

Edge color comes from the named graph IRI via the same mechanism. If you have three named graphs, you get three distinct edge colors.

No legend is generated automatically. The node list groups by class label, which serves the same purpose.

**Hash algorithm**: IRI → SHA256 hash → first 24 bits → hue (0–360°). Collision handling: if two IRIs hash to the same hue, they render the same color. This is rare and acceptable; the alternative (per-IRI user configuration) adds complexity with minimal benefit.

## Click interaction

Click a node on the canvas: the detail sidebar shows the node's `@id`, its class IRI (under `@type`), and all outgoing predicate-value pairs. Values that are named nodes are displayed as IRIs. Values that are literals are displayed with their datatype when present.

The same node in the node list is highlighted when you click it on the canvas.

**Keyboard shortcuts**: Arrow keys pan. Scroll wheel zooms. Escape clears selection. Right-click on a node: expand neighbors (fetches related nodes from the graph). These are standard sigma controls; they work offline and require no configuration.

## iframe embedding

The output file is self-contained — no external dependencies. Embed it in another page via `<iframe>`:

```html
<iframe
  src="./mybuild.html"
  width="100%"
  height="600px"
  style="border:none"
></iframe>
```

Serve it standalone from any static file server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

The file is an HTML document, not a VitePress component. It works anywhere a browser can open a local file.

## Vendor bundle

The sigma+graphology bundle is vendored into the package at `src/viz/vendor/sigmaBundle.ts`. It's inlined into every generated HTML file at build time. This is intentional — the point is offline operation.

To refresh the vendor bundle when a new sigma version ships:

```bash
npm run viz:refresh-vendor
```

This runs `scripts/refresh-viz-vendor.js`, which downloads the current sigma UMD bundle and overwrites `src/viz/vendor/sigmaBundle.ts`. After refreshing, rebuild the package (`npm run build`) to pick up the new bundle in subsequent `viz` runs.

**Scalability**: The chunked design keeps memory footprint bounded. A 1M-node graph chunks into ~50 files of ~20KB each. The browser loads chunks incrementally without buffering the full graph. Sigma's WebGL renderer re-paints as chunks arrive. Typical performance: 10K nodes render in <1s, 100K nodes in ~5s, 1M nodes in ~30s (on modern hardware; YMMV). The initial HTML is always ~170KB regardless of graph size.

## Demo

The Pathfinder/AONPRD graph lives at [examples/aonprd](../examples/aonprd) — built from the fixture in `tests/e2e/aonprd/` via `npm run viz:demo`.

## Related

- [Getting started](../getting-started) — running viz:demo for the first time
- [Output](./output) — JSON-LD output that feeds into viz
