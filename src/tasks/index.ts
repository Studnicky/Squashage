/**
 * @fileoverview Side-effect entry point that registers every built-in pipeline task.
 *
 * @remarks
 * Squashage's `SquashageOrchestrator` and CLI both `import './tasks/index.js'` once
 * at startup. Each `import` statement below has a side effect: the task module's
 * top-level `TaskRegistry.register(...)` call runs, populating the global registry
 * before the orchestrator builds a per-target `Pipeline`. Importing this file is
 * the canonical way to bootstrap built-in tasks; plugins extend the registry the
 * same way (their own modules call `TaskRegistry.register(...)`).
 *
 * @example
 * ```ts
 * import './tasks/index.js';
 * // TaskRegistry now contains 'json:read', 'rdfjs:finalize', 'ontology:emit', 'output:provenance', and 'enrich:entity-link'.
 * ```
 *
 * @category Tasks
 * @since 0.1.0
 * @see {@link TaskRegistry}
 * @group Tasks
 */

import './jsonRead.js';
import './rdfjsFinalize.js';
import './rdfjsStream.js';
import './ontologyEmit.js';
import './provenanceEmit.js';
import './entityLink.js';
