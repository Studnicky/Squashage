/**
 * classify:property-fingerprint — Jaccard-similarity classifier over the
 * record's top-level property key set.
 *
 * Loads a fingerprints JSON file (`{ <className>: { keys: string[] } }`) at
 * construction time, pre-computes a `Set<string>` per className, and at
 * execute time computes Jaccard against the record's top-level keys. The
 * highest-priority fingerprint above `minMatchScore` wins the slot.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageServices } from '../../../services/SquashageServices.js';
import type { ClassificationProposal } from '../../../state/schemas/ClassificationProposal.js';
import type { SquashageRecordState } from '../../../state/SquashageRecordState.js';

export interface PropertyFingerprintConfigInterface {
  readonly fingerprintsFrom: string;
  readonly minMatchScore?:   number | undefined;
  readonly priority?:        number | undefined;
}

interface CompiledFingerprintInterface {
  readonly className: string;
  readonly priority:  number;
  readonly keySet:    ReadonlySet<string>;
}

type Output = 'proposed' | 'no-match';

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const key of b) if (a.has(key)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export class PropertyFingerprintClassifierNode
  implements NodeInterface<SquashageRecordState, Output, SquashageServices> {

  readonly name    = 'classify:property-fingerprint';
  readonly outputs = ['proposed', 'no-match'] as const;
  readonly #fingerprints: ReadonlyArray<CompiledFingerprintInterface>;
  readonly #minMatchScore: number;

  constructor(config: PropertyFingerprintConfigInterface, schemasBase: string) {
    const absPath  = resolvePath(schemasBase, config.fingerprintsFrom);
    const priority = config.priority ?? 32;
    const threshold = config.minMatchScore ?? 0.85;
    if (threshold < 0 || threshold > 1) {
      throw new Error(`classify:property-fingerprint: minMatchScore must be in [0,1], got ${threshold.toString()}`);
    }

    const text = readFileSync(absPath, 'utf8');
    const raw  = JSON.parse(text) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`classify:property-fingerprint: fingerprints file ${absPath} must be an object`);
    }

    const compiled: CompiledFingerprintInterface[] = [];
    for (const [className, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null || !('keys' in entry)) {
        throw new Error(`classify:property-fingerprint: entry "${className}" missing "keys" array`);
      }
      const keys = (entry as Record<string, unknown>)['keys'] as unknown[];
      if (!Array.isArray(keys) || keys.length === 0) {
        throw new Error(`classify:property-fingerprint: entry "${className}" has empty keys`);
      }
      compiled.push({
        className,
        priority,
        keySet: Object.freeze(new Set(keys.map((k) => String(k)))) as ReadonlySet<string>,
      });
    }

    this.#fingerprints = Object.freeze(compiled);
    this.#minMatchScore = threshold;
  }

  async execute(
    state:    SquashageRecordState,
    _context: { readonly services: SquashageServices },
  ): Promise<{ output: Output }> {
    const recordKeys = new Set(Object.keys(state.input).filter((k) => k !== '_source'));

    let bestMatch: CompiledFingerprintInterface | null = null;
    let bestScore = 0;
    const matchedReasons: string[] = [];

    for (const fp of this.#fingerprints) {
      const score = jaccard(recordKeys, fp.keySet);
      if (score >= this.#minMatchScore) {
        matchedReasons.push(`fingerprint:${fp.className} jaccard=${score.toFixed(3)}`);
        if (bestMatch === null || fp.priority > bestMatch.priority || score > bestScore) {
          bestMatch = fp;
          bestScore = score;
        }
      }
    }

    if (bestMatch === null) return { output: 'no-match' };

    const proposal: ClassificationProposal = {
      source:     'classify:property-fingerprint',
      className:  bestMatch.className,
      priority:   bestMatch.priority,
      confidence: bestScore,
      reasons:    matchedReasons,
    };
    state.proposals['classify:property-fingerprint'] = proposal;
    return { output: 'proposed' };
  }
}
