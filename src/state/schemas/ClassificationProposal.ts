import type { FromSchema } from 'json-schema-to-ts';

/**
 * A classification proposal emitted by one classifier node into
 * `SquashageRecordState.proposals` keyed by the classifier's name.
 *
 * The downstream `classify-conflict` node reduces the proposals to a single
 * winning {@link ClassificationEvidence}.
 */
export const ClassificationProposalSchema = {
  $id:        'https://squashage.dev/schemas/ClassificationProposal',
  $schema:    'https://json-schema.org/draft/2020-12/schema',
  type:       'object',
  required:   ['source', 'className', 'priority', 'confidence', 'reasons'],
  properties: {
    source:     { type: 'string', minLength: 1 },
    className:  { type: 'string', minLength: 1 },
    priority:   { type: 'number' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasons:    { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const;

export type ClassificationProposal = FromSchema<typeof ClassificationProposalSchema>;
