/**
 * classify:url-pattern — emits one `ClassificationProposal` per regex pattern
 * that matches the record's URL (read from `_source.url` or top-level `url`).
 *
 * Patterns are compiled once in the constructor; the per-record execute is
 * pure CPU. Multiple matches collapse into one proposal at the slot —
 * picked by priority, all matched patterns listed in `reasons`.
 */

import { ScalarNode, NodeOutputBuilder } from '@studnicky/dagonizer';
import type { NodeContextType, NodeOutputType } from '@studnicky/dagonizer';

import type { SquashageServices } from '../../../services/SquashageServices.js';
import type { ClassificationProposal } from '../../../state/schemas/ClassificationProposal.js';
import type { SquashageRecordState } from '../../../state/SquashageRecordState.js';

export interface UrlPatternEntryInterface {
  readonly className: string;
  readonly match:     string;
  readonly priority?: number | undefined;
}

export interface UrlPatternConfigInterface {
  readonly patterns: ReadonlyArray<UrlPatternEntryInterface>;
}

interface CompiledPatternInterface {
  readonly className: string;
  readonly priority:  number;
  readonly regex:     RegExp;
  readonly reason:    string;
}

type Output = 'proposed' | 'no-match';

export class UrlPatternClassifierNode extends ScalarNode<SquashageRecordState, Output, SquashageServices> {

  public readonly name    = 'classify:url-pattern';
  public readonly outputs = ['proposed', 'no-match'] as const;
  readonly #patterns: ReadonlyArray<CompiledPatternInterface>;

  constructor(config: UrlPatternConfigInterface) {
    super();
    this.#patterns = Object.freeze(config.patterns.map((entry, idx) => {
      try {
        const regex = new RegExp(entry.match);
        return {
          className: entry.className,
          priority:  entry.priority ?? 35,
          regex,
          reason:    `engine=url-pattern,regex=${entry.match}`,
        };
      } catch (err) {
        throw new Error(`classify:url-pattern: invalid regex at patterns[${idx.toString()}].match "${entry.match}"`, { cause: err });
      }
    }));
  }

  public override get outputSchema(): Record<Output, { type: 'object' }> {
    return { proposed: { type: 'object' }, 'no-match': { type: 'object' } };
  }

  protected override async executeOne(
    state:    SquashageRecordState,
    _context: NodeContextType<SquashageServices>,
  ): Promise<NodeOutputType<Output>> {
    const url = UrlPatternClassifierNode.extractUrl(state.input);
    if (url === undefined) return NodeOutputBuilder.of('no-match');

    const matches: CompiledPatternInterface[] = [];
    for (const p of this.#patterns) {
      if (p.regex.test(url)) matches.push(p);
    }
    if (matches.length === 0) return NodeOutputBuilder.of('no-match');

    // Pick the highest-priority match; record all matched reasons.
    let winner = matches[0] as CompiledPatternInterface;
    for (let i = 1; i < matches.length; i++) {
      const m = matches[i] as CompiledPatternInterface;
      if (m.priority > winner.priority) winner = m;
    }

    const reasons = matches.map((m) => `${m.reason} → ${m.className}`);
    reasons.push(`url=${url}`);

    const proposal: ClassificationProposal = {
      source:     'classify:url-pattern',
      className:  winner.className,
      priority:   winner.priority,
      confidence: 1,
      reasons,
    };
    state.proposals['classify:url-pattern'] = proposal;
    return NodeOutputBuilder.of('proposed');
  }

  private static isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private static extractUrl(input: Readonly<Record<string, unknown>>): string | undefined {
    const sourceBlock = input['_source'];
    if (UrlPatternClassifierNode.isPlainObject(sourceBlock) && typeof sourceBlock['url'] === 'string' && sourceBlock['url'].length > 0) {
      return sourceBlock['url'];
    }
    if (typeof input['url'] === 'string' && input['url'].length > 0) {
      return input['url'];
    }
    return undefined;
  }
}
