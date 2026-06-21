# Dagonizer 0.25 Port Cookbook

Ground-truth sources used throughout:

- **Installed .d.ts**: `/Users/studs/Workspace/squashage/node_modules/@studnicky/dagonizer/dist/**`
- **Package exports map**: same root `package.json` `"exports"` field
- **Ripperoni working source**: `/Users/studs/Workspace/ripper/src/` (same `@studnicky/dagonizer@0.25.0`)

---

## 1. Symbol Rename Table

Every symbol currently imported from dagonizer in squashage, mapped to its 0.25 name and correct subpath export.

| Old import | Old path | New name | New path | Notes |
|---|---|---|---|---|
| `DAG` | `@studnicky/dagonizer/entities` | `DAGType` | `@studnicky/dagonizer` or `@studnicky/dagonizer/entities` | Renamed: `type DAG` → `type DAGType` |
| `JsonObject` | `@studnicky/dagonizer/types` | `JsonObjectType` | `@studnicky/dagonizer/entities` | Renamed. No longer re-exported from `/types` |
| `JsonValue` | `@studnicky/dagonizer/types` | `JsonValueType` | `@studnicky/dagonizer/entities` | Same rename. See also: `JsonValue` (class/value) lives at `/` main barrel |
| `ExecutionResultInterface` | `@studnicky/dagonizer` | `ExecutionResultType` | `@studnicky/dagonizer` | `Interface` → `Type` suffix |
| `NodeStateInterface` | `@studnicky/dagonizer` | `NodeStateInterface` | `@studnicky/dagonizer` | **Unchanged** (still exported from `/NodeStateBase.js`) |
| `NodeStateBase` | `@studnicky/dagonizer` | `NodeStateBase` | `@studnicky/dagonizer` | **Unchanged** |
| `NodeContextType` | `@studnicky/dagonizer` | `NodeContextType` | `@studnicky/dagonizer` | **Unchanged** |
| `NodeOutputType` | `@studnicky/dagonizer` | `NodeOutputType` | `@studnicky/dagonizer` | **Unchanged** |
| `RoutedBatchType` | `@studnicky/dagonizer` | `RoutedBatchType` | `@studnicky/dagonizer` | **Unchanged** |
| `Batch` | `@studnicky/dagonizer` | `Batch` | `@studnicky/dagonizer` | **Unchanged** |
| `MonadicNode` | `@studnicky/dagonizer` | `MonadicNode` | `@studnicky/dagonizer` | **Unchanged** |
| `ScalarNode` | `@studnicky/dagonizer` | `ScalarNode` | `@studnicky/dagonizer` | **Unchanged** |
| `DAGBuilder` | `@studnicky/dagonizer/builder` | `DAGBuilder` | `@studnicky/dagonizer/builder` | **Unchanged** |
| `DAGDocument` | `@studnicky/dagonizer` | `DAGDocument` | `@studnicky/dagonizer` | **Unchanged** |
| `Dagonizer` | `@studnicky/dagonizer` | `Dagonizer` | `@studnicky/dagonizer` | **Unchanged** |
| `NodeInterface` | `@studnicky/dagonizer` | `NodeInterface` | `@studnicky/dagonizer` | **Unchanged** |
| `NodeErrorBuilder` | `@studnicky/dagonizer` | `NodeErrorBuilder` | `@studnicky/dagonizer` | Builder for `NodeErrorType` |
| `NodeOutputBuilder` | `@studnicky/dagonizer` | `NodeOutputBuilder` | `@studnicky/dagonizer` | Use `.of(output)` — replaces `{ output: 'done' }` literals |
| `DAGLifecycleStateType` | `@studnicky/dagonizer` | `DAGLifecycleStateType` | `@studnicky/dagonizer` | **Unchanged** name, but `.kind` field → `.variant` |
| `MermaidRenderer` | `@studnicky/dagonizer/viz` | `MermaidRenderer` | `@studnicky/dagonizer/viz` | **Unchanged** |

### Concrete before → after for every affected import

**`DAG` type** (used in all `src/dag/*.ts` files):

```ts
// BEFORE (errors: Module has no exported member 'DAG')
import type { DAG } from '@studnicky/dagonizer/entities';
export const recordDag: DAG = ...

// AFTER
import type { DAGType } from '@studnicky/dagonizer';
export const recordDag: DAGType = ...
```

**`JsonObject` / `JsonValue`** (used in all `src/state/*.ts` files):

```ts
// BEFORE (errors: Module has no exported member 'JsonObject', 'JsonValue')
import type { JsonObject, JsonValue } from '@studnicky/dagonizer/types';

// AFTER — from entities subpath
import type { JsonObjectType, JsonValueType } from '@studnicky/dagonizer/entities';
```

Ripperoni uses the same pattern: `/Users/studs/Workspace/ripper/src/state/ScrapeState.ts` line 2:
```ts
import type { JsonObjectType } from '@studnicky/dagonizer/entities';
```

**`ExecutionResultInterface`** (`src/dispatcher/SquashageDagonizer.ts`):

```ts
// BEFORE
import type { ExecutionResultInterface, NodeStateInterface } from '@studnicky/dagonizer';

// AFTER
import type { ExecutionResultType, NodeStateInterface } from '@studnicky/dagonizer';
```

**`DAGLifecycleStateType` discriminant field** — `.kind` → `.variant`:

```ts
// BEFORE (error TS2339: Property 'kind' does not exist)
state.lifecycle.kind   // used in SquashageDagonizer and cli/dagonizerCli.ts

// AFTER
state.lifecycle.variant
```

