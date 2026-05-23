---
layout: doc
title: Getting Started
description: Install Squashage from source, run the Pathfinder AONPRD demo, and open the self-contained interactive graph in any browser.
---

# Getting Started

Squashage is not on npm yet. Clone, install, build.

## Install

```bash
git clone https://github.com/Studnicky/Squashage.git
cd Squashage
npm install
npm run build
```

## Run a build

The CLI binary is `squashage-dag`:

```bash
npx squashage-dag build \
  --target aonprd \
  --config squashage.config.json
```

Or invoke it directly during development:

```bash
node --import tsx src/cli/dagonizerCli.ts build \
  --target aonprd \
  --config squashage.config.json
```

Three files land in `./graphs/<target>/`:

| File | What's in it |
|---|---|
| `<output.path>` | the success graph |
| `<output.path-stem>.prov.<ext>` | PROV-O activity quads, one `prov:Activity` per node |
| `quarantine/<bucket>/<id>.json` | one file per failed record (`unknown`, `conflicts`, `projection`, `output`) |

## Build a config

Copy `squashage.config.example.json` as a starting point. The unprefixed file is gitignored.

The shape is described in [Configuration](./usage/configuration).

## Render the JSON-LD as a graph

```bash
npx squashage-dag viz \
  --in ./graphs/aonprd.jsonld \
  --out aonprd
```

Writes a chunked WebGL graph (sigma + ForceAtlas2) to `./aonprd/` next to the input. Open `aonprd.html` in any browser.

## Where to look next

- [Walk-through](./walk-through) — a record's full journey through the DAG.
- [DAG](./usage/pipeline) — the run-scope + per-record DAGs in full.
- [Configuration](./usage/configuration) — every config slot.
- [Classifier cascade](./usage/classifier-cascade) — the ten classifiers + the conflict resolver.
- [Plugins](./usage/plugins) — how to ship a target-specific squash node.
- [Architecture](./architecture) — module map + class lineage.
