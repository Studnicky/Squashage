---
layout: doc
title: Plugins
description: Squashage exposes one plugin slot — the per-target squash node. Plugins ship a NodeInterface and inject it via SquashageRun's squashNode option.
---

# Plugins

Squashage has one extension slot: the per-target **squash node**. Everything else (classifiers, conflict resolution, finalize, catalog emit, provenance) is fixed by the DAG topology.

A squash plugin reads a classified record (`state.classification` and `state.input`) and emits typed RDF quads. The framework provides a `defaultSquashNode` that emits a single `rdf:type` triple keyed by the classification's class IRI. Real targets ship their own.

## The contract

```ts
import type { NodeInterface } from '@noocodex/dagonizer';
import type { SquashageServices } from '@studnicky/squashage/services/SquashageServices';
import type { SquashageRecordState } from '@studnicky/squashage/state/SquashageRecordState';

export type SquashOutput = 'squashed' | 'quarantined';
export type SquashNodeInterface =
  NodeInterface<SquashageRecordState, SquashOutput, SquashageServices>;
```

Your plugin module exports a const-literal `NodeInterface` with `name: 'squash'`. Two outputs:

- `squashed` — emit one or more quads into `state.squashedQuads` AND `services.dataset`; route to `output-provenance`.
- `quarantined` — collect an error, set `state.quarantineBucket = 'projection'`, route to `record-quarantine`.

```ts
// plugins/aonprd/squash.ts
import type { Quad } from '@rdfjs/types';
import type { SquashNodeInterface } from '@studnicky/squashage/nodes/record/squashNode';

export const aonprdSquashNode: SquashNodeInterface = {
  name:    'squash',
  outputs: ['squashed', 'quarantined'],
  async execute(state, context) {
    if (state.classification === null) {
      state.collectError({
        code:        'AONPRD_NO_CLASSIFICATION',
        message:     'aonprd squash invoked without a classification',
        operation:   'squash',
        recoverable: false,
        timestamp:   new Date().toISOString(),
      });
      state.quarantineBucket = 'projection';
      return { output: 'quarantined' };
    }

    const quads: Quad[] = [];
    // ... build quads from state.input and state.classification ...

    (state as unknown as { squashedQuads: Quad[] }).squashedQuads = quads;
    for (const q of quads) context.services.dataset.add(q);

    return { output: 'squashed' };
  },
};
```

## Wiring

The CLI builds `SquashageRun` from the config file; to register your plugin you instead construct the run directly:

```ts
import { SquashageRun }    from '@studnicky/squashage/SquashageRun';
import { SquashageConfig } from '@studnicky/squashage/config/SquashageConfig';
import { aonprdSquashNode } from './plugins/aonprd/squash.js';

const config = SquashageConfig.loadFromFile('./squashage.config.json');
const target = config.targets['aonprd'];

const run = await SquashageRun.forTarget({
  target:       'aonprd',
  targetConfig: target,
  output:       target.output,
  outDir:       './graphs',
  schemasBase:  '.',
  squashNode:   aonprdSquashNode,   // <-- inject here
});

const result = await run.execute();
```

When `squashNode` is omitted, the run uses `defaultSquashNode`, which emits one `<record> rdf:type <classIri>` quad and nothing else.

## What services you have

`context.services` carries the full bag:

| Field | Use it when |
|---|---|
| `services.factory` | minting `NamedNode` / `Literal` / `Quad` / `BlankNode` |
| `services.dataset` | adding quads to the run-wide dataset (`services.dataset.add(quad)`) |
| `services.builder` | convenience wrapper for building quads against the target's base IRI |
| `services.prefixes` | resolved (instance, graph, vocabulary) base IRIs |
| `services.iri` | `NamespaceBuilder` over the vocabulary base — `services.iri('Feat')` returns a `NamedNode` |
| `services.graphs` | named-graph `NamedNode` map (per-target lanes) |
| `services.ontology` | optional `JsonTologyOntology` instance — null when not configured |
| `services.ajv` | run-wide AJV instance for per-record schema work |
| `services.logger` | `services.logger.forComponent('aonprd-squash')` for component-scoped logging |

## Never throw

Per the dagonizer contract, nodes don't throw. Catch every error, call `state.collectError(...)`, and route to `quarantined`. The dispatcher records the error onto state and routes through the DAG so other records in the fan-out aren't affected.

## State mutation

`state.squashedQuads` is `readonly` in the type but the value field is mutable through a cast — squash nodes assign a fresh array. Per-record streaming consumers iterate this slot to flush quads as they emit.

## See also

- [DAG](./pipeline) — where the squash node sits.
- [Output](./output) — how `rdfjs-finalize` serializes the dataset.
- [Provenance](./provenance) — observer hooks that fire around your node.
