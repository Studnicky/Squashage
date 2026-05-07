/**
 * @fileoverview Taxonomic-narrowing classifier task for the Squashage pipeline.
 *
 * @remarks
 * Provides {@link TaxonomicNarrowingClassifier}, a post-proposer, pre-resolver
 * classifier that collapses sibling-vs-supertype proposals by consulting the
 * OWL `subClassOf` transitive closure derived from the configured TBox.
 *
 * When multiple proposals disagree and the proposed class names form a
 * subClassOf chain in the TBox closure (e.g. `Weapon subClassOf Equipment`),
 * the supertype proposals are dropped and only the most-specific proposal(s)
 * survive. If the proposed classes are unrelated (no subClassOf relation in the
 * closure), all proposals pass through untouched for ConflictResolver to decide.
 *
 * A synthetic audit-trail proposal is appended to `state.classifications` when
 * narrowing actually fires. ConflictResolver filters it out via
 * `METADATA_SENTINELS` the same way it filters `__validation__`.
 *
 * TBox source is configured via {@link TaxonomicNarrowingConfigInterface.tboxFrom}:
 * - `"ontology"` reads `state.context.jt.tbox()` (async, called once per record
 *   until the closure is cached on the instance).
 * - Any other string is treated as a filesystem path to a Turtle/N-Quads OWL
 *   TBox, loaded and parsed once at construction time.
 *
 * @module
 * @since 0.5.0
 * @category Classification
 */

import { readFileSync } from 'node:fs';
import { resolve }      from 'node:path';

import type { Quad } from '@rdfjs/types';
import { Parser }    from '../../rdf/Parser.js';
import { OutputConfigError } from '../../errors/OutputConfigError.js';
import { Logger }    from '../../modules/logger/logger.js';
import type { TaskFnInterface, NextFnInterface } from '../../types/Pipeline.js';
import type {
  PipelineStateInterface,
  ClassificationProposalInterface,
} from '../../types/PipelineState.js';

const logger = Logger.forComponent('TaxonomicNarrowingClassifier');

// ── OWL vocabulary ────────────────────────────────────────────────────────────

const OWL_SUB_CLASS_OF = 'http://www.w3.org/2002/07/owl#subClassOf';

// ── Config interface ──────────────────────────────────────────────────────────

/**
 * Configuration for {@link TaxonomicNarrowingClassifier}.
 *
 * @category Classification
 * @since 0.5.0
 * @group Types
 */
export interface TaxonomicNarrowingConfigInterface {
  /**
   * TBox source selector.
   *
   * @remarks
   * `"ontology"` resolves from `state.context.jt.tbox()` (auto-derived from the
   * target's json-tology engine). Any other string is interpreted as a filesystem
   * path to a Turtle or N-Quads OWL TBox file, resolved at construction time.
   */
  readonly tboxFrom: 'ontology' | string;

  /**
   * Whether the classifier is enabled.
   *
   * @defaultValue false
   */
  readonly enabled?: boolean | undefined;
}

// ── TaxonomicNarrowingClassifier ──────────────────────────────────────────────

/**
 * Post-proposer, pre-resolver classifier that narrows sibling-vs-supertype
 * proposals via OWL `subClassOf` transitive closure.
 *
 * @remarks
 * Runs AFTER all class-proposing classifiers (source, structural, rules, schema,
 * shaclShape, ontology) but BEFORE ConflictResolver. Its only effect is to
 * remove supertype proposals when a more-specific subtype proposal also exists.
 *
 * It never adds new class proposals. It only removes existing ones.
 *
 * @example
 * ```ts
 * const narrower = TaxonomicNarrowingClassifier.create({
 *   tboxFrom: 'ontology',
 *   enabled:  true,
 * });
 * registry.register('classify:taxonomic-narrowing', narrower.execute);
 * ```
 *
 * @category Classification
 * @since 0.5.0
 * @see {@link TaxonomicNarrowingConfigInterface}
 * @group Tasks
 */
