import { NodeStateBase } from '@studnicky/dagonizer';
import type { JsonObjectType, JsonValueType } from '@studnicky/dagonizer/entities';

import type { Quad } from '@rdfjs/types';
import { Parser } from '../rdf/Parser.js';
import { Serializer } from '../rdf/Serializer.js';
import type { ClassificationEvidence } from './schemas/ClassificationEvidence.js';
import type { ClassificationProposal } from './schemas/ClassificationProposal.js';
import type { InputSource } from './schemas/InputSource.js';

/**
 * Per-record state flowing through the record-scope deep-DAG
 * (`squashage:record`).
 *
 * Populated by `json-read` (`source`, `input`), each classifier writes its own
 * slot under `proposals[classifierName]`, the `classify-conflict` node reduces
 * them into `classification`, and `squash` writes the projected quads to
 * `squashedQuads`. `quarantineBucket` is set by `record-quarantine` if the
 * record is diverted.
 *
 * V8 monomorphism: property writes occur in the same fixed order in every
 * constructor. Do not introduce conditional spreads.
 */
export class SquashageRecordState extends NodeStateBase {
  /** Source metadata; populated by `json-read`. */
  source: InputSource;

  /** Parsed input record; populated by `json-read`. */
  input: Readonly<Record<string, unknown>>;

  /** Per-classifier proposal, keyed by classifier name (race-free slots). */
  proposals: Record<string, ClassificationProposal>;

  /** Reduced classification (or null until `classify-conflict` runs). */
  classification: ClassificationEvidence | null;

  /** Projected quads from `squash`. Held inline so streaming can flush per record. */
  squashedQuads: unknown[];

  /** Failed-records bucket set by `record-quarantine`. */
  quarantineBucket: 'unknown' | 'conflicts' | 'projection' | 'output' | null;

  /** Locator copy carried for fan-in summarisation. */
  recordPath: string;
  recordLine: number;

  constructor(source: InputSource, recordPath: string, recordLine: number) {
    super();
    this.source           = source;
    this.input            = {};
    this.proposals        = {};
    this.classification   = null;
    this.squashedQuads    = [];
    this.quarantineBucket = null;
    this.recordPath       = recordPath;
    this.recordLine       = recordLine;
  }

  override clone() {
    const base = super.clone() as this;
    base.source           = this.source;
    base.input            = this.input;
    base.proposals        = { ...this.proposals };
    base.classification   = this.classification;
    base.squashedQuads    = [...this.squashedQuads];
    base.quarantineBucket = this.quarantineBucket;
    base.recordPath       = this.recordPath;
    base.recordLine       = this.recordLine;
    return base;
  }

  protected override snapshotData(): JsonObjectType {
    return {
      source:           this.source           as unknown as JsonValueType,
      input:            this.input            as unknown as JsonValueType,
      proposals:        this.proposals        as unknown as JsonValueType,
      classification:   (this.classification ?? null) as unknown as JsonValueType,
      squashedNQuads:   Serializer.serializeNquadsSync(this.squashedQuads as Quad[]),
      quarantineBucket: (this.quarantineBucket ?? null) as unknown as JsonValueType,
      recordPath:       this.recordPath,
      recordLine:       this.recordLine,
    };
  }

  /**
   * Rehydrate a `SquashageRecordState` from a JSON snapshot produced by
   * `NodeStateBase.snapshot()`. Constructs a blank instance with sentinel
   * values, then delegates to `applySnapshot` (which calls `restoreData`).
   *
   * Named `fromSnapshot` rather than `restore` to avoid a static signature
   * conflict with the generic `NodeStateBase.restore<T>(this: new()=>T, …)`.
   * The worker registry passes this via an adapter object literal:
   * `{ restore: (snap) => SquashageRecordState.fromSnapshot(snap) }`.
   */
  static fromSnapshot(snapshot: JsonObjectType): SquashageRecordState {
    const state = new SquashageRecordState({ target: '', path: '' }, '', 0);
    state.applySnapshot(snapshot);
    return state;
  }

  protected override restoreData(snap: JsonObjectType): void {
    const source = snap['source'];
    if (isPlainObject(source)) this.source = source as unknown as InputSource;
    const input = snap['input'];
    if (isPlainObject(input))  this.input  = input  as unknown as Readonly<Record<string, unknown>>;
    const proposals = snap['proposals'];
    if (isPlainObject(proposals)) this.proposals = proposals as unknown as Record<string, ClassificationProposal>;
    const classification = snap['classification'];
    this.classification = isPlainObject(classification)
      ? classification as unknown as ClassificationEvidence
      : null;
    const nquads = snap['squashedNQuads'];
    if (typeof nquads === 'string' && nquads.length > 0) {
      this.squashedQuads = Parser.parseNquadsSync(nquads);
    }
    const bucket = snap['quarantineBucket'];
    this.quarantineBucket = bucket === 'unknown' || bucket === 'conflicts' || bucket === 'projection' || bucket === 'output'
      ? bucket
      : null;
    const recordPath = snap['recordPath'];
    if (typeof recordPath === 'string') this.recordPath = recordPath;
    const recordLine = snap['recordLine'];
    if (typeof recordLine === 'number') this.recordLine = recordLine;
  }
}

function isPlainObject(value: JsonValueType | undefined): value is JsonObjectType {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
