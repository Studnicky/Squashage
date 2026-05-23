import type { FromSchema } from 'json-schema-to-ts';

/**
 * One-line summary the per-record DAG hands back to the run-scope DAG via the
 * fan-out `append` strategy. Aggregated into `SquashageRunState.results`.
 *
 * The success graph emit path uses this to decide which records contributed
 * quads; the failed-records dump path reads `quarantineBucket` and `error`.
 */
export const RecordSummarySchema = {
  $id:        'https://squashage.dev/schemas/RecordSummary',
  $schema:    'https://json-schema.org/draft/2020-12/schema',
  type:       'object',
  required:   ['recordPath', 'recordLine', 'outcome'],
  properties: {
    recordPath: { type: 'string', minLength: 1 },
    recordLine: { type: 'integer', minimum: 0 },
    outcome:    { type: 'string', enum: ['squashed', 'quarantined', 'error'] },
    className:  { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    quadCount:  { type: 'integer', minimum: 0 },
    quarantineBucket: { type: 'string', enum: ['unknown', 'conflicts', 'projection', 'output'] },
    errorMessage:     { type: 'string' },
  },
  additionalProperties: false,
} as const;

export type RecordSummary = FromSchema<typeof RecordSummarySchema>;
