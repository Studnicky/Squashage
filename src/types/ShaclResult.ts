/**
 * @fileoverview Shared SHACL result types for the ShaclGate public surface.
 *
 * @remarks
 * These interfaces model the subset of `ValidationResult` fields that
 * `ShaclGate.run` and `ShaclGate.formatReport` expose to application code.
 * All fields are optional because individual constraint results may omit
 * fields that are not relevant to the violated constraint.
 *
 * @module
 * @category SHACL
 * @since 2.2.0
 */

/**
 * A single human-readable message attached to a SHACL validation result.
 *
 * @category SHACL
 * @since 2.2.0
 */
export interface ShaclMessageInterface {
  readonly value: string;
}

/**
 * A lightweight term reference carrying only the IRI or literal string value.
 *
 * @remarks
 * Matches the `.value` property on any RDF/JS `Term`.
 *
 * @category SHACL
 * @since 2.2.0
 */
export interface ShaclTermRefInterface {
  readonly value: string;
}

/**
 * One entry from a SHACL `ValidationReport`'s `sh:result` list.
 *
 * @remarks
 * All fields are optional — individual constraint violations may omit fields
 * that are not pertinent to the violated constraint (e.g. `path` is absent
 * for node-level constraints, `value` may be absent when the focus node
 * itself is the offending value).
 *
 * @category SHACL
 * @since 2.2.0
 */
export interface ShaclResultInterface {
  readonly severity?:                  ShaclTermRefInterface;
  readonly focusNode?:                 ShaclTermRefInterface;
  readonly path?:                      ShaclTermRefInterface;
  readonly value?:                     ShaclTermRefInterface;
  readonly sourceShape?:               ShaclTermRefInterface;
  readonly sourceConstraintComponent?: ShaclTermRefInterface;
  readonly message?:                   ReadonlyArray<ShaclMessageInterface>;
}
