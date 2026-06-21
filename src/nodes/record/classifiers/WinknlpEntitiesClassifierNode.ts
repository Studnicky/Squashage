/**
 * classify:winknlp-entities — pattern-based NER classifier using winkNLP
 * custom entities. Patterns are compiled once in the constructor; per-record
 * execute reads configured prose fields and emits one proposal per matched
 * entity (collapsed into one slot by highest priority).
 */

import type { WinkMethods, CustomEntityExample, Detail } from 'wink-nlp';
import winkNlpModule from 'wink-nlp';
import modelModule   from 'wink-eng-lite-web-model';

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../../services/SquashageServices.js';
import type { ClassificationProposal } from '../../../state/schemas/ClassificationProposal.js';
import type { SquashageRecordState } from '../../../state/SquashageRecordState.js';

const winkNlp = (winkNlpModule as unknown as { default?: typeof winkNlpModule }).default
  ?? winkNlpModule;
const model = (modelModule as unknown as { default?: typeof modelModule }).default
  ?? modelModule;

const MAX_SNIPPET_LENGTH = 80;

export interface WinknlpPatternEntryInterface {
  readonly name:      string;
  readonly patterns:  ReadonlyArray<string>;
  readonly className: string;
  readonly priority?: number | undefined;
}

export interface WinknlpEntitiesConfigInterface {
  readonly patterns: ReadonlyArray<WinknlpPatternEntryInterface>;
  readonly fields?:  ReadonlyArray<string> | undefined;
}

interface CompiledPatternMetaInterface {
  readonly className: string;
  readonly priority:  number;
}

type Output = 'proposed' | 'no-match';

export class WinknlpEntitiesClassifierNode extends ScalarNode<SquashageRecordState, Output, SquashageServices> {

  public readonly name    = 'classify:winknlp-entities';
  public readonly outputs = ['proposed', 'no-match'] as const;
  readonly #nlp:    WinkMethods;
  readonly #meta:   Readonly<Record<string, CompiledPatternMetaInterface>>;
  readonly #fields: ReadonlyArray<string>;

  constructor(config: WinknlpEntitiesConfigInterface) {
    super();
    const nlp = winkNlp(model);

    const examples: CustomEntityExample[] = config.patterns.map((entry) => ({
      name:     entry.name,
      patterns: entry.patterns as string[],
    }));
    const meta: Record<string, CompiledPatternMetaInterface> = {};
    for (const entry of config.patterns) {
      meta[entry.name] = { className: entry.className, priority: entry.priority ?? 28 };
    }

    try {
      nlp.learnCustomEntities(examples, { matchValue: false, usePOS: false, useEntity: false });
    } catch (err) {
      const nameList = config.patterns.map((p) => `"${p.name}"`).join(', ');
      throw new Error(`classify:winknlp-entities: learnCustomEntities failed for ${nameList}`, { cause: err });
    }

    this.#nlp    = nlp;
    this.#meta   = Object.freeze(meta);
    this.#fields = Object.freeze(
      config.fields !== undefined && config.fields.length > 0
        ? [...config.fields]
        : ['description'],
    );
  }

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { proposed: { type: 'object' }, 'no-match': { type: 'object' } };
  }

  protected override async executeOne(
    state:    SquashageRecordState,
    _context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const matches: Array<{ meta: CompiledPatternMetaInterface; reasons: string[] }> = [];

    for (const fieldName of this.#fields) {
      const raw = state.input[fieldName];
      if (typeof raw !== 'string' || raw.length === 0) continue;

      const doc     = this.#nlp.readDoc(raw);
      const its     = this.#nlp.its;
      const details = doc.customEntities().out(its.detail) as Detail[];

      for (const detail of details) {
        const meta = this.#meta[detail.type];
        if (meta === undefined) continue;
        const snippet = detail.value.length > MAX_SNIPPET_LENGTH
          ? detail.value.slice(0, MAX_SNIPPET_LENGTH)
          : detail.value;
        matches.push({
          meta,
          reasons: [
            `winknlp:pattern=${detail.type}`,
            `winknlp:matched=${snippet}`,
            `winknlp:field=${fieldName}`,
          ],
        });
      }
    }

    if (matches.length === 0) return NodeOutputBuilder.of('no-match');

    let winner = matches[0]!;
    for (let i = 1; i < matches.length; i++) {
      if ((matches[i]!).meta.priority > winner.meta.priority) winner = matches[i]!;
    }
    const allReasons = matches.flatMap((m) => m.reasons);
    const proposal: ClassificationProposal = {
      source:     'classify:winknlp-entities',
      className:  winner.meta.className,
      priority:   winner.meta.priority,
      confidence: 1,
      reasons:    allReasons,
    };
    state.proposals['classify:winknlp-entities'] = proposal;
    return NodeOutputBuilder.of('proposed');
  }
}