The 0.25 `DAGLifecycleStateType` is a 6-variant discriminated union on field `variant`:
```ts
// from dist/lifecycle/DAGLifecycleState.d.ts
type DAGLifecycleStateType =
  | { variant: 'pending';    startedAt: null;   finishedAt: null;   error: null;  reason: null   }
  | { variant: 'running';    startedAt: number; finishedAt: null;   error: null;  reason: null   }
  | { variant: 'completed';  startedAt: number; finishedAt: number; error: null;  reason: null   }
  | { variant: 'failed';     startedAt: number; finishedAt: number; error: Error; reason: null   }
  | { variant: 'cancelled';  startedAt: number; finishedAt: number; error: null;  reason: string }
  | { variant: 'timed_out';  startedAt: number; finishedAt: number; error: null;  reason: null   };
```

---

## 2. Node Port: Object-Literal → ScalarNode Class

### The pattern

Every node must now extend `ScalarNode` (for per-item work) or `MonadicNode` (for batch-native work). Object-literal nodes and classes with the old `execute(state, ctx)` signature are both invalid.

**Canonical ScalarNode shape** (sourced from `dist/core/ScalarNode.d.ts`):

```ts
import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';
import type { MyState }    from '../state/MyState.js';
import type { MyServices } from '../services/MyServices.js';

type MyOutput = 'success' | 'error';

class MyNodeImpl extends ScalarNode<MyState, MyOutput, MyServices> {
  public readonly name    = 'my:node-name';
  public readonly outputs = ['success', 'error'] as const;

  // REQUIRED: abstract getter from MonadicNode
  public override get outputSchema(): Record<MyOutput, { type: 'object' }> {
    return {
      success: { type: 'object' },
      error:   { type: 'object' },
    };
  }

  protected override async executeOne(
    state:   MyState,
    context: NodeContextType<MyServices>,
  ): Promise<NodeOutputType<MyOutput>> {
    const { services } = context;
    // ... work ...
    return NodeOutputBuilder.of('success');
  }
}

export const MyNode = new MyNodeImpl();
```

### Required fields resolved

**`timeout`**: `MonadicNode` declares `readonly timeout: Timeout = Timeout.none()` as a concrete field with a default. Subclasses do NOT need to redeclare it. (`dist/core/MonadicNode.d.ts` line 51: `readonly timeout: Timeout;` is the required-with-default.)

**`outputSchema`**: `MonadicNode` declares `abstract get outputSchema(): Record<TOutput, SchemaObjectType>`. Every concrete node MUST implement it. The passthrough minimum is `{ type: 'object' }` per port. Real schemas describe the state delta the node writes. (`dist/core/MonadicNode.d.ts` line 61.)

> **Ripperoni gap**: Ripperoni's `.ts` source does NOT yet implement `outputSchema` on its nodes. Running `tsc --noEmit` in `/Users/studs/Workspace/ripper` produces `TS2515` errors for every node. Squashage must implement `outputSchema` to compile cleanly. Use `{ type: 'object' }` passthrough for now.

**`executeOne` return type**: `Promise<NodeOutputType<TOutput>>`. Construct via `NodeOutputBuilder.of(output)` — never a raw `{ output: 'done' }` literal. (`dist/entities/node/NodeOutput.d.ts`.)

**`outputs` declaration**: `public readonly outputs = ['success', 'error'] as const;` field on the class. The `as const` is required for TypeScript to infer the literal union type that narrows `TOutput`.

**Services access**: `context.services` is typed as `TServices` (the third generic, e.g. `SquashageServices`). No cast needed when the class is generic over it.

**Error / quarantine routing**: `ScalarNode.execute` calls `executeOne` and forwards per-item errors via `state.collectError(error)`. To signal quarantine, call `state.collectError(NodeErrorBuilder.from(...))` and return `NodeOutputBuilder.of('quarantined')`. The `ScalarNode` base does NOT call `state.collectError` automatically — the node calls it explicitly before returning the error port. (`dist/core/ScalarNode.d.ts` lines 7–8: "forwards per-item errors via `state.collectError`" refers to the engine using that method after execution, but nodes call it directly inside `executeOne`.)

---

### Example A: `src/nodes/record/jsonRead.ts` (object-literal → class)

**Before** (`/Users/studs/Workspace/squashage/src/nodes/record/jsonRead.ts`):

```ts
import type { NodeInterface } from '@studnicky/dagonizer';
import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRecordState } from '../../state/SquashageRecordState.js';

type Output = 'loaded' | 'quarantined';

export const jsonReadNode: NodeInterface<SquashageRecordState, Output, SquashageServices> = {
  name:    'json-read',
  outputs: ['loaded', 'quarantined'],
  async execute(state, context) {
    // state is SquashageRecordState directly — engine passes state per item in old API
    const log = context.services.logger.forComponent('json-read');
    // ...
    return { output: 'quarantined' };
    // ...
    return { output: 'loaded' };
  },
};
```

**After**:

