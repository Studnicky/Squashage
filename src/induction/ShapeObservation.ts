/**
 * ShapeObservation — per-class accumulator types and the fold algorithm.
 *
 * `ShapeObservation` is a mutable in-memory structure that tracks property
 * presence, type distribution, distinct values, URL pattern count, and
 * numeric range across every record instance folded into it. After folding all
 * records for a given class, `SchemaInducer.materialize` converts these
 * observations into a JSON Schema 2020-12 fragment.
 *
 * Folding is commutative: the same set of records in any order produces
 * byte-identical observations. No Map iteration order is mutated; fold only
 * increments counters and extends sets/ranges.
 */

// ─── Scalar type union ────────────────────────────────────────────────────────

/** All JSON scalar types the inducer tracks, plus 'object' and 'array'. */
export type JsonScalarType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'null'
  | 'object'
  | 'array';

// ─── Interfaces ───────────────────────────────────────────────────────────────

/**
 * Accumulated observations for a single property across all folded records.
 *
 * All fields are mutable intentionally — `ShapeObservationAccumulator.fold`
 * updates them in place.
 */
export interface PropertyObservation {
  /** How many records contained this property (not undefined/null-absent). */
  presenceCount: number;
  /** Distribution of observed scalar types for this property's values. */
  typeHistogram: Map<JsonScalarType, number>;
  /** Recursive observation for array element values (set on first array fold). */
  arrayItem?: PropertyObservation;
  /** Recursive observations for nested object keys (set on first object fold). */
  nested?: Map<string, PropertyObservation>;
  /**
   * Distinct string values seen (bounded to `overflowThreshold`).
   * Once `distinctOverflow` is true, new values are no longer added here
   * (the set is frozen at whatever it held when the threshold was crossed).
   */
  distinctValues: Set<string>;
  /**
   * Set to true once `distinctValues.size` reaches the overflow threshold.
   * Signals that the property has more unique values than the inducer tracks.
   */
  distinctOverflow: boolean;
  /** Count of string values matching /^https?:\/\//. */
  urlPatternCount: number;
  /** Observed numeric range across all folded values. Present only when at least one number was seen. */
  numericRange?: { min: number; max: number };
}

/**
 * Top-level per-class observation accumulator.
 *
 * One entry per discovered className in `services.shapeCache`.
 */
export interface ShapeObservation {
  /** The classification class name this observation belongs to. */
  className: string;
  /** Total records folded into this observation. */
  recordCount: number;
  /** Per-property observations, keyed by property name. */
  properties: Map<string, PropertyObservation>;
}

// ─── URL pattern regex ────────────────────────────────────────────────────────

const URL_PATTERN = /^https?:\/\//;

// ─── Type classification ──────────────────────────────────────────────────────

/**
 * Map a runtime JSON value to its `JsonScalarType` discriminant.
 *
 * Integers are a subtype of number in JSON Schema; we distinguish them here
 * so the inducer can emit `"type": "integer"` when all observed values are
 * whole numbers.
 */
function jsonScalarType(value: unknown): JsonScalarType {
  if (value === null)            return 'null';
  if (Array.isArray(value))      return 'array';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string')  return 'string';
  if (typeof value === 'object')  return 'object';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return 'string'; // fallback for bigint / symbol (should not appear in JSON)
}

// ─── Property accumulator helpers ────────────────────────────────────────────

function createEmptyProperty(): PropertyObservation {
  return {
    presenceCount:   0,
    typeHistogram:   new Map(),
    distinctValues:  new Set(),
    distinctOverflow: false,
    urlPatternCount: 0,
  };
}

/**
 * Fold a single value into a `PropertyObservation` in place.
 *
 * @param obs               - The property observation to mutate.
 * @param value             - The runtime value to fold.
 * @param overflowThreshold - Stop tracking distinct values once count hits this.
 * @param depthCap          - Maximum recursion depth (objects and arrays). At 0,
 *                            no recursion occurs — the observation stays shallow.
 */
