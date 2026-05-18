---
layout: doc
title: Taxonomic narrowing
description: classify:taxonomic-narrowing collapses supertype proposals when a more-specific subtype is present, using the OWL subClassOf transitive closure from the TBox. Runs before conflict resolution.
---

# Taxonomic narrowing classifier

The `classify:taxonomic-narrowing` task collapses supertype proposals from the classification cascade when a more-specific subtype is also present, using the OWL `subClassOf` transitive closure derived from the configured TBox.

## Problem framing

Without taxonomic narrowing, classifiers that produce independent proposals can produce redundant results that look like genuine conflicts. Consider a TBox declaring `Weapon subClassOf Equipment`. If both the schema classifier and the SHACL classifier independently propose `Weapon` and `Equipment` for the same record, the conflict resolver sees two distinct class names and either quarantines the record or picks a winner by priority.

The `Equipment` proposal is not wrong; it is less informative. The record is equipment, but it is specifically a weapon. The taxonomic narrowing classifier recognises this hierarchy from the TBox and drops `Equipment` before the conflict resolver runs, leaving `Weapon` as the sole surviving proposal.

**When narrowing fires:** Two or more proposed class names, and at least one proposed class is a transitive supertype of another proposed class in the same proposal set.

**When narrowing does not fire:** The proposed class names are unrelated in the TBox, or only one class is proposed, or the TBox is empty. All three cases pass through to the conflict resolver unchanged.

## State machine

```
json:read
  -> classify:schema         (emits Weapon + Equipment proposals)
  -> classify:taxonomic-narrowing
       |
       +-- load TBox (once, cached)
       +-- build subClassOf transitive closure (once, cached)
       +-- group proposals by className
       +-- if only 1 distinct class -> pass through, call next()
       +-- foreach candidate: is it a supertype of any other candidate?
             YES -> mark for removal
             NO  -> mark as keeper
       +-- if no supertypes found -> pass through, call next()
       +-- drop supertype proposals from state.classifications
       +-- append __narrowing_applied__ sentinel with audit reasons
       +-- call next()
  -> classify:conflict
       (filters __narrowing_applied__ sentinel, resolves Weapon)
```

The closure is built once per classifier instance. In `tboxFrom: "ontology"` mode the TBox quads are fetched from `state.context.jt.tbox()` on the first record processed and cached for all subsequent records in the same run. In file-path mode the file is read at construction time and parsed asynchronously; the closure is built on first execute.

## Plugin contract

`classify:taxonomic-narrowing` is a self-registering silo plugin. It installs:

- An `onRunStart` lifecycle hook (registered via `TaskRegistry.registerHook`) that reads `ctx.config['taxonomicNarrowing']`, validates it via `ctx.ajv.compile(taxonomicNarrowingConfigSchema)`, and — in file-path mode — loads and parses the TBox file. When `ctx.config['taxonomicNarrowing']` is absent the hook is a no-op.
- A per-record task (registered via `TaskRegistry.register`) that filters supertype proposals from `state.classifications` before `classify:conflict` runs.

The plugin does NOT declare `proposesClass: true`: it filters existing proposals but does not add new class proposals.

See [Context silo](../context-silo) for the full plugin coordination protocol.

## Configuration

The config namespace is `taxonomicNarrowing` at the top level of the target config (not under a `classification` wrapper):

```jsonc
{
  "targets": {
    "aonprd": {
      "taxonomicNarrowing": {
        "enabled":  true,
        "tboxFrom": "ontology"
      }
    }
  }
}
```

The task name `classify:taxonomic-narrowing` must appear in the `pipeline` array AFTER all class-proposing classifiers (source, structural, rules, schema, shaclShape, ontology) and BEFORE `classify:conflict`:

```jsonc
{
  "pipeline": [
    "json:read",
    "classify:schema",
    "classify:ontology",
    "classify:shacl-shape",
    "classify:taxonomic-narrowing",
    "classify:conflict",
    "squash:feat",
    "rdfjs:finalize"
  ]
}
```

### `tboxFrom`

Required. Two forms:

| Value | Behaviour |
|---|---|
| `"ontology"` | Reads `state.context.jt.tbox()`. Requires `targets.<id>.ontology.engine: "json-tology"`. |
| `"./path/to/tbox.ttl"` | Reads a Turtle or N-Quads OWL TBox file from disk. Resolved relative to the directory containing the squashage config file. |

### `enabled`

Optional boolean, default `false`. The classifier is a no-op when `false`, so existing pipelines that declare the config block but have not opted in are unaffected.

## Worked example

Given this TBox (Turtle):

```turtle
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix :    <https://example.org/vocabulary#> .

:Weapon    owl:subClassOf :Equipment .
:Equipment owl:subClassOf :Item .
```

And a record that receives proposals `[Weapon, Equipment]` from upstream classifiers, both at priority 30:

1. The classifier builds the transitive closure:
   - `Weapon` -> `{ Equipment, Item }`
   - `Equipment` -> `{ Item }`
2. It scans the proposed class names: `{ Weapon, Equipment }`.
3. For `Equipment`: is it a transitive supertype of any other proposed class? Yes, `Weapon`'s closure contains `Equipment`. Mark `Equipment` for removal.
4. For `Weapon`: is it a transitive supertype of any other proposed class? No. Mark `Weapon` as a keeper.
5. Drop the `Equipment` proposal. Append `__narrowing_applied__` sentinel with reason `"narrowed: Weapon subClassOf Equipment; dropped Equipment"`.
6. `state.classifications` now contains only the `Weapon` proposal plus the sentinel.
7. `classify:conflict` filters the sentinel and resolves `Weapon` as the winner.

## Edge cases

### Empty TBox

When no `owl:subClassOf` quads are found (file is empty or only contains class declarations without hierarchy), the classifier is a no-op. All proposals pass through unchanged.

### Unrelated classes

If the proposed class names have no `subClassOf` relationship in the TBox, they are unrelated and the classifier passes through without modification. The conflict resolver decides.

### Cyclic `subClassOf`

Cycles in the TBox are invalid OWL but may appear in hand-written files. The transitive closure algorithm terminates regardless because each iteration only adds entries to existing sets: the fixpoint is always reached in at most `N` passes where `N` is the number of distinct class names in the TBox.

### Missing class name in TBox

Class names are derived from the last `#`-fragment or `/`-segment of the class IRI. If a proposed className does not appear in the closure as a subtype key (for example `Equipment` is never the subject of a `subClassOf` triple), it is treated as unrelated to all other proposals and kept.

### `tboxFrom: "ontology"` with no json-tology context

When `tboxFrom: "ontology"` is configured but `state.context.jt` is absent (for example, the target uses `engine: "map"` or omits the `ontology` block entirely), the classifier is a no-op and calls `next()` immediately.

### `enabled: false` (default)

The classifier is instantiated but performs no work. Declaring the config block without setting `enabled: true` is safe and produces no side effects.