```ts
import { ScalarNode, NodeOutputBuilder, NodeErrorBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';
import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRecordState } from '../../state/SquashageRecordState.js';
import type { InputSource } from '../../state/schemas/InputSource.js';
import { readFile } from 'node:fs/promises';

type Output = 'loaded' | 'quarantined';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractRecord(rawText: string, recordLine: number): unknown {
  if (recordLine === 0) {
    try { return JSON.parse(rawText.trim()); } catch { /* fall through */ }
  }
  const lines = rawText.split('\n').filter((l) => l.trim().length > 0);
  return JSON.parse(lines[recordLine] ?? '');
}

class JsonReadNodeImpl extends ScalarNode<SquashageRecordState, Output, SquashageServices> {
  public readonly name    = 'json-read';
  public readonly outputs = ['loaded', 'quarantined'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { loaded: { type: 'object' }, quarantined: { type: 'object' } };
  }

  protected override async executeOne(
    state:   SquashageRecordState,
    context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const log        = context.services.logger.forComponent('json-read');
    const recordPath = state.recordPath;
    const recordLine = state.recordLine;

    let rawText: string;
    try {
      rawText = await readFile(recordPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.collectError(NodeErrorBuilder.from(
        'JSON_READ_FILE_ERROR', message, 'json-read', false, new Date().toISOString(),
      ));
      state.quarantineBucket = 'projection';
      log.warn('executeOne', 'unreadable input', { recordPath, message });
      return NodeOutputBuilder.of('quarantined');
    }

    let parsed: unknown;
    try {
      parsed = extractRecord(rawText, recordLine);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.collectError(NodeErrorBuilder.from(
        'JSON_READ_PARSE_ERROR',
        `malformed JSON at ${recordPath}:${recordLine.toString()} — ${message}`,
        'json-read', false, new Date().toISOString(),
      ));
      state.quarantineBucket = 'projection';
      return NodeOutputBuilder.of('quarantined');
    }

    if (!isPlainObject(parsed)) {
      state.collectError(NodeErrorBuilder.from(
        'JSON_READ_NON_OBJECT', 'record is not a plain object',
        'json-read', false, new Date().toISOString(),
      ));
      state.quarantineBucket = 'projection';
      return NodeOutputBuilder.of('quarantined');
    }

    const embedded = parsed['_source'];
    if (isPlainObject(embedded) && typeof embedded['target'] === 'string'
        && embedded['target'] !== state.source.target) {
      state.collectError(NodeErrorBuilder.from(
        'JSON_READ_TARGET_MISMATCH',
        `_source.target "${embedded['target']}" does not match state.source.target "${state.source.target}"`,
        'json-read', false, new Date().toISOString(),
      ));
      state.quarantineBucket = 'projection';
      return NodeOutputBuilder.of('quarantined');
    }

    if (isPlainObject(embedded)) {
      const merged: InputSource = {
        target:   state.source.target,
        path:     state.source.path,
        ...(typeof embedded['plugin']   === 'string' ? { plugin:   embedded['plugin']   } : {}),
        ...(typeof embedded['schemaId'] === 'string' ? { schemaId: embedded['schemaId'] } : {}),
      };
      state.source = merged;
    }

    // state.input is typed Readonly<Record<string,unknown>> on SquashageRecordState;
    // the field is reassigned via the typed public property, NOT via an unsafe cast.
    state.input = parsed;
    log.debug('executeOne', 'record loaded', { recordPath, recordLine });
    return NodeOutputBuilder.of('loaded');
  }
}

export const jsonReadNode = new JsonReadNodeImpl();
```

Key changes vs before:
- `execute(state, context)` → `executeOne(state, context)` (ScalarNode maps it over the batch)
- `{ output: 'quarantined' }` → `NodeOutputBuilder.of('quarantined')`
- `state.collectError({ code, message, ... })` → `state.collectError(NodeErrorBuilder.from(...))`
- `(state as unknown as {...}).input = parsed` → `state.input = parsed` (SquashageRecordState already has `input` as a public field; the unsafe cast can be removed once the state field is writable)
- `outputSchema` getter added

---

### Example B: `src/nodes/record/classifiers/SourceClassifierNode.ts` (object-literal → class)

**Before** (`/Users/studs/Workspace/squashage/src/nodes/record/classifiers/SourceClassifierNode.ts`):

```ts
import type { NodeInterface } from '@studnicky/dagonizer';

export const sourceClassifierNode: NodeInterface<SquashageRecordState, Output, SquashageServices> = {
  name:    'classify:source',
  outputs: ['proposed', 'no-match'],
  async execute(state, _context) {
    const raw = state.input['_source'];
    // ...
    return { output: 'no-match' };
    // ...
    return { output: 'proposed' };
  },
};
```

**After**:

```ts
import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';
import type { SquashageServices } from '../../../services/SquashageServices.js';
import type { SquashageRecordState } from '../../../state/SquashageRecordState.js';

type Output = 'proposed' | 'no-match';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class SourceClassifierNodeImpl extends ScalarNode<SquashageRecordState, Output, SquashageServices> {
  public readonly name    = 'classify:source';
  public readonly outputs = ['proposed', 'no-match'] as const;

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { proposed: { type: 'object' }, 'no-match': { type: 'object' } };
  }

  protected override async executeOne(
    state:    SquashageRecordState,
    _context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const raw = state.input['_source'];
    if (!isPlainObject(raw)) {
      return NodeOutputBuilder.of('no-match');
    }

    const reasons: string[] = [];
    if (typeof raw['target']   === 'string') reasons.push(`source.target=${raw['target']}`);
    if (typeof raw['plugin']   === 'string') reasons.push(`source.plugin=${raw['plugin']}`);
    if (typeof raw['schemaId'] === 'string') reasons.push(`source.schemaId=${raw['schemaId']}`);

    state.proposals['classify:source'] = {
      source:     'classify:source',
      className:  '__source__',
      priority:   0,
      confidence: 1,
      reasons,
    };
    return NodeOutputBuilder.of('proposed');
  }
}

export const sourceClassifierNode = new SourceClassifierNodeImpl();
```

The class-based classifiers (e.g. `OntologyClassifierNode`, `DiscriminatorClassifierNode`) that already use `class ... implements NodeInterface` must:
1. Change `execute(state, ctx)` → `protected override async executeOne(state, ctx)`
2. Extend `ScalarNode<TState, TOutput, TServices>` instead of implementing `NodeInterface`
3. Add `outputSchema` getter
4. Change `return { output: 'x' }` → `return NodeOutputBuilder.of('x')`
5. Change `state.collectError({ code, ... })` → `state.collectError(NodeErrorBuilder.from(code, msg, op, recoverable, timestamp))`

