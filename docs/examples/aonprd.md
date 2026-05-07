---
layout: doc
title: Pathfinder/AONPRD Demo
---

# Pathfinder/AONPRD Graph Demo

An interactive cytoscape graph of the Pathfinder Second Edition (Archives of Nethys) fixture data produced by the squashage pipeline.

Nodes are coloured by RDF class (feat, spell, monster, action, equipment). Edges show object-property links (`rarity`, `trait`, `tradition`, `actionCost`). Click any node to see its properties in the sidebar. The canvas is zoomable and pannable.

<iframe
  src="/Squashage/examples/aonprd/aonprd.html"
  style="width:100%;height:80vh;border:0;border-radius:4px;"
  title="Pathfinder/AONPRD graph demo"
></iframe>

---

To regenerate this demo from the fixture data:

```bash
npm run viz:demo
```

Or render any squashage JSON-LD output as a standalone offline graph:

```bash
squashage viz --in ./graphs/aonprd.jsonld --out aonprd.html --title "My Graph"
```

The standalone HTML file (`docs/public/examples/aonprd/aonprd.html`) runs entirely offline — no network access, no Node.js, no `node_modules` required at display time. Open it in any browser.
