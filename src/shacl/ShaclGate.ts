/**
 * @fileoverview Thin wrapper around `rdf-validate-shacl` that provides a stable,
 * library-agnostic surface for SHACL validation inside Squashage.
 *
 * @remarks
 * **v0.x implementation** — the class body directly imports and calls
 * `rdf-validate-shacl` (`SHACLValidator`) with its bundled default environment
 * (an `@rdfjs/environment` composing DataFactory, DatasetFactory,
 * ClownfaceFactory, NamespaceFactory, and TermMapFactory).  At v1.x the body
 * is replaced with a call to `@semantics/shacl-validator` while the public
 * signatures (`run`, `formatReport`, `ShaclReportInterface`) remain identical.
 * Application code outside `src/shacl/**` must never import
 * `rdf-validate-shacl` directly; it imports `ShaclGate` from this module only.
 *
 * **Swap point (v1.x)**: replace the `import` line and the three-line body of
 * `ShaclGate.run` with the `@semantics/shacl-validator` equivalents.  The
 * `ShaclReportInterface` and `formatReport` implementations do not change.
 *
 * @module
 * @category SHACL
 * @since 2.2.0
 */

import SHACLValidator from 'rdf-validate-shacl';
import type { DatasetCore } from '@rdfjs/types';

import type { ShaclResultInterface } from '../types/ShaclResult.js';

export type { ShaclResultInterface };

/**
 * The canonical report shape returned by {@link ShaclGate.run}.
 *
 * @remarks
 * `results` is typed as `ReadonlyArray<ShaclResultInterface>` so application
 * code can iterate individual constraint violations without referencing any
 * `rdf-validate-shacl` internal types.  `reportDataset` holds the full W3C
 * SHACL `ValidationReport` RDF graph, suitable for Turtle serialization.
 *
 * @category SHACL
 * @since 2.2.0
 */
export interface ShaclReportInterface {
  readonly conforms:      boolean;
  readonly results:       ReadonlyArray<ShaclResultInterface>;
  readonly reportDataset: DatasetCore;
}

/**
 * Static gateway for SHACL validation operations.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated.  It isolates
 * `rdf-validate-shacl` from the rest of the application so that the backing
 * library can be swapped at v1.x without touching any call site outside
 * `src/shacl/`.
 *
 * @example
 * ```ts
 * const report = await ShaclGate.run(shapesGraph, dataGraph);
 * if (!report.conforms) {
 *   console.error(ShaclGate.formatReport(report));
 * }
 * ```
 *
 * @category SHACL
 * @since 2.2.0
 * @see {@link https://www.w3.org/TR/shacl/ | W3C SHACL specification}
 * @group Core
 */
export class ShaclGate {
  private constructor() { /* static-only */ }

  /**
   * Validates a data graph against a SHACL shapes graph.
   *
   * @remarks
   * v0.x: delegates to `new SHACLValidator(shapes)` from `rdf-validate-shacl`,
   * using the library's bundled default environment (an `@rdfjs/environment`
   * composing DataFactory, DatasetFactory, ClownfaceFactory, NamespaceFactory,
   * and TermMapFactory).  No custom `factory` option is passed — the default
   * env is the only environment that satisfies the full `clownface` + `termMap`
   * requirements at v0.x.  At v1.x this body is replaced with the
   * `@semantics/shacl-validator` equivalent; the return type does not change.
   *
   * @param shapes - A `DatasetCore` containing the SHACL shapes graph.
   * @param data   - A `DatasetCore` containing the data graph to validate.
   * @returns A {@link ShaclReportInterface} with `conforms`, `results`, and
   *   `reportDataset` (the W3C `sh:ValidationReport` as RDF).
   *
   * @example
   * ```ts
   * const shapes = Dataset.from(shapeQuads);
   * const data   = Dataset.from(dataQuads);
   * const report = await ShaclGate.run(shapes, data);
   * ```
   */
  public static async run(shapes: DatasetCore, data: DatasetCore): Promise<ShaclReportInterface> {
    const validator = new SHACLValidator(shapes);
    const report    = await validator.validate(data);
    return {
      conforms:      report.conforms,
      results:       report.results as ReadonlyArray<ShaclResultInterface>,
      reportDataset: report.dataset,
    };
  }

  /**
   * Renders a SHACL report as a human-readable plaintext summary.
   *
   * @remarks
   * Each result is formatted as:
   * `[<severity>] <focusNode> <path> → <message>`
   *
   * Fields that are `undefined` or empty are omitted gracefully:
   * - `severity` renders as the full IRI value or empty string when absent
   * - `path` is skipped (empty string) when absent
   * - `message` uses the first entry; omitted when the array is empty or absent
   *
   * @param report - Any object carrying a `results` array of
   *   {@link ShaclResultInterface} entries.
   * @returns A newline-joined string, one line per result.  Returns an empty
   *   string when `results` is empty (i.e. a conforming graph).
   *
   * @example
   * ```ts
   * const text = ShaclGate.formatReport(report);
   * await fs.writeFile('validation.report.txt', text, 'utf8');
   * ```
   */
  public static formatReport(
    report: { results: ReadonlyArray<ShaclResultInterface> },
  ): string {
    return report.results
      .map(x =>
        `[${x.severity?.value ?? ''}] ${x.focusNode?.value ?? ''} ${x.path?.value ?? ''} → ${x.message?.[0]?.value ?? ''}`.trimEnd(),
      )
      .join('\n');
  }
}