The `context` parameter shape changes: old API had `{ readonly services: TServices }` but 0.25 `NodeContextType` is `{ dagName, nodeName, signal, services, validateOutputs, outputSchemaValidator }`. Existing code accessing only `context.services` works unchanged.

---

## 3. State Class Contract (`NodeStateInterface` / `NodeStateBase`)

### What `NodeStateInterface` requires (from `dist/NodeStateBase.d.ts`)

```ts
interface NodeStateInterface {
  clone(): this;                          // MUST return this (not a named subtype)
  collectError(error: NodeErrorType): void;
  collectWarning(warning: NodeWarningType): void;
  readonly errors: readonly NodeErrorType[];
  getMetadata<T>(key: string): T | undefined;
  readonly lifecycle: DAGLifecycleStateType;  // .variant not .kind
  markCancelled(reason: string): void;
  markCompleted(): void;
  markFailed(error: Error): void;
  markRunning(): void;
  markTimedOut(): void;
  resetLifecycle(): void;
  readonly metadata: Readonly<Record<string, unknown>>;
  setMetadata(key: string, value: unknown): void;
  deleteMetadata(key: string): void;
  recordAttempt(key: string): number;
  retriesFor(key: string): number;
  clearAttempts(key: string): void;
  withinRetryBudget(key: string, maxAttempts: number): boolean;
  readonly warnings: readonly NodeWarningType[];
  snapshot(): JsonObjectType;
  applySnapshot(snapshot: JsonObjectType): void;
}
```

All the `mark*` methods, `collectError`, `getMetadata`, `setMetadata`, `snapshot`, etc. are implemented by `NodeStateBase`. Subclasses only need to provide the domain fields.

### `NodeStateBase` extension contract

```ts
class NodeStateBase implements NodeStateInterface {
  // Provided by base:
  //   clone(), collectError(), collectWarning(), errors, getMetadata(), lifecycle,
  //   mark*(), metadata, setMetadata(), deleteMetadata(),
  //   recordAttempt(), retriesFor(), clearAttempts(), withinRetryBudget(),
  //   warnings, snapshot(), applySnapshot()

  // Subclass hooks (override to add domain fields):
  protected snapshotData(): JsonObjectType { return {}; }
  protected restoreData(_snapshot: JsonObjectType): void { /* no-op */ }

  // Static restore factory:
  static restore<T extends NodeStateBase>(this: new() => T, snapshot: JsonObjectType): T
}
```

### Ripperoni's `ScrapeState` as the template

`/Users/studs/Workspace/ripper/src/state/ScrapeState.ts`:

```ts
import { NodeStateBase } from '@studnicky/dagonizer';
import type { JsonObjectType } from '@studnicky/dagonizer/entities';  // ← correct import

export class ScrapeState extends NodeStateBase {
  // Domain fields with initializers:
  page: PipelinePageType = { targetId: '', title: '', url: '' };
  output: Record<string, unknown> | null = null;
  urls:   string[] = [];
  // ...

  // snapshotData returns JsonObjectType, NOT JsonObject (renamed):
  protected override snapshotData(): JsonObjectType {
    return {
      page:  this.page as unknown as JsonObjectType,
      urls:  [...this.urls],
      // ...
    };
  }

  // restoreData reads from JsonObjectType:
  protected override restoreData(snap: JsonObjectType): void {
    const urls = snap['urls'];
    if (Array.isArray(urls)) this.urls = urls as string[];
    // ...
  }
}
```

### What squashage's state classes need to change

All six state files (`SquashageRecordState`, `SquashageRunState`, `SquashageInduceRunState`, `SquashageRefineRunState`, `SquashageRefineState`, `SquashageBootstrapState`) have **two** issues:

**Issue 1 — wrong JSON type imports** (TS2305: Module has no exported member 'JsonObject'):

```ts
// BEFORE (all state files line 2)
import type { JsonObject, JsonValue } from '@studnicky/dagonizer/types';

// AFTER
import type { JsonObjectType, JsonValueType } from '@studnicky/dagonizer/entities';
```

Then replace every `JsonObject` → `JsonObjectType` and `JsonValue` → `JsonValueType` in `snapshotData` and `restoreData` signatures.

**Issue 2 — `clone()` return type** (TS2416: Property 'clone' is not assignable):

The base `NodeStateBase.clone()` is typed `clone(): this`. Squashage's state classes override it as `clone(): SquashageRecordState` (a named type), which is not assignable to `this`. Fix:

```ts
// BEFORE (error TS2416)
override clone(): SquashageRecordState {
  const base = super.clone() as SquashageRecordState;
  // ...
  return base;
}

// AFTER — remove the explicit return type annotation; TypeScript infers this correctly
override clone() {
  const base = super.clone() as this;
  base.source    = this.source;
  base.input     = this.input;
  // copy all domain fields ...
  return base;
}
```

**`squashedQuads` and other fields** — the unsafe cast `(state as unknown as { squashedQuads: ... }).squashedQuads = quads` in several run nodes is not a 0.25 API issue. `SquashageRecordState` already declares `squashedQuads: readonly unknown[]` as a public field. Replace the cast with direct assignment: `state.squashedQuads = quads;`. The field will need to be mutable (`squashedQuads: unknown[]`), not `readonly`.

### `lifecycle.kind` → `lifecycle.variant`

