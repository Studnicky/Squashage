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

The CLI binary is `squashage-dag`. A config file is one run:

```bash
npx squashage-dag build \
  --config squashage.config.json
```

Or invoke it directly during development:

```bash
node --import tsx src/cli/dagonizerCli.ts build \
  --config squashage.config.json
```

Three artifacts land on disk, anchored at `output.path`:

| File | What's in it |
|---|---|
| `<output.path>` | the success graph |
| `<output.path-stem>.prov.<ext>` | PROV-O activity quads, one `prov:Activity` per node |
| `quarantine/<bucket>/<id>.json` | one file per failed record (`unknown`, `conflicts`, `projection`, `output`) |

## Build a config

A config file is one run. The root object holds `input`, `output`, and the run knobs directly:

```jsonc
{
  "input":  { "basePath": "./input", "format": "json" },
  "output": { "type": "file", "path": "./graphs/out.trig", "format": "trig" },
  "concurrency": 4,
  "graphs": { "default": "https://example.org/graph/default" },
  "ontology": { "baseIri": "https://example.org/" },
  "classification": { "source": true }
}
```

Copy `squashage.config.example.json` as a starting point. The unprefixed file is gitignored.

The full shape is described in [Configuration](./usage/configuration).

## Render the graph

```bash
npx squashage-dag viz \
  --in ./graphs/aonprd.nq \
  --out aonprd
```

Reads an `.nq` file and emits a self-contained cosmos.gl WebGL graph browser to `./aonprd/`. Open `aonprd.html` in any browser. The viewer ships with a d-pad, node inspector, highlight, physics panel, and continuous simulation.

## Where to look next

- [Walk-through](./walk-through) — a record's full journey through the DAG.
- [DAG](./usage/pipeline) — the run-scope + per-record DAGs in full.
- [Configuration](./usage/configuration) — every config slot.
- [Classifier cascade](./usage/classifier-cascade) — the ten classifiers + the conflict resolver.
- [Plugins](./usage/plugins) — how to ship a target-specific squash node.
- [Architecture](./architecture) — module map + class lineage.
