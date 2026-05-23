/**
 * classify:schema — JSON Schema (AJV) validator-based classifier.
 *
 * Loads each `{ className, priority, schemaPath }` entry's schema file at
 * construction time, compiles it via the run-wide `services.ajv` (passed
 * separately because it's not yet available in the constructor), and emits
 * one proposal per validator that returns `true`. Highest-priority match
 * wins the slot in `state.proposals['classify:schema']`.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import type { Ajv, ValidateFunction } from 'ajv';
import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageServices } from '../../../services/SquashageServices.js';
import type { ClassificationProposal } from '../../../state/schemas/ClassificationProposal.js';
import type { SquashageRecordState } from '../../../state/SquashageRecordState.js';

export interface RawSchemaEntryInterface {
  readonly className:  string;
  readonly priority:   number;
  readonly schemaPath: string;
}

interface CompiledEntryInterface {
  readonly className: string;
  readonly priority:  number;
  readonly validate:  ValidateFunction;
}

type Output = 'proposed' | 'no-match';

export class SchemaClassifierNode
  implements NodeInterface<SquashageRecordState, Output, SquashageServices> {

  readonly name    = 'classify:schema';
  readonly outputs = ['proposed', 'no-match'] as const;
  readonly #entries: ReadonlyArray<CompiledEntryInterface>;

  constructor(
    entries:     ReadonlyArray<RawSchemaEntryInterface>,
    ajv:         Ajv,
    schemasBase: string,
  ) {
    if (entries.length === 0) {
      throw new Error('classify:schema requires at least one entry');
    }
    this.#entries = Object.freeze(entries.map((raw) => {
      const absPath = resolvePath(schemasBase, raw.schemaPath);
      const text    = readFileSync(absPath, 'utf8');
      const schema  = JSON.parse(text) as Record<string, unknown>;
      const validate = ajv.compile(schema);
      return { className: raw.className, priority: raw.priority, validate };
    }));
  }

  async execute(
    state:    SquashageRecordState,
    _context: { readonly services: SquashageServices },
  ): Promise<{ output: Output }> {
    const matches: CompiledEntryInterface[] = [];
    for (const entry of this.#entries) {
      if (entry.validate(state.input)) {
        matches.push(entry);
      }
    }
    if (matches.length === 0) return { output: 'no-match' };

    let winner = matches[0] as CompiledEntryInterface;
    for (let i = 1; i < matches.length; i++) {
      const m = matches[i] as CompiledEntryInterface;
      if (m.priority > winner.priority) winner = m;
    }

    const reasons = matches.map((m) => `schema:${m.className} matched`);
    const proposal: ClassificationProposal = {
      source:     'classify:schema',
      className:  winner.className,
      priority:   winner.priority,
      confidence: 1,
      reasons,
    };
    state.proposals['classify:schema'] = proposal;
    return { output: 'proposed' };
  }
}
