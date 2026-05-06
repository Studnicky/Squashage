# Squashage

[![CI](https://github.com/Studnicky/Squashage/actions/workflows/ci.yml/badge.svg)](https://github.com/Studnicky/Squashage/actions/workflows/ci.yml)
[![docs](https://img.shields.io/badge/docs-studnicky.github.io-8b5fbf)](https://studnicky.github.io/Squashage/)
[![node](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen)](package.json)
[![version](https://img.shields.io/badge/version-0.1.0--beta.1-8b5fbf)](CHANGELOG.md)

Graph reconstitution pipeline. Feed it structured JSON records. It classifies each one, reconstitutes the lot into a deterministic RDF graph, and squashes the result into a single file you can actually serve.

**Upstream:** [Ripperoni](https://github.com/Studnicky/Ripperoni) produces the JSON records Squashage consumes. Pair them to go from raw web pages to structured RDF.

**[Documentation](https://studnicky.github.io/Squashage/)** · **[Architecture](https://studnicky.github.io/Squashage/architecture)** · **[Classifier engines](https://studnicky.github.io/Squashage/classification-engines)** · **[Demo](https://studnicky.github.io/Squashage/examples/aonprd/aonprd.html)** · **[Releases](https://github.com/Studnicky/Squashage/releases)**

---

## Requirements

- Node 24+
- TypeScript 5.7+

## Install

```bash
git clone https://github.com/Studnicky/Squashage.git
cd Squashage
npm install
npm run build
```

## Quickstart

```bash
# Run the full Pathfinder/AONPRD demo (pipeline + cytoscape render)
npm run viz:demo

# Build from a config
squashage build \
  --target aonprd \
  --config squashage.config.json \
  --in ./output/aonprd

# Override output path/format for a one-off run
squashage build --target aonprd --out ./graphs/aonprd.jsonld

# Render any squashage JSON-LD output as an offline HTML graph
squashage viz --in ./graphs/aonprd.jsonld --out aonprd.html --title "My Graph"
```

Copy `squashage.config.example.json` to `squashage.config.json` and edit. The unprefixed file is gitignored.

## Scripts

```bash
npm run build         # compile TypeScript
npm run typecheck     # tsc --noEmit
npm run lint          # eslint src/
npm run check         # typecheck + lint + unit tests
npm run docs:build    # build VitePress docs
npm run viz:demo      # rebuild the Pathfinder/AONPRD demo
```

## Goals

- Consume structured JSON input records from one file, a directory tree, or JSONL.
- Classify each input record into an ontology type with deterministic evidence.
- Normalize source-specific records into stable graph entities.
- Project records into RDF/JS quads using a thin wrapper over `@rdfjs/*`, `n3`, `jsonld`.
- Serialize the canonical dataset to a single RDF file per build run
  (v0.x: Turtle, TriG, N-Triples, N-Quads, JSON-LD; v1.x adds RDF/XML and N3).
- Run a deterministic, declaratively configured classifier cascade.

## Non-Goals

- Squashage does not scrape web pages.
- Squashage does not run probabilistic models in the build path.
- Squashage does not load graph stores. Hand the file to your loader of choice.
- Squashage does not fan out across multiple outputs. One build, one file.

## Config Sketch

```jsonc
{
  "targets": {
    "aonprd": {
      "input": "./output/aonprd",
      "pipeline": [
        "json:read",
        "classify:source",
        "classify:structural",
        "classify:rules",
        "classify:ontology",
        "classify:conflict",
        "aonprd:squash",
        "rdfjs:finalize"
      ],
      "output": {
        "kind": "file",
        "path": "./graphs/aonprd.jsonld"
      }
    }
  }
}
```

See the [full config reference](https://studnicky.github.io/Squashage/plans/13-file-output-and-semantics-integration) for all options.

## Plugins

Custom squash tasks register themselves with `TaskRegistry`:

```ts
import { TaskRegistry } from 'squashage/registry/TaskRegistry';

TaskRegistry.register('aonprd:squash', async (next, state) => {
  if (state.classification?.type !== 'feat') { await next(); return; }

  const ctx      = state.context!;
  const prefixes = ctx.prefixes;
  const subject  = ctx.factory.namedNode(
    `${prefixes.instances.base}${String(state.input['url'] ?? 'unknown')}`
  );
  ctx.dataset.add(ctx.factory.quad(
    subject,
    ctx.factory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
    ctx.factory.namedNode(`${prefixes.vocabulary.base}Feat`),
    ctx.factory.namedNode(`${prefixes.graphs.base}feat`),
  ));
  await next();
});
```

## Demo

Open [`docs/public/examples/aonprd/aonprd.html`](docs/public/examples/aonprd/aonprd.html) in
any browser to see the package's JSON-LD output rendered as an interactive graph.
Nodes are coloured by RDF class, edges show object-property links, and clicking
a node reveals its properties in the sidebar. The file runs entirely offline —
no network access, no Node.js, no `node_modules` required at display time.

To rebuild the demo from the fixture data:

```bash
npm run viz:demo
```

## License

UNLICENSED
