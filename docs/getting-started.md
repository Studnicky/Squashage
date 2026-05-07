# Getting Started

Squashage is not on npm yet. Clone the repo, install, and build.

## Install

```bash
git clone https://github.com/Studnicky/Squashage.git
cd Squashage
npm install
npm run build
```

## Run against the Pathfinder fixture

The AONPRD fixture lives under `tests/e2e/aonprd/`. To run the full demo
build (pipeline + cytoscape render):

```bash
npm run viz:demo
```

This writes two files:

- `docs/examples/aonprd/aonprd.jsonld`: the raw JSON-LD output
- `docs/examples/aonprd/aonprd.html`: the self-contained interactive graph

Open `aonprd.html` in any browser. No network required.

## Render any JSON-LD output

```bash
squashage viz \
  --in ./graphs/mybuild.jsonld \
  --out mybuild.html \
  --title "My Graph"
```

## Run a build from config

```bash
squashage build \
  --target aonprd \
  --config squashage.config.json \
  --in ./output/aonprd
```

Copy `squashage.config.example.json` as a starting point. The unprefixed
file is gitignored.

## Where to look next

- [Architecture](./architecture.md); pipeline phases, package boundaries, output contract
- [Classifier engines](./classification-engines.md); the six task classes, the predicate language, what was considered and rejected
- [Configuration](./usage/configuration); full config schema walkthrough
- [Classifier engines](./classification-engines); the six task classes and the predicate language
