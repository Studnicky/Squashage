/**
 * classify:discriminator — resolves a className proposal by reading a
 * configured field directly from the record via JSON Pointer (RFC 6901).
 *
 * This is an open-world classifier: it does not require per-className
 * enumeration in config. Any non-empty string at the resolved pointer is
 * used as-is (or sanitized) as the className proposal.
 *
 * Config example:
 *   { "from": "/_type" }                     // reads _type verbatim
 *   { "from": "/_type", "sanitize": "pascalCase" }  // monster-family → MonsterFamily
 */

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageServices } from '../../../services/SquashageServices.js';
import type { ClassificationProposal } from '../../../state/schemas/ClassificationProposal.js';
import type { SquashageRecordState } from '../../../state/SquashageRecordState.js';

export interface DiscriminatorClassifierConfigInterface {
  /** JSON Pointer (RFC 6901) into the record. */
  readonly from: string;
  /** JSON Pointer used when `from` resolves to undefined or non-string. */
  readonly fallback?: string | undefined;
  /** Optional priority for the proposal; defaults to 50. */
  readonly priority?: number | undefined;
  /** Optional sanitize step on the resolved value before using as className. */
  readonly sanitize?: 'verbatim' | 'pascalCase' | 'kebabToPascal' | undefined;
}

type Output = 'proposed' | 'no-match';

// ─── JSON Pointer (RFC 6901) ──────────────────────────────────────────────────

/**
 * Resolve a JSON Pointer against an object.
 *
 * Handles `~0` → `~` and `~1` → `/` token unescaping per RFC 6901 §3.
 * Returns `undefined` when any segment is absent or the value is not
 * navigable.
 */
function resolvePointer(obj: Record<string, unknown>, pointer: string): unknown {
  if (pointer === '') return obj;
  if (!pointer.startsWith('/')) return undefined;

  const tokens = pointer.slice(1).split('/');
  let cursor: unknown = obj;

  for (const raw of tokens) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    // RFC 6901 §3: unescape ~1 first, then ~0 (order matters).
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    cursor = (cursor as Record<string, unknown>)[key];
  }

  return cursor;
}

// ─── Sanitize policies ────────────────────────────────────────────────────────

type SanitizeFn = (value: string) => string;

/**
 * Split on `[-_\s]+` boundaries, PascalCase each segment, concat.
 *
 * `monster-family` → `MonsterFamily`, `spell_list` → `SpellList`.
 */
function sanitizePascalCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

const SANITIZE_MAP: Record<NonNullable<DiscriminatorClassifierConfigInterface['sanitize']>, SanitizeFn> = {
  verbatim:     (v) => v,
  pascalCase:   sanitizePascalCase,
  kebabToPascal: sanitizePascalCase,
};

// ─── Node ─────────────────────────────────────────────────────────────────────

export class DiscriminatorClassifierNode
  implements NodeInterface<SquashageRecordState, Output, SquashageServices> {

  readonly name    = 'classify:discriminator';
  readonly outputs = ['proposed', 'no-match'] as const;

  readonly #config: DiscriminatorClassifierConfigInterface;

  constructor(config: DiscriminatorClassifierConfigInterface) {
    this.#config = config;
  }

  async execute(
    state:    SquashageRecordState,
    _context: { readonly services: SquashageServices },
  ): Promise<{ output: Output }> {
    const rawValue = this.#resolve(state.input);

    if (rawValue === undefined) return { output: 'no-match' };

    const sanitizeFn  = SANITIZE_MAP[this.#config.sanitize ?? 'verbatim'];
    const className   = sanitizeFn(rawValue);
    const priority    = this.#config.priority ?? 50;

    const proposal: ClassificationProposal = {
      source:     'classify:discriminator',
      className,
      priority,
      confidence: 1.0,
      reasons:    [`discriminator at "${this.#config.from}" resolved to "${rawValue}"`],
    };

    state.proposals['classify:discriminator'] = proposal;
    return { output: 'proposed' };
  }

  // ─── private helpers ───────────────────────────────────────────────────────

  #resolve(input: Record<string, unknown>): string | undefined {
    const primary = resolvePointer(input, this.#config.from);
    if (typeof primary === 'string' && primary.length > 0) return primary;

    if (this.#config.fallback !== undefined) {
      const fb = resolvePointer(input, this.#config.fallback);
      if (typeof fb === 'string' && fb.length > 0) return fb;
    }

    return undefined;
  }
}
