import type { FromSchema } from 'json-schema-to-ts';

const JSON_SCHEMA_DRAFT_07_URI = 'http://json-schema.org/draft-07/schema#';

/**
 * JSON Schema (draft-07) for the `output` block of a squashage target config.
 *
 * @remarks
 * Defined as a `const` TypeScript object so that `json-schema-to-ts` can derive
 * {@link OutputConfigInterface} statically. The canonical copy lives alongside this
 * file at `src/schemas/output.schema.json` for IDE and tooling support.
 *
 * @category Schema
 * @since 2.2.0
 * @see {@link OutputConfigInterface}
 * @group Schema
 */
export const OUTPUT_SCHEMA = {
  $schema: JSON_SCHEMA_DRAFT_07_URI,
  $id: 'https://squashage.dev/schemas/output.json',
  title: 'Squashage Output Config',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'path'],
  properties: {
    kind:        { type: 'string', const: 'file' },
    path:        { type: 'string', minLength: 1 },
    format:      {
      type: 'string',
      enum: ['turtle', 'trig', 'ntriples', 'nquads', 'jsonld'] as const,
      description: 'RDF/XML and N3 output are deferred to v1.x — the AJV schema rejects them in v0.x.',
    },
    mode:        { type: 'string', enum: ['dataset', 'stream'] as const, default: 'dataset' },
    prefixes:    {
      type: 'object',
      additionalProperties: { type: 'string', format: 'uri' },
    },
    baseIRI:     { type: 'string', format: 'uri' },
    graph:       {
      type: 'string',
      format: 'uri',
      description: 'Collapse all quads to this named graph at write time.',
    },
    canonicalize: { type: 'boolean', default: false },
    validate:    {
      type: 'object',
      additionalProperties: false,
      required: ['shapes'],
      properties: {
        shapes: {
          type: 'string',
          description: 'Path to a SHACL shapes graph (any RDF format).',
        },
      },
    },
    dryRun: { type: 'boolean', default: false },
    encoding: {
      type: 'string',
      enum: ['atomic', 'stream'] as const,
      default: 'atomic',
      description: 'Output write strategy. "atomic" (default) collects all quads in memory and writes a single file atomically. "stream" opens a file handle immediately and writes each quad as it arrives, eliminating OOM risk on large datasets.',
    },
    dropInMemory: {
      type: 'boolean',
      default: false,
      description: 'When encoding=stream, drop quads from the in-memory dataset after streaming write. Saves memory but downstream tasks (provenance, ontology:emit) must not depend on dataset scans.',
    },
    jsonldContext: {
      oneOf: [
        { type: 'string' },
        { type: 'object' },
      ] as const,
      description: 'Compaction context for JSON-LD output. Path string (resolved against config dir), inline object, or omit/auto to let squashage build one from the quad set + ctx.prefixes. Rejected when format is not jsonld.',
    },
    provenance: {
      type: 'object',
      additionalProperties: false,
      description: 'PROV-O sidecar provenance graph configuration (Phase 6 and Phase 7).',
      properties: {
        enabled: {
          type: 'boolean',
          default: false,
          description: 'When true, provenance quads are emitted into a separate named graph for each processed record.',
        },
        graph: {
          type: 'string',
          description: 'Named-graph IRI suffix (resolved against runBase) or a full IRI for the provenance graph.',
        },
        include: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['classifier', 'confidence', 'reasons', 'timestamp'] as const,
          },
          description: 'Metadata categories to include in provenance output. Omit an item to suppress that metadata.',
          default: ['classifier', 'confidence', 'reasons', 'timestamp'],
        },
        encoding: {
          type: 'string',
          enum: ['named-graph', 'rdf-star'] as const,
          default: 'named-graph',
          description: 'Provenance encoding strategy. "named-graph" (default) emits PROV-O quads into a sidecar named graph. "rdf-star" emits quoted-triple-subject quads where the rdf:type assertion for each record is the subject of provenance metadata.',
        },
      },
    },
    catalog: {
      type: 'object',
      additionalProperties: false,
      description: 'OASIS XML Catalog 1.1 generation. When enabled (requires bucketing.enabled=true), writes a <targetId>.catalog.xml file to the bucket directory after a run.',
      properties: {
        enabled: {
          type: 'boolean',
          default: false,
          description: 'When true, an OASIS XML Catalog 1.1 file is written to the bucket directory. Requires bucketing.enabled=true.',
        },
        filename: {
          type: 'string',
          description: 'Override the catalog filename. Defaults to "<targetId>.catalog.xml"; falls back to "catalog.xml" when the target ID is unavailable.',
        },
        prefer: {
          type: 'string',
          enum: ['public', 'system'] as const,
          default: 'public',
          description: 'OASIS catalog "prefer" attribute. "public" (default) because we resolve by named-graph IRI.',
        },
        includeOntologies: {
          type: 'boolean',
          default: true,
          description: 'When true (default), emit <public>/<uri> entries for ontology files when ctx.jt is populated.',
        },
        includeContexts: {
          type: 'boolean',
          default: true,
          description: 'When true (default), emit <system> entries for JSON-LD context files when format=jsonld.',
        },
        includeShapes: {
          type: 'boolean',
          default: true,
          description: 'When true (default), emit <uri> entries for the SHACL shapes file when output.validate.shapes is set.',
        },
        rewriteRoots: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['uriStartString', 'rewritePrefix'],
            properties: {
              uriStartString: {
                type: 'string',
                description: 'IRI prefix to rewrite.',
              },
              rewritePrefix: {
                type: 'string',
                description: 'Local path prefix to substitute.',
              },
            },
          },
          description: 'Optional <rewriteURI> entries for namespace-rooted graph families.',
        },
      },
    },
    bucketing: {
      type: 'object',
      additionalProperties: false,
      description: 'Named-graph bucketing configuration. When enabled, output.path is treated as a directory and one file is written per named graph.',
      properties: {
        enabled: {
          type: 'boolean',
          default: false,
          description: 'When true, the dataset is split into one file per named graph under output.path (which becomes the bucket root directory).',
        },
        strategy: {
          type: 'string',
          enum: ['per-graph-iri', 'per-config-bucket'] as const,
          default: 'per-graph-iri',
          description: 'Bucketing strategy. "per-graph-iri" (default) derives filenames from graph IRIs. "per-config-bucket" uses an explicit graphIRI → filename mapping from bucketing.buckets.',
        },
        defaultGraphFilename: {
          type: 'string',
          description: 'Filename stem (without extension) for the default-graph bucket. Defaults to "default". Set to null to drop default-graph quads with a warning.',
        },
        defaultGraphCatalogIri: {
          type: 'string',
          description: 'Optional IRI to use as the catalog <uri name> for the default-graph bucket (e.g. "urn:x-arq:DefaultGraphNode" for Jena compatibility). When absent, the default-graph bucket is not indexed in the catalog.',
        },
        buckets: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'For strategy=per-config-bucket: explicit graphIRI → filename stem mapping.',
        },
        onUnmapped: {
          type: 'string',
          enum: ['other', 'drop', 'fail'] as const,
          default: 'other',
          description: 'What to do when a quad\'s graph IRI is not in the bucketing.buckets map (only relevant for per-config-bucket strategy).',
        },
        maxOpenFiles: {
          type: 'number',
          default: 256,
          description: 'Maximum number of simultaneously open file handles in lazy-open streaming mode. Excess handles are LRU-closed and reopened on demand.',
        },
      },
    },
  },
  allOf: [
    {
      if:   { properties: { mode: { const: 'stream' } } },
      then: {
        properties: {
          canonicalize: { const: false },
          validate:     { not: {} },
        },
      },
    },
    {
      // encoding:stream + canonicalize:true is forbidden
      if:   { required: ['encoding'], properties: { encoding: { const: 'stream' } } },
      then: {
        properties: {
          canonicalize: { const: false },
        },
      },
    },
    {
      // encoding:stream + format:jsonld is forbidden
      if: {
        required: ['encoding', 'format'],
        properties: {
          encoding: { const: 'stream' },
          format:   { const: 'jsonld' },
        },
      },
      then: {
        not: {},
      },
    },
    {
      // bucketing.enabled:true + output.graph is forbidden (graph collapse nulls the bucketing key)
      if: {
        required: ['bucketing'],
        properties: {
          bucketing: {
            type: 'object',
            required: ['enabled'],
            properties: { enabled: { const: true } },
          },
        },
      },
      then: {
        properties: {
          graph: { not: {} },
        },
      },
    },
    {
      // catalog.enabled:true requires bucketing.enabled:true
      if: {
        required: ['catalog'],
        properties: {
          catalog: {
            type: 'object',
            required: ['enabled'],
            properties: { enabled: { const: true } },
          },
        },
      },
      then: {
        required: ['bucketing'],
        properties: {
          bucketing: {
            type: 'object',
            required: ['enabled'],
            properties: { enabled: { const: true } },
          },
        },
      },
    },
  ],
} as const;

/**
 * Validated output configuration for a squashage target, derived from
 * {@link OUTPUT_SCHEMA} via `json-schema-to-ts`.
 *
 * @remarks
 * The shape is authoritative — editing {@link OUTPUT_SCHEMA} changes this type
 * automatically. Load and validate with {@link SquashageConfig.loadFromFile}.
 * This interface satisfies the `PipelineContextInterface.output` slot.
 *
 * @example
 * ```ts
 * const output: OutputConfigInterface = {
 *   kind:   'file',
 *   path:   './graphs/aonprd.jsonld',
 *   mode:   'dataset',
 * };
 * ```
 *
 * @category Configuration
 * @since 2.2.0
 * @see {@link OUTPUT_SCHEMA}
 * @group Types
 */
export type OutputConfigInterface = FromSchema<typeof OUTPUT_SCHEMA>;
