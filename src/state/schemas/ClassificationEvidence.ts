import type { FromSchema } from 'json-schema-to-ts';

/**
 * Result of the classification cascade for one record.
 *
 * Populated by `classify-conflict` after reducing every per-classifier proposal
 * in `state.proposals`. Preserved verbatim into the failed-records dump when a
 * downstream node quarantines the record.
 */
export const ClassificationEvidenceSchema = {
  $id:        'https://squashage.dev/schemas/ClassificationEvidence',
  $schema:    'https://json-schema.org/draft/2020-12/schema',
  type:       'object',
  required:   ['type', 'confidence', 'engine', 'reasons'],
  properties: {
    type:       { type: 'string', minLength: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    engine:     { type: 'string', minLength: 1 },
    reasons:    { type: 'array', items: { type: 'string' } },
    candidates: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const;

export type ClassificationEvidence = FromSchema<typeof ClassificationEvidenceSchema>;