Any squashage code checking `state.lifecycle.kind === 'completed'` must become `state.lifecycle.variant === 'completed'`. Files affected: `src/dispatcher/SquashageDagonizer.ts` line 40, and `src/cli/dagonizerCli.ts` lines 103, 142, 178, 223, 225.

---

## 4. Dagonizer Subclass (Observer Forwarder)

### Ripperoni's `RipperDagonizer` in full

`/Users/studs/Workspace/ripper/src/dispatcher/RipperDagonizer.ts`:

```ts
import { Dagonizer } from '@studnicky/dagonizer';
import type { DagContainerInterface, ExecutionResultType, NodeStateInterface } from '@studnicky/dagonizer';
import type { RipperServices } from '../services/RipperServices.js';

export class RipperDagonizer<TState extends NodeStateInterface>
  extends Dagonizer<TState, RipperServices> {

  constructor(options: { services: RipperServices; containers?: Record<string, DagContainerInterface> }) {
    super({ services: options.services, ...(options.containers !== undefined ? { containers: options.containers } : {}) });
  }

  protected override onFlowStart(dagName: string, _state: TState): void { ... }

  protected override onFlowEnd(
    dagName: string,
    state:   TState,
    _result: ExecutionResultType<TState>,
  ): void {
    // Uses state.lifecycle.variant (not .kind)
    log.info('flow-end', `DAG '${dagName}' ended: ${state.lifecycle.variant}`);
  }

  protected override onNodeStart(nodeName: string, _state: TState): void { ... }

  protected override onNodeEnd(
    nodeName: string,
    output:   string | null,   // ← string | null (NOT string | undefined)
    _state:   TState,
  ): void { ... }

  protected override onError(nodeName: string, error: Error, _state: TState): void { ... }
}
```

Note: Ripperoni does NOT override `onPhaseEnter` / `onPhaseExit`. These are no-ops by default.

### 0.25 override signatures from `dist/Dagonizer.d.ts`

```ts
protected onFlowStart(
  _dagName: string,
  _state: NodeStateInterface,
): void;

protected onFlowEnd(
  _dagName: string,
  _state: NodeStateInterface,
  _result: ExecutionResultType<NodeStateInterface>,
): void;

protected onNodeStart(
  _nodeName: string,
  _state: NodeStateInterface,
  _placementPath: readonly string[],        // ← NEW param
): void;

protected onNodeEnd(
  _nodeName: string,
  _output: string | null,                   // ← null not undefined
  _state: NodeStateInterface,
  _placementPath: readonly string[],        // ← NEW param
): void;

protected onError(
  _nodeName: string,
  _error: Error,
  _state: NodeStateInterface,
  _placementPath: readonly string[],        // ← NEW param
): void;

protected onPhaseEnter(
  _dagName: string,
  _phase: 'pre' | 'post',
  _placementName: string,
  _state: NodeStateInterface,
  _placementPath: readonly string[],        // ← NEW param
): void;

protected onPhaseExit(
  _dagName: string,
  _phase: 'pre' | 'post',
  _placementName: string,
  _state: NodeStateInterface,
  _placementPath: readonly string[],        // ← NEW param
): void;
```

### What squashage's `SquashageDagonizer.ts` must change

`/Users/studs/Workspace/squashage/src/dispatcher/SquashageDagonizer.ts`:

```ts
// BEFORE — wrong type names + wrong onNodeEnd signature
import type { ExecutionResultInterface, NodeStateInterface } from '@studnicky/dagonizer';
// ...
protected override onFlowEnd(
  dagName: string,
  state:   TState,
  _result: ExecutionResultInterface<TState>,  // ← wrong name
): void {
  this.#observer.recordFlowEnd(dagName, state.lifecycle.kind);  // ← .kind
}
protected override onNodeEnd(
  nodeName: string,
  output:   string | undefined,              // ← should be string | null
  _state:   TState,
): void { ... }

// AFTER
import type { ExecutionResultType, NodeStateInterface } from '@studnicky/dagonizer';
// ...
protected override onFlowEnd(
  dagName: string,
  state:   TState,
  _result: ExecutionResultType<NodeStateInterface>,
): void {
  this.#observer.recordFlowEnd(dagName, state.lifecycle.variant);  // ← .variant
}
protected override onNodeStart(
  nodeName: string,
  _state: TState,
  _placementPath: readonly string[],         // ← add trailing param
): void {
  this.#observer.recordNodeStart(nodeName);
}
protected override onNodeEnd(
  nodeName: string,
  output:   string | null,                   // ← null not undefined
  _state:   TState,
  _placementPath: readonly string[],         // ← add trailing param
): void {
  this.#observer.recordNodeEnd(nodeName, output);
}
protected override onError(
  nodeName: string,
  error: Error,
  _state: TState,
  _placementPath: readonly string[],         // ← add trailing param
): void {
  this.#observer.recordError(nodeName, error);
}
```

The observer interface (`ProvObserverInterface`) also passes `output: string | null` to `recordNodeEnd` — update that interface and its implementations (`ProvObserver`, `NullObserver`) to accept `string | null` instead of `string | undefined`.

---

## 5. DAG Authoring as `.dag.jsonld`

### `DAGBuilder` API — exact signatures (from `dist/builder/DAGBuilder.d.ts`)