function foldValue(
  obs:               PropertyObservation,
  value:             unknown,
  overflowThreshold: number,
  depthCap:          number,
): void {
  const type = jsonScalarType(value);

  // ── 1. type histogram ──────────────────────────────────────────────────────
  obs.typeHistogram.set(type, (obs.typeHistogram.get(type) ?? 0) + 1);

  // ── 2. string-specific ────────────────────────────────────────────────────
  if (type === 'string') {
    const str = value as string;
    if (!obs.distinctOverflow) {
      obs.distinctValues.add(str);
      if (obs.distinctValues.size >= overflowThreshold) {
        obs.distinctOverflow = true;
      }
    }
    if (URL_PATTERN.test(str)) {
      obs.urlPatternCount++;
    }
  }

  // ── 3. numeric range ──────────────────────────────────────────────────────
  if (type === 'number' || type === 'integer') {
    const n = value as number;
    if (obs.numericRange === undefined) {
      obs.numericRange = { min: n, max: n };
    } else {
      if (n < obs.numericRange.min) obs.numericRange.min = n;
      if (n > obs.numericRange.max) obs.numericRange.max = n;
    }
  }

  // ── 4. recursive: array ───────────────────────────────────────────────────
  if (type === 'array' && depthCap > 0) {
    if (obs.arrayItem === undefined) {
      obs.arrayItem = createEmptyProperty();
    }
    const items = value as unknown[];
    for (const item of items) {
      obs.arrayItem.presenceCount++;
      foldValue(obs.arrayItem, item, overflowThreshold, depthCap - 1);
    }
  }

  // ── 5. recursive: object ──────────────────────────────────────────────────
  if (type === 'object' && depthCap > 0) {
    if (obs.nested === undefined) {
      obs.nested = new Map();
    }
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!obs.nested.has(key)) {
        obs.nested.set(key, createEmptyProperty());
      }
      const child = obs.nested.get(key) as PropertyObservation;
      child.presenceCount++;
      foldValue(child, obj[key], overflowThreshold, depthCap - 1);
    }
  }
}

// ─── ShapeObservationAccumulator ─────────────────────────────────────────────

/** Options controlling fold behaviour. */
export interface FoldOptionsInterface {
  /**
   * Maximum number of distinct string values to track per property before
   * setting `distinctOverflow = true`. Defaults to 256.
   */
  readonly overflowThreshold?: number;
  /**
   * Maximum recursion depth for nested objects and array items.
   * At depth 0 no recursion occurs. Defaults to 8.
   */
  readonly depthCap?: number;
}

/**
 * Static utility class for creating and updating `ShapeObservation` values.
 *
 * All methods are pure (no hidden state). The class carries no instance
 * members — the accumulation state lives in the `ShapeObservation` value
 * itself, stored in `services.shapeCache`.
 */
export class ShapeObservationAccumulator {
  private constructor() { /* static-only class */ }

  /**
   * Create a fresh, empty `ShapeObservation` for the given className.
   *
   * @param className - The classification class name this observation will track.
   */
  static createEmpty(className: string): ShapeObservation {
    return {
      className,
      recordCount: 0,
      properties:  new Map(),
    };
  }

  /**
   * Fold one record instance into an existing `ShapeObservation` in place.
   *
   * Safe to call concurrently on different observations; concurrent calls on
   * the **same** observation are not synchronized (the DAG ensures only one
   * fan-out worker writes to a given className observation at a time by virtue
   * of the single check-and-set pattern in `shapeObserve`).
   *
   * @param observation - The observation to mutate.
   * @param instance    - The parsed record object.
   * @param options     - Optional fold tuning parameters.
   */
  static fold(
    observation: ShapeObservation,
    instance:    Record<string, unknown>,
    options?:    FoldOptionsInterface,
  ): void {
    const overflowThreshold = options?.overflowThreshold ?? 256;
    const depthCap          = options?.depthCap          ?? 8;

    observation.recordCount++;

    for (const key of Object.keys(instance)) {
      const value = instance[key];

      // Property is present in this record — presence counting applies only when
      // the key exists (even if its value is null).
      if (!observation.properties.has(key)) {
        observation.properties.set(key, createEmptyProperty());
      }
      const propObs = observation.properties.get(key) as PropertyObservation;
      propObs.presenceCount++;

      foldValue(propObs, value, overflowThreshold, depthCap);
    }
  }
}
