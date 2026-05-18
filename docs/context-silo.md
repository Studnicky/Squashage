---
layout: doc
title: Context Silo
description: The Squashage plugin contract — well-known keys on PipelineContextInterface (run-wide) and PipelineStateInterface (per-record), with writer/reader guarantees for every key.
---

# Context Silo

Squashage's per-run context is the cross-plugin coordination protocol.
Every pipeline task — built-in or user-supplied — receives a shared
`PipelineContextInterface` (the run-wide silo) and a `PipelineStateInterface`
(the per-record silo). Plugins coordinate by reading and writing well-known
keys on these objects. There is no other coordination layer.

This document is the contract: the well-known keys, who writes them, when,
who consumes them, and what guarantees each consumer can rely on.

## Two silos

| Silo | Lifetime | Type | Purpose |
|------|----------|------|---------|
| Run-wide context | One run (per target) | `PipelineContextInterface` | Long-lived infrastructure: RDF factory, dataset, ontology engine, AJV instance, prefixes, output config |
| Per-record state | One record | `PipelineStateInterface` | The record itself, classification proposals, projection report, ad-hoc inter-task scratch slots |

`state.context` references the run-wide silo. The per-record silo extends
`Record<string, unknown>`, so plugins may attach private scratch keys for
inter-task handoff within a single record.

## Lifecycle phases

A run proceeds through three phases. Plugins declare which phase they
participate in.

```
┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│      onRunStart      │    │     per-record       │    │       onRunEnd       │
│  populates context   │───▶│  reads/writes state  │───▶│  finalizes outputs   │
│      (silo set)      │    │  reads context       │    │  (drains, writes)    │
└──────────────────────┘    └──────────────────────┘    └──────────────────────┘
```

| Phase | When | Plugin examples |
|-------|------|-----------------|
| `onRunStart` | Once per target, before any record flows | `context:logger`, `context:ajv`, `context:dataset`, `context:prefixes`, `context:ontology`, `context:run-time` |
| per-record | Once per input record (concurrent across records when `concurrency > 1`) | `json:read`, `classify:*`, `aonprd:squash`, `output:provenance` |
| `onRunEnd` | After all records settled, in declaration order | `enrich:entity-link`, `rdfjs:finalize`, `rdfjs:stream` finalize |

## Run-wide silo: well-known keys

All keys live on `state.context`. Each row names the producer (the plugin
that writes the key during `onRunStart`) and the typical consumers.

| Key | Type | Producer | Consumers | Notes |
|-----|------|----------|-----------|-------|
| `target` | `string` | orchestrator | every plugin | Target identifier; never mutates |
| `outDir` | `string` | orchestrator | `classify:conflict` (quarantine path), `rdfjs:finalize`, `output:provenance` | Run output base directory |
| `config` | frozen `Record<string, unknown>` | orchestrator | every plugin (read its own namespace) | Full target config block |
| `output` | `OutputConfigInterface` | orchestrator | `rdfjs:finalize`, `rdfjs:stream`, `output:provenance` | Resolved output config (post-CLI-merge) |
| `logger` | `LoggerFactoryInterface` | `context:logger` | every plugin | Pre-scoped logger factory; `ctx.logger.forComponent('MyPlugin')` |
| `ajv` | shared `Ajv` instance | `context:ajv` | every plugin (config validation, schema-classifier, future custom keywords) | One AJV per run; `addFormats` applied; `strict: true`; `useDefaults: false` |
| `factory` | `DataFactory` | `context:dataset` | every emit/classify/enrich plugin | RDF/JS data factory (singleton-backed) |
| `dataset` | `DatasetCore` | `context:dataset` | every emit plugin (writer); `enrich:entity-link` (reader); `rdfjs:finalize` (drain) | The canonical dataset every plugin contributes to |
| `builder` | `GraphBuilder` | `context:dataset` | every emit plugin | Quad-emission helper with prefix conventions |
| `iri` | `NamespaceBuilder` | `context:prefixes` | every emit plugin | IRI builder Proxy returning `NamedNode` per property |
| `prefixes` | `PrefixResolutionInterface` | `context:prefixes` | `rdfjs:finalize`, JSON-LD context auto-build | `instances`, `graphs`, `vocabulary` bases |
| `graphs` | frozen `Record<string, NamedNode>` | `context:prefixes` | every emit plugin | Named-graph IRIs by lane key |
| `jt` | `JsonTologyOntology` (optional) | `context:ontology` | `classify:shacl-shape`, `classify:taxonomic-narrowing`, `aonprd:squash` (typed ABox emit) | Present only when `ontology.engine === 'json-tology'`; consumers MUST no-op when absent |
| `runStartTime` | ISO 8601 `string` | `context:run-time` | `output:provenance` | Frozen once per run; deterministic across replays |

Consumer rule: **a plugin that depends on an optional key (`jt`,
`runStartTime`) MUST no-op or fail-fast at startup**, not at per-record time.
`ShaclShapeClassifier` and `TaxonomicNarrowingClassifier` already follow this
convention.

## Per-record silo: well-known keys

All keys live on `state` directly.