```ts
class DAGBuilder {
  constructor(name: string, version: string);

  entrypoint(nodeName: string): this;

  node<TState, TOutput extends string, TServices>(
    name:    string,
    dagNode: NodeInterface<TState, TOutput, TServices>,
    routes:  Record<TOutput, string>,         // exhaustive: every output port must be wired
  ): this;

  scatter<TState, TOutput extends string, TServices>(
    name:    string,
    source:  string,                          // dotted path on state for the items array
    body:    NodeInterface<TState, TOutput, TServices>
           | { readonly dag: string }         // registered sub-DAG by name
           | { readonly dagFrom: string },    // runtime state path to dag name
    outputs: Record<string, string>,          // aggregate outcome routes
    options: ScatterOptionsType<TState>,      // REQUIRED (gather is required inside)
  ): this;

  embeddedDAG<TChildState, TParentState>(
    name:    string,
    dag:     string | { readonly from: string },
    outputs: Record<'success' | 'error', string>,
    options?: TypedEmbeddedDAGOptionsType<TChildState, TParentState>,
  ): this;

  terminal(name: string, options?: { outcome?: 'completed' | 'failed' }): this;

  phase<TState, TOutput extends string, TServices>(
    name:    string,
    phase:   'pre' | 'post',
    dagNode: NodeInterface<TState, TOutput, TServices>,
  ): this;

  build(): DAGType;
}
```

**`ScatterOptionsType`** (required fields):
```ts
type ScatterOptionsType<TState> = {
  itemKey?:    string;                  // metadata key written per clone; default 'currentItem'
  concurrency?: number;
  inputs?:     Partial<Record<string, string>>;  // child-state key → parent dotted path
  gather:      GatherConfigType;        // REQUIRED
  reducer?:    string;                  // default 'aggregate'
  container?:  string;                  // omit for in-process (squashage)
  reservoir?:  { keyField: string; capacity: number; idleMs?: number };
};
```

**`GatherConfigType`** shapes (from `dist/entities/dag/GatherConfig.d.ts`):
```ts
// strategy: 'discard' — no state flows back (side-effect-only)
{ strategy: 'discard' }

// strategy: 'partition' — partition output keys into named state arrays
{ strategy: 'partition', partitions: { success: 'succeededArr', error: 'failedArr' } }

// strategy: 'map' — copy one clone field into a named parent field per item
{ strategy: 'map', mapping: { childField: 'parentField' } }

// strategy: 'merge' — merge all clone deltas back into parent (field-by-field union)
{ strategy: 'merge' }
```

**`TypedEmbeddedDAGOptionsType`**:
```ts
type TypedEmbeddedDAGOptionsType = {
  inputs?:   Partial<Record<keyof TChildState & string, string>>;  // child key ← parent path
  outputs?:  Partial<Record<string, string>>;                      // parent path ← child path
  container?: string;                                              // omit for in-process
};
```

### Serializing with `DAGDocument`

```ts
import { DAGDocument } from '@studnicky/dagonizer';

const dag = new DAGBuilder('squashage:record', '1.0')
  .entrypoint('json-read')
  .node('json-read', jsonReadNode, { loaded: 'classify-all', quarantined: 'record-quarantine' })
  // ...
  .terminal('done', { outcome: 'completed' })
  .build();

// Write to disk as .dag.jsonld:
const json = DAGDocument.serialize(dag);  // pretty 2-space indent
await writeFile('src/dag/squashage-record.dag.jsonld', json, 'utf8');

// Load at runtime:
const loaded = DAGDocument.load(json);  // throws ValidationError on bad input
dispatcher.registerDAG(loaded);
```

### Ripperoni scatter example: `aonprd:crawl` scattering `aonprd:page`

`/Users/studs/Workspace/ripper/aonprd.dag.jsonld` (the ScatterNode placement):

```jsonld
{
  "@id": "urn:noocodex:dag:aonprd:crawl/node/scrape",
  "@type": "ScatterNode",
  "name": "scrape",
  "source": "urls",
  "body": { "dag": "aonprd:page" },
  "container": "worker",
  "itemKey": "currentUrl",
  "gather": {
    "strategy": "partition",
    "partitions": { "success": "succeeded", "error": "failed" }
  },
  "reducer": "aggregate",
  "outputs": {
    "all-success": "done",
    "partial":     "done",
    "all-error":   "done",
    "empty":       "done"
  }
}
```

Squashage equivalent (in-process, no `container: "worker"`):

```ts
new DAGBuilder('squashage:run', '1.0')
  .scatter(
    'dispatch-records',      // placement name
    'locators',              // source: state.locators (array of items)
    { dag: 'squashage:record' },  // body: registered sub-DAG by name
    {
      'all-success': 'finalize',
      'partial':     'finalize',
      'all-error':   'finalize',
      'empty':       'finalize',
    },
    {
      itemKey: 'currentLocator',
      gather:  { strategy: 'partition', partitions: { success: 'processedOk', error: 'processedErr' } },
    },
  )
  // ...
  .build();
```

### `EmbeddedDAGNode` example: `aonprd:crawl` embedding `crawl:discover`

`/Users/studs/Workspace/ripper/aonprd.dag.jsonld` (the EmbeddedDAGNode):

```jsonld
{
  "@id": "urn:noocodex:dag:aonprd:crawl/node/discover",
  "@type": "EmbeddedDAGNode",
  "name": "discover",
  "dag": "crawl:discover",
  "stateMapping": {
    "output": { "urls": "crawl.discovered" }
  },
  "outputs": { "success": "scrape", "error": "crawl-failed" }
}
```

Builder equivalent:
```ts
.embeddedDAG(
  'discover',
  'crawl:discover',
  { success: 'scrape', error: 'crawl-failed' },
  { outputs: { 'urls': 'crawl.discovered' } },  // parent path ← child path
)
```

### Replacing old `deepDAG` / `parallel` / `fanOut` builder methods

These do not exist in 0.25 `DAGBuilder`. Their replacements:

