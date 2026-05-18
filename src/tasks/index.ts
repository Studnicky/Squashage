/**
 * @fileoverview Side-effect entry point that registers every built-in pipeline
 * task, every context lifecycle plugin, and every classifier plugin onto the
 * global {@link TaskRegistry}.
 *
 * @remarks
 * Squashage's `SquashageOrchestrator` and CLI both `import './tasks/index.js'`
 * once at startup. Each `import` statement below has a side effect:
 *
 * 1. Built-in pipeline tasks (`jsonRead`, `rdfjsFinalize`, `rdfjsStream`,
 *    `ontologyEmit`, `provenanceEmit`, `entityLink`) self-register their
 *    per-record task functions onto the global registry.
 *
 * 2. The context lifecycle aggregator (`../context/index.js`, Task #11)
 *    side-effect-registers every `context:*` `onRunStart` hook in deterministic
 *    order so the run-wide silo (logger, AJV, dataset, prefixes, ontology,
 *    runStartTime) is populated before any classifier or per-record task
 *    runs.
 *
 * 3. The classification aggregator (`../classification/index.js`, Task #23)
 *    side-effect-registers every `classify:*` per-record task AND its
 *    `onRunStart` config-validation/compile hook.
 *
 * Importing this file is the canonical single-line way to bootstrap the
 * orchestrator: the global registry is fully populated when this module's
 * evaluation finishes. Tests that import this file get the same fully-wired
 * registry; tests that intentionally start with an empty registry must
 * construct their own `TaskRegistry` instance and avoid this import.
 *
 * @example
 * ```ts
 * import './tasks/index.js';
 * // TaskRegistry now contains every built-in pipeline task, every
 * // `context:*` lifecycle hook, and every `classify:*` plugin task + hook.
 * ```
 *
 * @category Tasks
 * @since 0.1.0
 * @see {@link TaskRegistry}
 * @group Tasks
 */

import '../context/index.js';
import '../classification/index.js';
import './jsonRead.js';
import './rdfjsFinalize.js';
import './rdfjsStream.js';
import './ontologyEmit.js';
import './provenanceEmit.js';
import './entityLink.js';
import './emitCatalog.js';
