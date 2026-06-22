---
layout: doc
title: Viz
description: Squashage viz command — generate a self-contained cosmos.gl streaming graph browser from an N-Quads file. No network required; opens offline in any browser.
---

# Viz

```bash
squashage viz \
  --in ./graphs/aonprd.nq \
  --out aonprd.html \
  --title "AONPRD Graph"
```

Takes an N-Quads (`.nq`) file and produces a self-contained HTML document — a cosmos.gl streaming graph browser with the `@cosmos.gl/graph` WebGL renderer inlined. Open it in a browser. No network, no server, no `node_modules`.

## What you get

The `CosmosGraphRenderer` emits a single HTML document that streams the graph into a continuous WebGL simulation:

- **Graph canvas**: cosmos.gl renders nodes and edges with a continuous force simulation. Pan, zoom, click.
- **D-pad**: on-screen directional control to nudge the viewport.
- **Node inspector**: click a node to see its IRI, class, and all outgoing predicates.
- **Highlight**: focus a node and its neighbours; the rest dims.
- **Physics panel**: live controls for the simulation (repulsion, link distance, gravity, friction).

## How it works

The renderer parses the N-Quads input into a node/edge set, then emits one HTML file with the `@cosmos.gl/graph` bundle vendored inline as JavaScript. At runtime the document feeds the graph into the cosmos.gl WebGL renderer and runs a continuous simulation — positions settle live in the browser rather than being pre-baked. The simulation keeps running so you can drag nodes and watch the layout relax around them.

## Color scheme

Node color is derived from the class IRI via a hash-to-hue function. Same class IRI → same color across every graph you render with the same version of squashage. The mapping is not configurable and not intended to be; consistency across builds matters more than custom palettes.

Edge color comes from the named graph IRI via the same mechanism. If you have three named graphs, you get three distinct edge colors.

**Hash algorithm**: IRI → SHA256 hash → first 24 bits → hue (0–360°). Collision handling: if two IRIs hash to the same hue, they render the same color. This is rare and acceptable; the alternative (per-IRI user configuration) adds complexity with minimal benefit.

## Click interaction

Click a node on the canvas: the node inspector shows the node's `@id`, its class IRI (under `@type`), and all outgoing predicate-value pairs. Values that are named nodes are displayed as IRIs. Values that are literals are displayed with their datatype when present.

Highlight follows selection: the clicked node and its direct neighbours stay lit while the rest of the graph dims, so a single entity's edges are legible inside a dense field.

**Controls**: the d-pad pans. Scroll wheel zooms. Click a node to select and highlight. The physics panel adjusts the live simulation. These work offline and require no configuration.

## iframe embedding

The output file is self-contained; no external dependencies. Embed it in another page via `<iframe>`:

```html
<iframe
  src="./aonprd.html"
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

The `@cosmos.gl/graph` bundle is vendored into the package and inlined into every generated HTML file at build time. This is intentional; the point is offline operation.

**Scalability**: cosmos.gl runs the force simulation on the GPU, so node and edge counts scale into the hundreds of thousands while the simulation stays interactive. The graph data is embedded in the HTML document; the browser feeds it directly into the WebGL renderer with no network round-trips.

## Demo

The Pathfinder/AONPRD graph lives at [examples/aonprd](../examples/aonprd); built from the fixture in `tests/e2e/aonprd/` via `npm run viz:demo`.

## Related

- [Getting started](../getting-started); running viz:demo for the first time
- [Output](./output); the N-Quads output that feeds into viz