export class TaxonomicNarrowingClassifier {
  readonly #config:     TaxonomicNarrowingConfigInterface;
  /**
   * Pre-parsed TBox quads for file-path mode; null when using ontology mode.
   * Stored as a Promise to allow async parsing at startup.
   */
  readonly #fileTbox:   Promise<ReadonlyArray<Quad>> | null;
  /**
   * Cached transitive subClassOf closure built from the TBox quads.
   * Maps each className (last fragment/segment of class IRI) to the set of
   * all transitive superclass names (also last fragment/segment).
   *
   * Built once per classifier instance (lazily on first execute that can load
   * the quads). In ontology mode the jt instance is taken from the first record
   * processed; subsequent records reuse the same closure without re-parsing.
   */
  #closureCache: Map<string, Set<string>> | null = null;

  // ── Static factory ──────────────────────────────────────────────────────────

  /**
   * Builds a {@link TaxonomicNarrowingClassifier} from the provided config.
   *
   * @remarks
   * When `tboxFrom` is a filesystem path the file is read and parsed at
   * construction time (once per run). When `tboxFrom === 'ontology'` no file
   * I/O occurs at construction; the TBox is resolved from `state.context.jt`
   * on first execute.
   *
   * @param config      - Taxonomic-narrowing classifier config.
   * @param schemasBase - Base directory for resolving relative file paths. Only
   *   used when `tboxFrom` is a path string; defaults to `process.cwd()`.
   * @returns A fully initialised {@link TaxonomicNarrowingClassifier} instance.
   * @throws {OutputConfigError} When the TBox file is missing or unparseable.
   */
  public static create(
    config:      TaxonomicNarrowingConfigInterface,
    schemasBase: string = process.cwd(),
  ): TaxonomicNarrowingClassifier {
    logger.debug('create', 'Creating TaxonomicNarrowingClassifier', {
      tboxFrom: config.tboxFrom,
      enabled:  config.enabled ?? false,
    });

    if (config.tboxFrom === 'ontology') {
      return new TaxonomicNarrowingClassifier(config, null);
    }

    // File-path mode: read synchronously, then parse async.
    const absPath = resolve(schemasBase, config.tboxFrom);
    let text: string;
    try {
      text = readFileSync(absPath, 'utf-8');
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw OutputConfigError.create(
        `classify:taxonomic-narrowing: cannot read TBox file at ${absPath}: ${cause?.message ?? String(err)}`,
        { cause, metadata: { tboxFrom: config.tboxFrom, absPath } },
      );
    }

    // Infer format from extension; default to Turtle.
    const format = absPath.endsWith('.nq') || absPath.endsWith('.n-quads') ? 'nquads' : 'turtle';
    const tboxPromise = Parser.parse(text, { format }).then(result => {
      logger.debug('create', 'Loaded TBox file', { absPath, quadCount: result.quads.length });
      return result.quads;
    });

    return new TaxonomicNarrowingClassifier(config, tboxPromise);
  }

  // ── Private constructor ─────────────────────────────────────────────────────

  private constructor(
    config:   TaxonomicNarrowingConfigInterface,
    fileTbox: Promise<ReadonlyArray<Quad>> | null,
  ) {
    this.#config   = config;
    this.#fileTbox = fileTbox;
  }

  // ── Execute ────────────────────────────────────────────────────────────────

