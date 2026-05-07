/**
 * @fileoverview Static type-predicate guards for narrowing RDF/JS `Term` values.
 *
 * @remarks
 * All methods are static; the class cannot be instantiated. Each guard performs a
 * single `termType` string comparison, matching the literal values defined by the
 * RDF/JS Data Model specification. These wrappers isolate the rest of the codebase
 * from the underlying `@rdfjs/types` shapes — the call site stays identical when the
 * v1.x `@semantics/rdf-data-model` swap lands.
 *
 * @example
 * ```ts
 * if (TermGuards.isNamedNode(term)) {
 *   console.log(term.value); // term is narrowed to NamedNode here
 * }
 * ```
 *
 * @category RDF
 * @since 0.1.0
 * @see {@link https://rdf.js.org/data-model-spec/ RDF/JS Data Model Spec}
 * @group Core
 */

import type { Term, NamedNode, Literal, BlankNode, Quad, DefaultGraph, Variable } from '@rdfjs/types';

export class TermGuards {
  private constructor() { /* static-only */ }

  /**
   * Returns `true` if `term` is a {@link NamedNode}.
   *
   * @param term - The RDF term to test.
   * @returns Whether `term` has `termType === 'NamedNode'`.
   */
  public static isNamedNode(term: Term): term is NamedNode {
    return term.termType === 'NamedNode';
  }

  /**
   * Returns `true` if `term` is a {@link Literal}.
   *
   * @param term - The RDF term to test.
   * @returns Whether `term` has `termType === 'Literal'`.
   */
  public static isLiteral(term: Term): term is Literal {
    return term.termType === 'Literal';
  }

  /**
   * Returns `true` if `term` is a {@link BlankNode}.
   *
   * @param term - The RDF term to test.
   * @returns Whether `term` has `termType === 'BlankNode'`.
   */
  public static isBlankNode(term: Term): term is BlankNode {
    return term.termType === 'BlankNode';
  }

  /**
   * Returns `true` if `term` is a {@link DefaultGraph}.
   *
   * @param term - The RDF term to test.
   * @returns Whether `term` has `termType === 'DefaultGraph'`.
   */
  public static isDefaultGraph(term: Term): term is DefaultGraph {
    return term.termType === 'DefaultGraph';
  }

  /**
   * Returns `true` if `term` is a {@link Variable}.
   *
   * @param term - The RDF term to test.
   * @returns Whether `term` has `termType === 'Variable'`.
   */
  public static isVariable(term: Term): term is Variable {
    return term.termType === 'Variable';
  }

  /**
   * Returns `true` if `term` is a {@link Quad}.
   *
   * @param term - The RDF term to test.
   * @returns Whether `term` has `termType === 'Quad'`.
   */
  public static isQuad(term: Term): term is Quad {
    return term.termType === 'Quad';
  }
}
