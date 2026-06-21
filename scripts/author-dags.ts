/**
 * author-dags — serialize all 7 DAG topologies to .dag.jsonld files in src/dag/.
 *
 * Run via: node --import tsx scripts/author-dags.ts
 *
 * Each DAG is serialized with DAGDocument.serialize (pretty 2-space JSON) and
 * written to src/dag/<kebab-name>.dag.jsonld.
 *
 * Semantic delta: squashage:run is serialized with DEFAULT_RECORD_CONCURRENCY (1).
 * Production runs override concurrency at runtime via RunDag.build(n).
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAGDocument } from '@studnicky/dagonizer';
import { recordDag } from '../src/dag/recordDag.js';
import { recordInduceDag } from '../src/dag/recordInduceDag.js';
import { induceDag } from '../src/dag/induceDag.js';
import { refineDag } from '../src/dag/refineDag.js';
import { refineOneDag } from '../src/dag/refineOneDag.js';
import { bootstrapDag } from '../src/dag/bootstrapDag.js';
import { RunDag } from '../src/dag/runDag.js';

type DagEntry = { filename: string; dag: ReturnType<typeof DAGDocument.load> };

class DagAuthorer {
  static async run(): Promise<void> {
    const dagDir = join(fileURLToPath(import.meta.url), '../../src/dag');

    // squashage:run is authored with the static default concurrency.
    const runDag = RunDag.build();

    const entries: DagEntry[] = [
      { filename: 'squashage-record.dag.jsonld',        dag: recordDag },
      { filename: 'squashage-record-induce.dag.jsonld', dag: recordInduceDag },
      { filename: 'squashage-induce.dag.jsonld',        dag: induceDag },
      { filename: 'squashage-refine.dag.jsonld',        dag: refineDag },
      { filename: 'squashage-refine-one.dag.jsonld',    dag: refineOneDag },
      { filename: 'squashage-bootstrap.dag.jsonld',     dag: bootstrapDag },
      { filename: 'squashage-run.dag.jsonld',           dag: runDag },
    ];

    for (const entry of entries) {
      const serialized = DAGDocument.serialize(entry.dag);
      const outPath = join(dagDir, entry.filename);
      await writeFile(outPath, serialized, 'utf-8');
      process.stdout.write(`  wrote ${entry.filename}\n`);
    }

    process.stdout.write(`Authored ${entries.length.toString()} DAG document(s) into ${dagDir}\n`);
  }
}

await DagAuthorer.run();
