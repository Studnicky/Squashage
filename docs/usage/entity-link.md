---
layout: doc
title: Entity-link enrichment
description: Entity-link enrichment closes the gap between records that mention each other in prose fields, densifying the graph by approximately 10x on typical AONPRD-scale corpora through prose field scanning.
---

# Entity-link enrichment

## Problem framing

After classification and quad emission, records that mention each other in their prose fields remain disconnected in the graph. A feat whose description says "combine with Combat Reflexes" produces no edge to the Combat Reflexes entity. A spell that "counters Fireball" stays isolated from the Fireball spell node.

This gap means SPARQL queries like "find all Feats that mention any Spell" return nothing, and the WebGL visualisation shows sparse clusters where the domain knowledge implies dense cross-links.

The entity-link enrichment task closes this gap without requiring per-record rules. It densifies the graph by approximately 10x on typical AONPRD-scale corpora purely from prose field scanning.

## When it runs

`enrich-entity-link` is a run-scope node placed between `process-all-records` and `rdfjs-finalize`. It runs once per run after every record clone has settled, so the entity index it builds reflects the full dataset.

The node reads its config from the config root `enrichment.entityLink` and consumes entity IRIs + labels from `services.dataset`. It writes enrichment edge quads back into `services.dataset` for `rdfjs-finalize` to serialize.

See [DAG](./pipeline) for the full run-scope topology.

## State machine

The node executes once per run as an **end-of-run enrichment phase**, after all per-record classification and squash nodes have settled and before `rdfjs-finalize` serialises the dataset.

```
all record clones complete
          |
          v
  [ dataset population ]   <- squash node emitted quads for every record
          |
          v
  [ index build (once) ]   <- scan dataset for typed instances in linkAgainst set
          |                   map caseFolded(label) -> instanceIri
          |
          v  for each typed instance subject:
  [ prose field scan ]     <- read <vocabBase><field> literals from dataset
          |
          v  for each sliding-window token span (1-5 tokens):
  [ span lookup ]          <- caseFolded span in index?
          |                   yes -> emit <subject> <edgeIri> <linkTarget> quad
          |                   no  -> skip
          v
  [ rdfjs-finalize ]       <- serialize dataset with enrichment edges included
```

**Why deterministic:** winkNLP's tokenizer is pattern-based (no model sampling). The index is built once from the dataset state at enrichment time. The sliding-window span generation is a pure function. Same input + same config produces identical edges across runs.

## Configuration

Add an `enrichment` block at the config root, sibling to `classification` and `output`:

```jsonc
{
  "input":  { "basePath": "./input", "format": "json" },
  "output": { "type": "file", "path": "./graphs/aonprd.trig", "format": "trig" },
  "enrichment": {
    "entityLink": {
      "engine":        "winknlp",
      "fields":        ["description", "summary", "traits_text"],
      "edgeIri":       "aonprd:mentions",
      "linkAgainst":   ["aonprd:Feat", "aonprd:Spell", "aonprd:Trait"],
      "minConfidence": 0.85
    }
  }
}
```

### Field reference

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `engine` | `"winknlp"` | yes | - | NLP engine. Only `"winknlp"` is supported. |
| `fields` | `string[]` | no | `["description"]` | Prose predicate local names to scan (resolved as `<vocabBase><field>`). |
| `edgeIri` | `string` | yes | - | Full IRI or prefixed name of the edge predicate to emit. |
| `linkAgainst` | `string[]` | yes | - | Allow-list of `rdf:type` IRIs. Only instances with one of these types are indexed. |
| `minConfidence` | `number` | no | `0.85` | Threshold in `[0, 1]`. winkNLP token matches are binary (1.0), so values above 1.0 suppress all edges. |

## Worked example (AONPRD-style)

### Input records

`feat-power-attack.json`:
```json
{
  "_type": "feat",
  "name": "Power Attack",
  "description": "You can combine this with Combat Reflexes to guard the battlefield."
}
```

`feat-combat-reflexes.json`:
```json
{
  "_type": "feat",
  "name": "Combat Reflexes",
  "description": "Pairs well after a Power Attack."
}
```

### Plugin output (before enrichment)

The squash plugin emits these quads (among others):

```turtle
<instances:Feats.aspx?ID=750> rdf:type      <vocab:Feat> ;
                               <vocab:name>  "Power Attack" ;
                               <vocab:description> "You can combine this with Combat Reflexes..." .

<instances:Feats.aspx?ID=80>  rdf:type      <vocab:Feat> ;
                               <vocab:name>  "Combat Reflexes" ;
                               <vocab:description> "Pairs well after a Power Attack." .
```

### After entity-link enrichment

```turtle
<instances:Feats.aspx?ID=750> <vocab:mentions> <instances:Feats.aspx?ID=80> .
<instances:Feats.aspx?ID=80>  <vocab:mentions> <instances:Feats.aspx?ID=750> .
```

## Edge cases

### No `linkAgainst` types match

If `linkAgainst` lists a type IRI that no instance in the dataset has, the index will be empty and the task emits zero edges. This is not an error.

### Stop-word and single-token matches

Single tokens like "a", "the", "feat" may superficially match entity names. In practice this is rare because entity names are multi-word (2+ tokens). The sliding-window span extraction generates 2-5 token combinations, which is where most cross-reference matches occur. Single-token matches against entity names that happen to be one word are valid and expected.

### Multi-token entity names

Multi-word names like "Combat Reflexes" or "Power Attack" are matched by 2-token sliding windows. The index keys are always the full case-folded label, so a 2-token span must exactly match the full name to produce an edge.

### Prose field not emitted by plugin

The node reads prose from dataset predicates: `<vocabBase><fieldName>`. If the squash plugin does not emit a `<vocabBase>description` literal for a subject, that subject's description field produces zero spans. Ensure the plugin emits the relevant prose predicates to the shared dataset before `enrich-entity-link` runs.

### Index is frozen at enrichment time

The index is built exactly once per run, from the dataset as it stands when `enrich-entity-link` first executes. Instances added to the dataset after the index build (which cannot happen in normal sequential execution) are not reflected in the edge output. This preserves determinism.