| Old method | 0.25 replacement |
|---|---|
| `.deepDAG(name, dagName, routes, opts)` | `.embeddedDAG(name, dagName, routes, opts)` |
| `.fanOut(name, source, body, routes, opts)` | `.scatter(name, source, body, routes, opts)` — but gather is now required in opts |
| `.parallel(...)` | No direct equivalent. Parallel node execution is now an engine concern via the work-set scheduler. Replace with sequential `SingleNode` placements or a `ScatterNode` if the parallelism was over items. |

---

## 6. Runner / Registration / Composition Root

### Ripperoni's `runDag.ts` pattern (condensed)

`/Users/studs/Workspace/ripper/src/run/runDag.ts`:

```ts
import { DAGDocument } from '@studnicky/dagonizer';

// (a) Load the .dag.jsonld file text and parse:
const dagJson = await readFile(opts.dagPath, 'utf-8');
const dag = DAGDocument.load(dagJson);   // throws ValidationError on bad JSON/schema

// (b) Build services from validated state params:
const htmlScraper = HtmlScraper.create({ baseUrl: state.baseUrl, ... });
const services: RipperServices = { log, htmlScraper, outDir, ... };

// (c) Construct dispatcher with services:
const dispatcher = new RipperDagonizer<ScrapeState>({ services });

// (d) Register nodes individually, then DAGs:
// Nodes are registered by calling dispatcher.registerNode(nodeInstance)
// The node's .name field is the key. DAG placements reference nodes by that name.
dispatcher.registerNode(HtmlFetchNode);          // HtmlFetchNode.name === 'html:fetch'
dispatcher.registerNode(JsonWriteNode);          // JsonWriteNode.name === 'json:write'
// ... more registerNode calls ...

// Then register DAGs (after all referenced nodes are registered):
dispatcher.registerDAG(pluginDag);
dispatcher.registerDAG(dag);          // orchestration last — references plugin DAGs

// (e) Execute:
const scrapeState = new ScrapeState();
await dispatcher.execute(dag.name, scrapeState);
// dispatcher.execute returns an Execution<TState> — awaitable or async-iterable
```

### Registration mechanism

- `dispatcher.registerNode(instance)` stores the node under `instance.name`.
- DAG document placements reference nodes by the `node` field in `SingleNode` entries (e.g. `"node": "html:fetch"`). The dispatcher resolves this name against the node registry at `registerDAG` time — if the node is not registered, `registerDAG` throws a `DAGError` immediately (semantic validation pass).
- `ScatterNode` body `{ dag: 'child-dag-name' }` resolves against the DAG registry.
- Registration order rule: all `registerNode` calls before `registerDAG` calls that reference those nodes.

### Squashage composition root (`SquashageRun`)

The existing `SquashageRun.ts` registers nodes and DAGs programmatically (via builder, not from `.dag.jsonld` files). This pattern works unchanged in 0.25 — the builder produces a `DAGType`, and `dispatcher.registerDAG(dag)` accepts it directly without going through `DAGDocument.load`. Moving to `.dag.jsonld` files (Section 5) is a later wave.

For the current migration, the minimal change to `SquashageRun.ts` is:
1. Remove the old `fanOut` / `deepDAG` / `parallel` builder calls (replace per Section 5).
2. Fix the stub function used for type-only node references — stubs must now include `timeout` and `outputSchema` to satisfy `NodeInterface`:

```ts
// BEFORE — stub misses timeout and outputSchema (TS2739)
function stub<TOutput extends string>(name: string, outputs: readonly TOutput[]): StubFor<TOutput> {
  return {
    name,
    outputs,
    async execute() { throw new Error(`stub for ${name} called`); },
  };
}

// AFTER — stubs satisfy NodeInterface by extending MonadicNode
import { MonadicNode } from '@studnicky/dagonizer';
import type { Batch, RoutedBatchType, NodeContextType } from '@studnicky/dagonizer';

function stub<TOutput extends string>(
  stubName: string,
  stubOutputs: readonly TOutput[],
): NodeInterface<SquashageRecordState, TOutput, SquashageServices> {
  class Stub extends MonadicNode<SquashageRecordState, TOutput, SquashageServices> {
    readonly name    = stubName;
    readonly outputs = stubOutputs;
    get outputSchema(): Record<TOutput, { type: 'object' }> {
      return Object.fromEntries(stubOutputs.map((o) => [o, { type: 'object' }])) as Record<TOutput, { type: 'object' }>;
    }
    async execute(_b: Batch<SquashageRecordState>, _c: NodeContextType<SquashageServices>): Promise<RoutedBatchType<TOutput, SquashageRecordState>> {
      throw new Error(`stub '${stubName}' called; register the real node on the dispatcher`);
    }
  }
  return new Stub();
}
```

---

## 7. Build Assets

### Ripperoni's `scripts/copy-dag-assets.mjs` in full

`/Users/studs/Workspace/ripper/scripts/copy-dag-assets.mjs`:

```mjs
// copy-dag-assets.mjs
// tsc never copies non-TS assets. Mirror .dag.jsonld from src/ → dist/ so
// the compiled CLI can load them by path relative to import.meta.dirname.

import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative }                  from 'node:path';

const SRC  = 'src';
const DIST = 'dist';

const stack = [SRC];
let copied = 0;
while (stack.length > 0) {
  const dir = stack.pop();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      stack.push(path);
    } else if (name.endsWith('.dag.jsonld')) {
      const dest = join(DIST, relative(SRC, path));
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(path, dest);
      copied += 1;
      process.stdout.write(`  copied ${dest}\n`);
    }
  }
}
process.stdout.write(`Copied ${copied.toString()} .dag.jsonld asset(s) into ${DIST}/\n`);
```

