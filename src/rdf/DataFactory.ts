/**
 * @fileoverview Re-exports the singleton RDF/JS DataFactory from `@rdfjs/data-model`.
 *
 * @remarks
 * All application code that needs a `DataFactory` or `@rdfjs/types` term shapes
 * imports from this module rather than from `@rdfjs/data-model` directly.
 * At v1.x the single-line implementation below swaps to
 * `import { dataFactory } from '@semantics/rdf-data-model'`.
 *
 * @module
 * @category RDF
 * @since 2.2.0
 */

import dataFactory from '@rdfjs/data-model';

export type {
  DataFactory,
  NamedNode,
  Literal,
  BlankNode,
  Quad,
  DefaultGraph,
} from '@rdfjs/types';

export { dataFactory };