  /**
   * Pipeline task function bound to this instance.
   *
   * @remarks
   * Per-record flow:
   * 1. If `enabled` is false (the default), calls `next()` immediately (no-op).
   * 2. In ontology mode, if `state.context.jt` is absent, calls `next()` (no-op).
   * 3. Builds/retrieves the transitive subClassOf closure.
   * 4. Groups current proposals by className, excluding metadata sentinels.
   * 5. If only one distinct className is present, passes through (no narrowing needed).
   * 6. For each proposed className, checks whether any other proposed className is
   *    a more-specific subtype. Drops proposals whose className is a supertype of
   *    another proposed className.
   * 7. If any proposals were dropped, appends a `__narrowing_applied__` sentinel
   *    for audit trail.
   * 8. Always calls `next()`.
   *
   * @param next  - Pipeline continuation; always called.
   * @param state - Mutable pipeline state for the current record.
   */
  public readonly execute: TaskFnInterface<PipelineStateInterface> = async (
    next: NextFnInterface,
    state: PipelineStateInterface,
  ): Promise<void> => {
    logger.debug('execute', 'Running taxonomic narrowing', { targetId: state.targetId });

    // Guard: disabled -> no-op.
    if (this.#config.enabled !== true) {
      await next();
      return;
    }

    // Guard: ontology mode with no jt -> no-op.
    if (this.#config.tboxFrom === 'ontology' && state.context?.jt === undefined) {
      logger.debug('execute', 'tboxFrom=ontology but state.context.jt absent, no-op', {
        targetId: state.targetId,
      });
      await next();
      return;
    }

    // Build/retrieve the closure.
    const closure = await this.#getOrBuildClosure(state);

    if (closure.size === 0) {
      logger.debug('execute', 'Empty TBox closure, no-op', { targetId: state.targetId });
      await next();
      return;
    }

    // Separate sentinel proposals from real proposals.
    const SENTINELS = new Set<string>(['__source__', '__validation__', '__narrowing_applied__', 'unknown']);
    const sentinelProposals = state.classifications.filter(p => SENTINELS.has(p.className));
    const realProposals     = state.classifications.filter(p => !SENTINELS.has(p.className));

    // Gather distinct proposed classNames.
    const proposedClassNames = new Set<string>(realProposals.map(p => p.className));

    if (proposedClassNames.size <= 1) {
      // Nothing to narrow.
      await next();
      return;
    }

    // For each proposed className, check if any other proposed className is its
    // subtype (i.e., the other class's closure contains this className as a
    // supertype). If so, this class is a supertype and should be dropped.
    const toKeep = new Set<string>();
    const toRemove = new Set<string>();

    for (const candidate of proposedClassNames) {
      // candidate is a supertype if any other proposed class has it in its
      // transitive supertype set (closure).
      let isSupertype = false;
      for (const other of proposedClassNames) {
        if (other === candidate) continue;
        const otherClosure = closure.get(other);
        if (otherClosure !== undefined && otherClosure.has(candidate)) {
          isSupertype = true;
          break;
        }
      }
      if (isSupertype) {
        toRemove.add(candidate);
      } else {
        toKeep.add(candidate);
      }
    }

    if (toRemove.size === 0) {
      // All proposed classes are unrelated; pass through for ConflictResolver.
      logger.debug('execute', 'No supertype proposals found, pass through', {
        targetId:       state.targetId,
        proposedClasses: [...proposedClassNames],
      });
      await next();
      return;
    }

    // Drop supertype proposals and keep the more-specific ones.
    const survivingProposals = realProposals.filter(p => toKeep.has(p.className));

    // Build audit-trail reasons.
    const narrowingReasons: string[] = [];
    for (const removed of toRemove) {
      for (const kept of toKeep) {
        const keptClosure = closure.get(kept);
        if (keptClosure !== undefined && keptClosure.has(removed)) {
          narrowingReasons.push(`narrowed: ${kept} subClassOf ${removed}; dropped ${removed}`);
        }
      }
    }

    const sentinel: ClassificationProposalInterface = {
      source:     'classify:taxonomic-narrowing',
      className:  '__narrowing_applied__',
      priority:   0,
      confidence: 1,
      reasons:    narrowingReasons,
    };

    logger.info('execute', 'Taxonomic narrowing applied', {
      targetId:        state.targetId,
      kept:            [...toKeep],
      dropped:         [...toRemove],
      narrowingReasons,
    });

    (state as unknown as { classifications: ReadonlyArray<ClassificationProposalInterface> }).classifications = [
      ...sentinelProposals,
      ...survivingProposals,
      sentinel,
    ];

    await next();
  };

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Returns the cached closure, or builds and caches it on first call.
   *
   * @param state - Current pipeline state (used to access `jt` in ontology mode).
   * @returns The transitive subClassOf closure.
   */
  async #getOrBuildClosure(state: PipelineStateInterface): Promise<Map<string, Set<string>>> {
    if (this.#closureCache !== null) return this.#closureCache;

    let quads: ReadonlyArray<Quad>;

    if (this.#fileTbox !== null) {
      quads = await this.#fileTbox;
    } else {
      // Ontology mode: jt presence was already guarded in execute.
      quads = await state.context!.jt!.tbox();
    }

    this.#closureCache = TaxonomicNarrowingClassifier.buildClosure(quads);
    return this.#closureCache;
  }

