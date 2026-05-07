/**
 * @fileoverview Static factory wrapper around `@rdfjs/dataset` for building `DatasetCore` instances.
 *
 * @remarks
 * All application code that needs a `DatasetCore` should use this wrapper instead of
 * importing `@rdfjs/dataset` directly.  At v1.x the implementation below swaps to
 * `import { Dataset } from '@semantics/rdf-store'` and only this file changes.
 *
 * @module
 * @category RDF
 * @since 2.2.0
 */

import type { DatasetCore, Quad } from '@rdfjs/types';
import datasetFactory from '@rdfjs/dataset';

/**
 * Static factory for creating RDF/JS `DatasetCore` instances.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated.
 * Wraps `@rdfjs/dataset` so that the underlying library can be swapped at v1.x
 * without touching application-layer call sites.
 *
 * @example
 * ```ts
 * const ds = Dataset.from([q1, q2]);
 * const empty = Dataset.empty();
 * const roundTrip = Dataset.from(ds);
 * ```
 *
 * @category RDF
 * @since 2.2.0
 * @see {@link https://rdf.js.org/dataset-spec/ | RDF/JS Dataset spec}
 * @group Core
 */
export class Dataset {
  private constructor() { /* static-only */ }

  /**
   * Build a `DatasetCore` from any iterable of quads or another `DatasetCore`.
   *
   * @remarks
   * When `input` is a `DatasetCore` (detected by the presence of a numeric `.size`
   * property and a `.match` method), it is spread via the iterable protocol before
   * being handed to the underlying factory.  Plain iterables are collected into an
   * array directly.
   *
   * @param input - An iterable of `Quad` objects or an existing `DatasetCore`.
   * @returns A new `DatasetCore` containing all quads from `input`.
   *
   * @example
   * ```ts
   * const ds = Dataset.from([q1, q2]);         // from quad array
   * const copy = Dataset.from(ds);             // from existing DatasetCore
   * ```
   */
  public static from(input: Iterable<Quad> | DatasetCore): DatasetCore {
    const isDatasetCore =
      typeof (input as DatasetCore).size === 'number' &&
      typeof (input as DatasetCore).match === 'function';

    const quads: Quad[] = isDatasetCore
      ? ([...(input as DatasetCore)] as Quad[])
      : ([...(input as Iterable<Quad>)] as Quad[]);

    return datasetFactory.dataset(quads);
  }

  /**
   * Returns an empty `DatasetCore` with no quads.
   *
   * @returns A new, empty `DatasetCore`.
   *
   * @example
   * ```ts
   * const empty = Dataset.empty();
   * assert.equal(empty.size, 0);
   * ```
   */
  public static empty(): DatasetCore {
    return datasetFactory.dataset([]);
  }
}
