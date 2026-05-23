---
layout: doc
title: Classifier cascade
description: Squashage's eleven deterministic classifier nodes — what each one proposes, how the parallel placement collects their votes, how the conflict resolver picks a winner.
---

# Classifier cascade

Eleven classifier nodes participate in the per-record DAG. Nine run concurrently in a `parallel: collect` placement; two run sequentially after the parallel because they read other classifiers' proposals. The conflict resolver reduces every non-sentinel proposal into a single winning `state.classification`.

The cascade is deterministic: same config + same record produce identical proposals, identical winner, identical PROV-O quads.

## Opt-in

Each classifier has a config slot under `targets[].classification.<key>`. When the slot is present, the corresponding classifier is instantiated and registered on the dispatcher. When the slot is absent, a no-op classifier is registered under the same name so the static DAG topology still resolves.

The nine parallel classifiers + two sequential classifiers + the conflict resolver are wired in `SquashageRun.forTarget(...)` from the matching config slots.

## Primary path — the discriminator

For targets where records carry a discriminator field (e.g. `_type`), the `classify:discriminator` node is the primary classification path. It reads the literal value at a configured JSON Pointer and uses it directly as the class name proposal — no per-class enumeration required.

<ClassifierCard
  name="classify:discriminator"
  slot="discriminator"
  placement="parallel"
  :priority="50"
  :outputs="['proposed', 'no-match']"
  engine="Reads a configured JSON Pointer (default /_type) from the record. Uses the resolved string (after optional sanitization) as the className proposal. Open-world: any non-empty string value classifies without enumeration."
/>

Config slot: `classification.discriminator`