  // ── Public static helpers (exposed for unit tests) ─────────────────────────

  /**
   * Builds a transitive subClassOf closure from a flat array of OWL TBox quads.
   *
   * @remarks
   * Only `owl:subClassOf` quads with two NamedNode terms (subject and object)
   * are considered. The closure is computed via iterative expansion (Warshall-style)
   * until no new entries are added.
   *
   * Class names are derived from the last `#`-fragment or `/`-segment of the
   * class IRI, mirroring the convention used elsewhere in the pipeline.
   *
   * Cyclic `subClassOf` declarations (which are invalid OWL but may appear in
   * hand-written TBoxes) are handled gracefully: the algorithm terminates because
   * each pass only adds, never removes, entries.
   *
   * @param quads - OWL TBox quads (may include non-subClassOf quads; those are ignored).
   * @returns Map from className to the Set of transitive superclass names.
   *
   * @example
   * ```ts
   * // Given: Sword subClassOf Weapon, Weapon subClassOf Equipment
   * // Returns: Map { 'Sword' -> Set { 'Weapon', 'Equipment' }, 'Weapon' -> Set { 'Equipment' }, ... }
   * const closure = TaxonomicNarrowingClassifier.buildClosure(tboxQuads);
   * ```
   */
  public static buildClosure(quads: ReadonlyArray<Quad>): Map<string, Set<string>> {
    // Step 1: collect direct subClassOf pairs as className -> Set<directSuperclassName>.
    const direct = new Map<string, Set<string>>();

    for (const quad of quads) {
      if (quad.predicate.value !== OWL_SUB_CLASS_OF) continue;
      if (quad.subject.termType !== 'NamedNode') continue;
      if (quad.object.termType !== 'NamedNode') continue;

      const sub   = TaxonomicNarrowingClassifier.#lastSegment(quad.subject.value);
      const sup   = TaxonomicNarrowingClassifier.#lastSegment(quad.object.value);

      if (sub.length === 0 || sup.length === 0 || sub === sup) continue;

      const existing = direct.get(sub);
      if (existing !== undefined) {
        existing.add(sup);
      } else {
        direct.set(sub, new Set([sup]));
      }
    }

    if (direct.size === 0) return new Map();

    // Step 2: compute transitive closure via iterative expansion.
    // closure[A] = all classes B such that A subClassOf* B (i.e., B is a supertype of A).
    const closure = new Map<string, Set<string>>();

    // Seed with direct entries.
    for (const [sub, supers] of direct) {
      closure.set(sub, new Set(supers));
    }

    // Iterate until fixpoint.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [sub, supers] of closure) {
        const toAdd: string[] = [];
        for (const sup of supers) {
          const supSupers = closure.get(sup);
          if (supSupers !== undefined) {
            for (const transitive of supSupers) {
              if (!supers.has(transitive) && transitive !== sub) {
                toAdd.push(transitive);
              }
            }
          }
        }
        for (const s of toAdd) {
          supers.add(s);
          changed = true;
        }
      }
    }

    return closure;
  }

  /**
   * Returns the last `#`-fragment or `/`-segment from an IRI string.
   *
   * @remarks
   * For `https://example.org/vocabulary#Weapon` returns `"Weapon"`.
   * For `https://example.org/Equipment` returns `"Equipment"`.
   * A `#` fragment takes priority when the IRI contains `#`.
   *
   * @internal
   */
  static #lastSegment(iri: string): string {
    const hashIdx = iri.indexOf('#');
    if (hashIdx !== -1) {
      const fragment = iri.slice(hashIdx + 1);
      if (fragment.length > 0) return fragment;
    }
    const segment = iri.split('/').pop();
    return segment !== undefined ? segment : '';
  }
}