### Ripperoni `package.json` build wiring

```json
"scripts": {
  "build":        "tsc --noEmit false && npm run build:plugins && npm run build:workers && npm run build:assets",
  "build:assets": "node scripts/copy-dag-assets.mjs"
}
```

### Why this is needed

When squashage migrates DAG authoring to `.dag.jsonld` files (Wave 2), the compiled CLI under `dist/` will call `readFile('...dag.jsonld')` via a path derived from `import.meta.dirname` (which resolves to `dist/dag/`, not `src/dag/`). TypeScript's `tsc` only emits `.js` and `.d.ts` — it never copies non-TypeScript source files. `copy-dag-assets.mjs` mirrors the directory tree, keeping `dist/` in sync.

Squashage can adopt the same script verbatim. Wire it into `package.json`:

```json
"build:assets": "node scripts/copy-dag-assets.mjs",
"build":        "tsc --noEmit false && npm run build:assets"
```

If squashage has no `.dag.jsonld` files yet (DAGs still built by `DAGBuilder` in TypeScript code), skip this step — `tsc` output already has everything it needs.

---

## GOTCHAS

### 1. `outputSchema` is abstract on `MonadicNode` — Ripperoni's `.ts` source is also broken

Running `tsc --noEmit` in `/Users/studs/Workspace/ripper` produces `TS2515` errors on every node: "Non-abstract class does not implement inherited abstract member `outputSchema`." Ripperoni's compiled `.js` files pre-date this requirement and work at runtime (JS does no enforcement), but the `.ts` source is not clean. **Squashage must implement `outputSchema` on every node to achieve a clean compile.** The minimum passthrough:

```ts
get outputSchema(): Record<TOutput, { type: 'object' }> {
  return Object.fromEntries(this.outputs.map((o) => [o, { type: 'object' }])) as Record<TOutput, { type: 'object' }>;
}
```

### 2. `DagContainerInterface` is no longer generic in 0.25

Ripperoni's `RipperDagonizer.ts` line 16 uses `DagContainerInterface<TState>` (generic), which gives `TS2315: Type 'DagContainerInterface' is not generic`. Squashage is **not** adopting worker containers, so this is a non-issue. Omit `container:` from all DAG placements; do not pass `containers:` to the `Dagonizer` constructor.

### 3. `container: "worker"` in Ripperoni — omit in squashage

Ripperoni's `aonprd.dag.jsonld` has `"container": "worker"` on `ScatterNode` placements. This routes scatter items to a `WorkerThreadContainer` (from `@studnicky/dagonizer-executor-node`). Squashage is not adopting containers. When porting Ripperoni DAG examples, drop every `container` field. In-process scatter runs identically to container scatter; the only difference is parallelism model.

### 4. `parallel` builder method removed

Squashage's `recordDag.ts` calls `.parallel(...)` (and `recordInduceDag.ts` likewise). This method does not exist in 0.25. The semantics it provided — running multiple nodes "in parallel" over the same state — do not map to a single 0.25 primitive. The work-set scheduler runs independent placements concurrently by default when the DAG topology allows it. For squashage's classifier fan-out (multiple classifiers running on the same record), the correct replacement is sequential `SingleNode` placements connected from a shared entry, since each classifier writes to a separate `proposals[name]` slot and there is no shared write conflict that would require true parallelism.

### 5. `fanOut` / `deepDAG` builder methods removed

Neither exists in 0.25. Replace `fanOut` with `scatter`, replace `deepDAG` with `embeddedDAG`. The `scatter` options now require `gather` to be explicitly declared (there is no default). The minimum no-op gather: `{ strategy: 'discard' }`.

### 6. `NodeInterface.execute` now takes `Batch<TState>` not `TState`

The old API: `execute(state: TState, context): Promise<{ output: TOutput }>`.  
The 0.25 API: `execute(batch: Batch<TState>, context): Promise<RoutedBatchType<TOutput, TState>>`.

Object-literal nodes that implement `NodeInterface.execute` directly (not via `ScalarNode`) will see this break as type errors like `TS2339: Property 'input' does not exist on type 'Batch<SquashageRecordState>'`. The fix is always to extend `ScalarNode` and implement `executeOne(state: TState, ...)` instead — the base class provides the batch-loop.

### 7. `NodeContextType` shape change

Old: `{ readonly services: TServices }`.  
New: `{ dagName, nodeName, signal, services, validateOutputs, outputSchemaValidator }`.

Code accessing only `context.services` is unaffected. Code that destructures the full context or passes it as `{ readonly services: ... }` will fail. Update to accept the full `NodeContextType<TServices>`.

### 8. `stub()` nodes in DAG builders must satisfy `NodeInterface` (includes `timeout` + `outputSchema`)

The existing squashage `stub()` helper function creates bare object literals that satisfy the old interface but miss `timeout` and `outputSchema`. TS2739 errors confirm this. Use the `MonadicNode` subclass approach shown in Section 6.

### 9. `clone()` return type must be `this`

`NodeStateBase.clone(): this` — the return type is the polymorphic `this`. Concrete overrides that name a specific class (`clone(): SquashageRecordState`) are not assignable to `this` in all subtype scenarios. Remove the explicit return type annotation and cast via `super.clone() as this`.

### 10. JSON type renames do not affect the main barrel (`/`)

`JsonValue` (the class/value, a validator utility) is still exported from `@studnicky/dagonizer` main barrel. The *types* `JsonObjectType` and `JsonValueType` moved from `/types` (where they never existed in 0.25) to `/entities`. The `/types` subpath re-exports interface contracts, not JSON primitives. This is the root cause of every `TS2305: Module has no exported member 'JsonObject'` error.