| Key | Type | Producer | Consumers | Notes |
|-----|------|----------|-----------|-------|
| `targetId` | `string` | `json:read` | every plugin | Mirrors `ctx.target`; convenience |
| `source` | `InputSourceInterface` | `json:read` | every plugin (provenance, URL classifiers) | Where the record came from |
| `input` | frozen `Record<string, unknown>` | `json:read` | every classifier, every emit plugin | The parsed JSON record |
| `classifications` | `ReadonlyArray<ClassificationProposalInterface>` | every class-proposer (`classify:structural`, `classify:rules`, `classify:schema`, `classify:shacl-shape`, `classify:url-pattern`, `classify:property-fingerprint`, `classify:winknlp-entities`) | `classify:taxonomic-narrowing` (filter), `classify:conflict` (resolve) | **Append-only during proposer phase.** Proposers push; consumers read the full array. This is how proposers coordinate with the resolver — no factory mediation, no central registry |
| `classification` | `ClassificationEvidenceInterface \| null` | `classify:conflict` | every emit plugin (squash, provenance) | The winning class with its evidence; `null` until conflict resolves |
| `output` | `Record<string, unknown> \| null` | `<target>:squash` (or equivalent emit plugin) | `rdfjs:finalize` (per-record summary report) | Per-record projection report — NOT the canonical RDF; that lives on `ctx.dataset` |

Per-record scratch slots: `state` extends `Record<string, unknown>`, so any
plugin may attach private keys (e.g. `state.entityIndex`). Convention:
prefix scratch keys with the producer's plugin name (`state['enrich:entity-link:cache']`)
to avoid collisions.

## Producer/consumer rules

1. **Well-known keys are typed.** A plugin may only assign a value of the
   declared type to a well-known key. The TypeScript interface is the source
   of truth.
2. **Producers run before consumers.** The orchestrator MUST run a producer's
   `onRunStart` before any consumer's `onRunStart` or per-record entry. If
   `context:dataset` runs after `aonprd:squash`'s `onRunStart`, the squash
   plugin's startup assertion fails fast.
3. **Optional keys may be absent.** Consumers MUST no-op or fail-fast at
   their own `onRunStart`, not at per-record time. Never throw mid-record.
4. **Per-record state is mutable; context is frozen** (except `dataset`,
   which is a mutable container with a frozen identity).
5. **Plugins do not invent well-known keys.** Adding a well-known key
   requires updating this document AND the relevant TypeScript interface.

## How this replaces `ClassificationFactory`

Today, `ClassificationFactory.build` instantiates the eleven classifier
classes from a monolithic `classification` config block, threads `outDir` and
`targetId` into `ConflictResolver`'s constructor, and `SquashageConfig`
performs cross-validation that every `classify:*` task in the pipeline has a
matching `classification.<key>` config sub-key.

Under the silo contract, all of that collapses:

| Today (factory) | Tomorrow (silo) |
|-----------------|-----------------|
| `ClassificationFactory.build` constructs each classifier with its config | Each classifier registers itself via `TaskRegistry.register` and reads its config from `ctx.config[<plugin-namespace>]` at `onRunStart` |
| `SquashageConfig.crossValidateTarget` checks each classify task has its config sub-key | Each plugin's `onRunStart` does `ctx.ajv.compile(myConfigSchema)(myConfig)` and fails fast on its own |
| Factory threads `outDir` + `targetId` into `ConflictResolver` constructor | `ConflictResolver` reads `ctx.outDir` + `ctx.target` from the silo |
| Factory builds a private AJV for `classify:schema` | `classify:schema` uses `ctx.ajv` |
| `SquashageConfig` enforces "≥2 proposers requires `classify:conflict`" via a hardcoded set of proposer names | Each proposer plugin declares `proposesClass: true` in its registration manifest; the orchestrator counts at startup and warns/errors |
| `state.context.jt` populated inline in `#buildContext` | `context:ontology` lifecycle plugin populates `ctx.jt` during `onRunStart` only when configured |

Net delta after migration:
- Delete `ClassificationFactory.ts` (~460 lines).
- Delete `crossValidateTarget` and the two hardcoded sets (`CLASS_PROPOSERS`,
  `CLASSIFY_TASK_CONFIG_KEYS`) in `SquashageConfig.ts` (~100 lines).
- Each classifier moves from `src/classification/tasks/` to a flat plugin
  module that self-registers and exports its AJV config schema fragment.
- `SquashageOrchestrator.#buildContext` shrinks to a thin loop that drives
  registered `onRunStart` hooks in declaration order.
- Config flips from one monolithic `classification: { source, structural,
  rules, … }` block to per-plugin namespaces (`source: true`, `structural:
  […]`, `urlPattern: { patterns: […] }`, …) — flat and uniform with how
  `aonprd:squash` is configured today.

This unification is the v0.7.0 Phase 11 work item.

## Adding a new well-known key

1. Add the field to `PipelineContextInterface` (run-wide) or
   `PipelineStateInterface` (per-record) with a JSDoc explaining producer +
   consumer + optionality.
2. Add a row to the relevant table in this document.
3. If the key is run-wide, add a producer plugin (`context:<name>`) that
   populates it during `onRunStart`.
4. If the key is optional, document the consumer's no-op or fail-fast
   convention.

The contract tightens over time: the more the silo absorbs, the less ad-hoc
coordination plumbing the orchestrator needs to maintain.
