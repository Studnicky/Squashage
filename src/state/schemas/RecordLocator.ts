import type { FromSchema } from 'json-schema-to-ts';

/**
 * One `{ recordPath, recordLine }` pair identifying one input record on disk.
 *
 * Produced by the `walk-input` node into `SquashageRunState.locators`. The
 * fan-out placement consumes the array; each item is passed to the per-record
 * deep-DAG.
 */
export const RecordLocatorSchema = {
  $id:        'https://squashage.dev/schemas/RecordLocator',
  $schema:    'https://json-schema.org/draft/2020-12/schema',
  type:       'object',
  required:   ['recordPath', 'recordLine'],
  properties: {
    recordPath: { type: 'string', minLength: 1 },
    recordLine: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const;

export type RecordLocator = FromSchema<typeof RecordLocatorSchema>;
