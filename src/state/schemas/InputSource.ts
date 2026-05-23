import type { FromSchema } from 'json-schema-to-ts';

/**
 * Source metadata for a single input JSON record flowing through the DAG.
 *
 * Populated by `json-read` from the file path the record was loaded from and
 * from the optional `_source` block embedded in the record itself.
 */
export const InputSourceSchema = {
  $id:        'https://squashage.dev/schemas/InputSource',
  $schema:    'https://json-schema.org/draft/2020-12/schema',
  type:       'object',
  required:   ['target', 'path'],
  properties: {
    target:   { type: 'string', minLength: 1 },
    path:     { type: 'string', minLength: 1 },
    plugin:   { type: 'string' },
    schemaId: { type: 'string' },
  },
  additionalProperties: false,
} as const;

export type InputSource = FromSchema<typeof InputSourceSchema>;
