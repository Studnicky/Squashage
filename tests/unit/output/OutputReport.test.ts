import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OutputReport, OUTPUT_REPORT_FILENAME } from '../../../src/output/OutputReport.js';
import type { OutputReportInterface }            from '../../../src/output/OutputInterface.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_REPORT: OutputReportInterface = {
  path:         './graphs/aonprd.jsonld',
  format:       'turtle',
  quadCount:    0,
  graphCount:   0,
  durationMs:   5,
  bytesWritten: 0,
  errors:       [],
};

const FULL_REPORT: OutputReportInterface = {
  path:         './graphs/aonprd.jsonld',
  format:       'trig',
  quadCount:    1234,
  graphCount:   3,
  durationMs:   87,
  bytesWritten: 45632,
  errors:       [
    { stage: 'validate', message: 'SHACL violation on ex:foo' },
    { stage: 'finalize', message: 'fsync failed' },
  ],
};

// ---------------------------------------------------------------------------
// OUTPUT_REPORT_FILENAME export
// ---------------------------------------------------------------------------

describe('OutputReport — constant', () => {
  it('exports the correct filename', () => {
    assert.equal(OUTPUT_REPORT_FILENAME, 'output.report.json');
  });
});

// ---------------------------------------------------------------------------
// toJson
// ---------------------------------------------------------------------------

describe('OutputReport.toJson', () => {
  it('returns a non-empty string', () => {
    const json = OutputReport.toJson(MINIMAL_REPORT);
    assert.ok(json.length > 0, 'should be non-empty');
  });

  it('produces valid JSON', () => {
    const json = OutputReport.toJson(FULL_REPORT);
    assert.doesNotThrow(() => JSON.parse(json));
  });

  it('includes all required fields', () => {
    const json = OutputReport.toJson(FULL_REPORT);
    const obj = JSON.parse(json) as Record<string, unknown>;

    assert.equal(obj['path'],         FULL_REPORT.path);
    assert.equal(obj['format'],       FULL_REPORT.format);
    assert.equal(obj['quadCount'],    FULL_REPORT.quadCount);
    assert.equal(obj['graphCount'],   FULL_REPORT.graphCount);
    assert.equal(obj['durationMs'],   FULL_REPORT.durationMs);
    assert.equal(obj['bytesWritten'], FULL_REPORT.bytesWritten);
    assert.ok(Array.isArray(obj['errors']), 'errors should be an array');
  });

  it('serializes errors array correctly', () => {
    const json = OutputReport.toJson(FULL_REPORT);
    const obj  = JSON.parse(json) as { errors: Array<{ stage: string; message: string }> };
    assert.equal(obj.errors.length, 2);
    assert.equal(obj.errors[0]?.stage, 'validate');
    assert.equal(obj.errors[1]?.stage, 'finalize');
  });

  it('pretty-prints with 2-space indentation', () => {
    const json = OutputReport.toJson(MINIMAL_REPORT);
    assert.ok(json.startsWith('{\n  "'), 'should start with 2-space indent');
  });
});

// ---------------------------------------------------------------------------
// fromJson — round-trip
// ---------------------------------------------------------------------------

describe('OutputReport.fromJson — round-trip', () => {
  it('round-trips a minimal report', () => {
    const json     = OutputReport.toJson(MINIMAL_REPORT);
    const restored = OutputReport.fromJson(json);

    assert.equal(restored.path,         MINIMAL_REPORT.path);
    assert.equal(restored.format,       MINIMAL_REPORT.format);
    assert.equal(restored.quadCount,    MINIMAL_REPORT.quadCount);
    assert.equal(restored.graphCount,   MINIMAL_REPORT.graphCount);
    assert.equal(restored.durationMs,   MINIMAL_REPORT.durationMs);
    assert.equal(restored.bytesWritten, MINIMAL_REPORT.bytesWritten);
    assert.equal(restored.errors.length, 0);
  });

  it('round-trips a full report with errors', () => {
    const json     = OutputReport.toJson(FULL_REPORT);
    const restored = OutputReport.fromJson(json);

    assert.equal(restored.format,         FULL_REPORT.format);
    assert.equal(restored.quadCount,      FULL_REPORT.quadCount);
    assert.equal(restored.bytesWritten,   FULL_REPORT.bytesWritten);
    assert.equal(restored.errors.length,  2);
    assert.equal(restored.errors[0]?.stage,   'validate');
    assert.equal(restored.errors[1]?.stage,   'finalize');
  });

  it('round-trips all five RDF format values', () => {
    const formats = ['turtle', 'trig', 'ntriples', 'nquads', 'jsonld'] as const;
    for (const format of formats) {
      const report: OutputReportInterface = { ...MINIMAL_REPORT, format };
      const restored = OutputReport.fromJson(OutputReport.toJson(report));
      assert.equal(restored.format, format, `format "${format}" should round-trip`);
    }
  });
});

// ---------------------------------------------------------------------------
// fromJson — structural validation
// ---------------------------------------------------------------------------

describe('OutputReport.fromJson — validation errors', () => {
  it('throws SyntaxError on invalid JSON', () => {
    assert.throws(
      () => OutputReport.fromJson('not-json'),
      SyntaxError,
    );
  });

  it('throws TypeError when path is missing', () => {
    const bad = JSON.stringify({ format: 'turtle', quadCount: 0, graphCount: 0, durationMs: 0, bytesWritten: 0, errors: [] });
    assert.throws(() => OutputReport.fromJson(bad), TypeError);
  });

  it('throws TypeError when format is an invalid RDFFormat', () => {
    const bad = JSON.stringify({ path: './x.ttl', format: 'rdfxml', quadCount: 0, graphCount: 0, durationMs: 0, bytesWritten: 0, errors: [] });
    assert.throws(() => OutputReport.fromJson(bad), TypeError);
  });

  it('throws TypeError when quadCount is not a number', () => {
    const bad = JSON.stringify({ path: './x.ttl', format: 'turtle', quadCount: 'many', graphCount: 0, durationMs: 0, bytesWritten: 0, errors: [] });
    assert.throws(() => OutputReport.fromJson(bad), TypeError);
  });

  it('throws TypeError when errors contains an invalid stage', () => {
    const bad = JSON.stringify({
      path: './x.ttl', format: 'turtle', quadCount: 0, graphCount: 0, durationMs: 0, bytesWritten: 0,
      errors: [{ stage: 'bad-stage', message: 'oops' }],
    });
    assert.throws(() => OutputReport.fromJson(bad), TypeError);
  });
});
