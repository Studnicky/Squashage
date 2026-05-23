/**
 * classify:taxonomic-narrowing — post-proposer, pre-resolver classifier that
 * drops supertype proposals when a more-specific subtype is also present in
 * `state.proposals`.
 *
 * Runs SEQUENTIALLY after the parallel classifier placement so it can see
 * every classifier's proposal. Computes the transitive `owl:subClassOf`
 * closure once in the constructor from a TBox source (file path or `'ontology'`
 * — the latter requires `services.ontology` to be present).
 *
 * Effect on state: removes supertype entries from `state.proposals` and adds a
 * `__narrowing_applied__` sentinel summarising the narrowing audit trail.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import type { Quad } from '@rdfjs/types';
import type { NodeInterface } from '@noocodex/dagonizer';

import { Parser } from '../../../rdf/Parser.js';

import type { JsonTologyOntology } from '../../../ontology/JsonTologyOntology.js';
import type { SquashageServices } from '../../../services/SquashageServices.js';
import type { ClassificationProposal } from '../../../state/schemas/ClassificationProposal.js';
import type { SquashageRecordState } from '../../../state/SquashageRecordState.js';

const OWL_SUB_CLASS_OF = 'http://www.w3.org/2002/07/owl#subClassOf';

export interface TaxonomicNarrowingConfigInterface {
  /** `'ontology'` to read from `services.ontology`, or a Turtle / N-Quads file path. */
  readonly tboxFrom: string;
  readonly enabled?: boolean | undefined;
}

type Output = 'narrowed' | 'no-op';

const SENTINELS = new Set<string>(['__source__', '__validation__', '__narrowing_applied__', 'unknown']);

function lastSegment(iri: string): string {
  const hashIdx = iri.indexOf('#');
  if (hashIdx !== -1) {
    const fragment = iri.slice(hashIdx + 1);
    if (fragment.length > 0) return fragment;
  }
  const segment = iri.split('/').pop();
  return segment ?? '';
}

function buildClosure(quads: ReadonlyArray<Quad>): Map<string, Set<string>> {
  const direct = new Map<string, Set<string>>();
  for (const quad of quads) {
    if (quad.predicate.value !== OWL_SUB_CLASS_OF) continue;
    if (quad.subject.termType !== 'NamedNode' || quad.object.termType !== 'NamedNode') continue;
    const sub = lastSegment(quad.subject.value);
    const sup = lastSegment(quad.object.value);
    if (sub.length === 0 || sup.length === 0 || sub === sup) continue;
    const existing = direct.get(sub);
    if (existing !== undefined) existing.add(sup); else direct.set(sub, new Set([sup]));
  }

  const closure = new Map<string, Set<string>>();
  for (const [sub, supers] of direct) closure.set(sub, new Set(supers));

  let changed = true;
  while (changed) {
    changed = false;
    for (const [sub, supers] of closure) {
      const additions: string[] = [];
      for (const sup of supers) {
        const next = closure.get(sup);
        if (next === undefined) continue;
        for (const t of next) {
          if (!supers.has(t) && t !== sub) additions.push(t);
        }
      }
      for (const a of additions) { supers.add(a); changed = true; }
    }
  }
  return closure;
}

async function parseTurtleOrNquads(absPath: string, text: string): Promise<Quad[]> {
  const format  = absPath.endsWith('.nq') ? 'nquads' as const : 'turtle' as const;
  const result  = await Parser.parse(text, { format });
  return result.quads as Quad[];
}

export class TaxonomicNarrowingClassifierNode
  implements NodeInterface<SquashageRecordState, Output, SquashageServices> {

  readonly name    = 'classify:taxonomic-narrowing';
  readonly outputs = ['narrowed', 'no-op'] as const;
  readonly #enabled: boolean;
  readonly #closure: Map<string, Set<string>>;

  private constructor(enabled: boolean, closure: Map<string, Set<string>>) {
    this.#enabled = enabled;
    this.#closure = closure;
  }

  /** Build from config; reads TBox file synchronously when `tboxFrom` is a path. */
  static async forConfig(
    config:      TaxonomicNarrowingConfigInterface,
    schemasBase: string,
    ontology:    JsonTologyOntology | null,
  ): Promise<TaxonomicNarrowingClassifierNode> {
    const enabled = config.enabled !== false;
    if (!enabled) {
      return new TaxonomicNarrowingClassifierNode(false, new Map());
    }

    if (config.tboxFrom === 'ontology') {
      if (ontology === null) {
        // No ontology configured → disabled silently per silo contract.
        return new TaxonomicNarrowingClassifierNode(false, new Map());
      }
      const quads = await ontology.tbox();
      return new TaxonomicNarrowingClassifierNode(true, buildClosure(quads));
    }

    const absPath = resolvePath(schemasBase, config.tboxFrom);
    const text    = readFileSync(absPath, 'utf8');
    const quads   = await parseTurtleOrNquads(absPath, text);
    return new TaxonomicNarrowingClassifierNode(true, buildClosure(quads));
  }

  async execute(
    state:    SquashageRecordState,
    _context: { readonly services: SquashageServices },
  ): Promise<{ output: Output }> {
    if (!this.#enabled || this.#closure.size === 0) return { output: 'no-op' };

    const realEntries = Object.entries(state.proposals).filter(
      ([, p]) => !SENTINELS.has(p.className),
    );
    if (realEntries.length < 2) return { output: 'no-op' };

    const proposedClassNames = new Set(realEntries.map(([, p]) => p.className));
    const toRemove = new Set<string>();
    const toKeep   = new Set<string>();

    for (const cls of proposedClassNames) {
      let isSupertype = false;
      for (const other of proposedClassNames) {
        if (other === cls) continue;
        const otherClosure = this.#closure.get(other);
        if (otherClosure !== undefined && otherClosure.has(cls)) {
          isSupertype = true;
          break;
        }
      }
      if (isSupertype) toRemove.add(cls); else toKeep.add(cls);
    }

    if (toRemove.size === 0) return { output: 'no-op' };

    // Drop proposal slots whose className is in toRemove.
    const reasons: string[] = [];
    for (const [classifierName, proposal] of realEntries) {
      if (toRemove.has(proposal.className)) {
        delete state.proposals[classifierName];
        for (const kept of toKeep) {
          const keptClosure = this.#closure.get(kept);
          if (keptClosure !== undefined && keptClosure.has(proposal.className)) {
            reasons.push(`narrowed: ${kept} subClassOf ${proposal.className}; dropped ${proposal.className}`);
          }
        }
      }
    }

    const sentinel: ClassificationProposal = {
      source:     'classify:taxonomic-narrowing',
      className:  '__narrowing_applied__',
      priority:   0,
      confidence: 1,
      reasons,
    };
    state.proposals['classify:taxonomic-narrowing'] = sentinel;
    return { output: 'narrowed' };
  }
}