```json
{
  "discriminator": {
    "from":     "/_type",
    "sanitize": "pascalCase",
    "priority": 80
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `from` | string | required | JSON Pointer (RFC 6901) into the record. |
| `fallback` | string | — | Pointer used when `from` is absent or non-string. |
| `priority` | number | 50 | Proposal priority; set higher than legacy classifiers to ensure it wins on conflict. |
| `sanitize` | string | `"verbatim"` | `"verbatim"` uses the value as-is; `"pascalCase"` and `"kebabToPascal"` split on `[-_\s]+` and capitalize each segment. |

When the pointer resolves to a non-empty string, a proposal is emitted with `confidence: 1.0`. When the pointer is absent or non-string, the node outputs `no-match` and legacy classifiers may still produce a proposal.

**Source:** `src/nodes/record/classifiers/DiscriminatorClassifierNode.ts`

## Parallel classifiers (9)

These run concurrently inside `classify-all`. Each writes to its own slot in `state.proposals[<classifier-name>]`, so the writes are race-free. Each classifier's outputs (`proposed` / `no-match`) route to `null` within the parallel placement; the parallel's combined output (`success`) routes forward to the first sequential classifier.

<ClassifierCard
  name="classify:source"
  slot="source"
  placement="parallel"
  :priority="0"
  :outputs="['proposed', 'no-match']"
  engine="Inspects the record's _source block; emits a __source__ metadata marker. Never proposes a class."
/>
<ClassifierCard
  name="classify:url-pattern"
  slot="urlPattern"
  placement="parallel"
  :priority="35"
  :outputs="['proposed', 'no-match']"
  engine="Compiled regex over _source.url (priority) or top-level url. Highest-priority matching pattern wins the slot."
  href="./url-pattern-classifier"
/>
<ClassifierCard
  name="classify:structural"
  slot="structural"
  placement="parallel"
  :priority="10"
  :outputs="['proposed', 'no-match']"
  engine="Compiled JSON-pointer predicates over state.input via the Predicate engine."
/>
<ClassifierCard
  name="classify:rules"
  slot="rules"
  placement="parallel"
  :priority="20"
  :outputs="['proposed', 'no-match']"
  engine="Full decision-table predicates (equals, in, exists, range, length, regex, all/any composition). Same engine as structural; different config slot."
/>
<ClassifierCard
  name="classify:schema"
  slot="schemas"
  placement="parallel"
  :priority="30"
  :outputs="['proposed', 'no-match']"
  engine="Per-class AJV validators loaded from JSON Schema files and compiled via services.ajv."
/>
<ClassifierCard
  name="classify:shacl-shape"
  slot="shaclShape"
  placement="parallel"
  :priority="45"
  :outputs="['proposed', 'no-match']"
  engine="SHACL NodeShape ABox validation against record-projected quads. Reads shapes from a Turtle file or services.ontology.shacl()."
  href="./shacl-shape-classifier"
/>
<ClassifierCard
  name="classify:property-fingerprint"
  slot="propertyFingerprint"
  placement="parallel"
  :priority="32"
  :outputs="['proposed', 'no-match']"
  engine="Jaccard similarity between the record's top-level key set and pre-compiled fingerprints. Confidence = the Jaccard score."
  href="./property-fingerprint-classifier"
/>
<ClassifierCard
  name="classify:winknlp-entities"
  slot="winknlpEntities"
  placement="parallel"
  :priority="28"
  :outputs="['proposed', 'no-match']"
  engine="winkNLP custom-entity pattern NER over configured prose fields. Patterns compiled once at construction."
  href="./winknlp-entities"
/>

## Sequential post-parallel classifiers (2)

These read every other classifier's proposal, so they cannot run in parallel without race conditions. Order: `classify:ontology` runs first, then `classify:taxonomic-narrowing`.

<ClassifierCard
  name="classify:ontology"
  slot="ontologyClassifier"
  placement="sequential"
  :priority="0"
  :outputs="['validated', 'no-match']"
  engine="Validates every other classifier's className against config.classes. Emits a __validation__ sentinel listing unknown classes."
/>
<ClassifierCard
  name="classify:taxonomic-narrowing"
  slot="taxonomicNarrowing"
  placement="sequential"
  :priority="0"
  :outputs="['narrowed', 'no-op']"
  engine="Drops supertype proposals when a more-specific subtype is also present. Uses OWL subClassOf transitive closure built once at construction."
  href="./taxonomic-narrowing"
/>

## Conflict resolver

`classify-conflict` runs after the gate (`record-health-gate`) has confirmed at least one non-sentinel proposal exists. It implements the documented resolution algorithm:

1. Filter sentinels (`__source__`, `__validation__`, `__narrowing_applied__`, `unknown`).
2. If every surviving proposal agrees on a single className → that class wins; engine becomes the comma-joined unique sources.
3. If multiple classes propose, find the highest priority. Single winner at the top → it wins. Tie → apply `onConflict`:
   - `quarantine`: bucket `'conflicts'`, exit via the quarantine path.
   - `pickPriority`: lexicographically first className wins; `candidates` lists all tied classes.
4. Confidence comes from the winning proposal.

Configure via `targets[].classification.conflict`:

```json
{
  "onConflict": "pickPriority",
  "evidence":   true
}
```

`evidence: true` concatenates every contributing proposal's `reasons` into the final `state.classification.reasons`. `evidence: false` keeps only the winner's first reason.

## Sentinels

| Sentinel | Producer | Meaning |
|---|---|---|
| `__source__` | `classify:source` | The record's `_source` block was inspected; preserved in evidence as provenance. |
| `__validation__` | `classify:ontology` | One or more classifiers proposed a class outside the known map. |
| `__narrowing_applied__` | `classify:taxonomic-narrowing` | Supertype proposals were dropped in favor of subtypes. |

All three are filtered before conflict resolution and preserved in the final `ClassificationEvidence.reasons` array when `conflict.evidence: true`.

## See also

- [DAG](./pipeline) — full per-record + run-scope topology.
- [Taxonomy — upper ontology and parents DSL](./taxonomy) — squashage-core classes, `parents` DSL, and `TaxonomicInheritanceEnricher`.
- [URL-pattern classifier](./url-pattern-classifier) — config reference.
- [SHACL-shape classifier](./shacl-shape-classifier) — config reference.
- [Property-fingerprint classifier](./property-fingerprint-classifier) — config reference.
- [winkNLP entities classifier](./winknlp-entities) — config reference.
- [Taxonomic narrowing](./taxonomic-narrowing) — config reference.
- [Ontology (json-tology)](./ontology) — how to wire an ontology engine for SHACL + narrowing.
