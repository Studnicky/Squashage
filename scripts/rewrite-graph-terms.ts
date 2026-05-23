/**
 * One-shot rewrite: every quad in graphs/aonprd/aonprd.nq gets its graph term
 * replaced with a per-class named graph based on the subject's leaf class
 * (rdf:type). Brings the existing file up to the P24a per-class-graph convention
 * so the viz partitions correctly without re-running the pipeline.
 *
 * Two passes: pass 1 builds subject→class map from rdf:type triples; pass 2
 * streams the file, rewrites each quad's trailing graph term, and writes the
 * result to a sibling file then replaces the original.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const IN  = './graphs/aonprd/aonprd.nq';
const TMP = './graphs/aonprd/aonprd.nq.tmp';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const LEAF_CLASSES = [
  'Action', 'Ancestry', 'Armor', 'Background', 'Class', 'Condition', 'Equipment',
  'Feat', 'Generic', 'Hazard', 'Monster', 'MonsterFamily', 'Rule', 'Spell',
  'Trait', 'Unknown', 'Weapon',
];
const LEAF_IRIS = new Map<string, string>(
  LEAF_CLASSES.map((c) => [`https://2e.aonprd.com/${c}`, c]),
);

interface Triple { s: string; p: string; o: string; }

function parseN3Line(line: string): { triple: Triple; tail: string } | null {
  // Returns subject/predicate/object as raw `<...>` / `"..."` tokens plus the
  // trailing graph + `.` segment. Only used to extract the parts we need to
  // route on; we never re-emit the parsed object form, so literal escaping is
  // preserved.
  let pos = 0;
  function readTerm(): string | null {
    while (pos < line.length && (line[pos] === ' ' || line[pos] === '\t')) pos += 1;
    if (pos >= line.length) return null;
    const ch = line[pos];
    if (ch === '<') {
      const end = line.indexOf('>', pos + 1);
      if (end === -1) return null;
      const t = line.slice(pos, end + 1);
      pos = end + 1;
      return t;
    }
    if (ch === '"') {
      let i = pos + 1;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '"') break;
        i += 1;
      }
      i += 1;
      if (line[i] === '^' && line[i + 1] === '^') {
        const dtEnd = line.indexOf('>', i + 2);
        i = dtEnd + 1;
      } else if (line[i] === '@') {
        while (i < line.length && line[i] !== ' ' && line[i] !== '\t' && line[i] !== '.') i += 1;
      }
      const t = line.slice(pos, i);
      pos = i;
      return t;
    }
    if (ch === '_' && line[pos + 1] === ':') {
      let j = pos + 2;
      while (j < line.length && line[j] !== ' ' && line[j] !== '\t') j += 1;
      const t = line.slice(pos, j);
      pos = j;
      return t;
    }
    return null;
  }
  const s = readTerm();
  if (s === null) return null;
  const p = readTerm();
  if (p === null) return null;
  const o = readTerm();
  if (o === null) return null;
  // The remainder is the optional graph term + ` .`
  const tail = line.slice(pos);
  return { triple: { s, p, o }, tail };
}

async function pass1(): Promise<Map<string, string>> {
  const subjectToClass = new Map<string, string>();
  const stream = createReadStream(IN, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) {
    count += 1;
    if (count % 1000000 === 0) process.stdout.write(`  pass1: ${String(count)} lines\n`);
    const parsed = parseN3Line(line);
    if (parsed === null) continue;
    const { s, p, o } = parsed.triple;
    if (p !== `<${RDF_TYPE}>`) continue;
    if (!o.startsWith('<')) continue;
    const objIri = o.slice(1, -1);
    const leaf = LEAF_IRIS.get(objIri);
    if (leaf !== undefined) {
      const subj = s.startsWith('<') ? s.slice(1, -1) : s;
      subjectToClass.set(subj, leaf);
    }
  }
  return subjectToClass;
}

async function pass2BfsExpand(subjectToClass: Map<string, string>): Promise<void> {
  // Build outgoing-edges index in one pass through the file.
  const edges = new Map<string, string[]>();
  const stream = createReadStream(IN, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    const parsed = parseN3Line(line);
    if (parsed === null) continue;
    const { s, o } = parsed.triple;
    if (!o.startsWith('<')) continue;
    const subj = s.startsWith('<') ? s.slice(1, -1) : s;
    const obj  = o.slice(1, -1);
    const arr = edges.get(subj);
    if (arr === undefined) edges.set(subj, [obj]);
    else arr.push(obj);
  }
  process.stdout.write(`  BFS propagating from ${String(subjectToClass.size)} roots ...\n`);
  for (let depth = 0; depth < 6; depth++) {
    let added = 0;
    for (const [s, cls] of subjectToClass) {
      const out = edges.get(s);
      if (out === undefined) continue;
      for (const o of out) {
        if (!subjectToClass.has(o)) { subjectToClass.set(o, cls); added += 1; }
      }
    }
    process.stdout.write(`    depth=${String(depth)} +${String(added)}\n`);
    if (added === 0) break;
  }
}

async function pass3Rewrite(subjectToClass: Map<string, string>): Promise<void> {
  const inStream  = createReadStream(IN, { encoding: 'utf8' });
  const outStream = createWriteStream(TMP, { encoding: 'utf8' });
  const lines = createInterface({ input: inStream, crlfDelay: Infinity });
  let count = 0, rewrote = 0;
  const matcher = /<https:\/\/squashage\.dev\/graph\/aonprd\/[^>]+>\s*\.\s*$/;
  for await (const line of lines) {
    count += 1;
    if (count % 1000000 === 0) process.stdout.write(`  pass3: ${String(count)} lines (${String(rewrote)} rewritten)\n`);
    // Find the subject (first <...> in the line) — cheap regex.
    const subjMatch = line.match(/^<([^>]+)>/);
    if (subjMatch === null) { outStream.write(line + '\n'); continue; }
    const subj = subjMatch[1] as string;
    const cls = subjectToClass.get(subj);
    if (cls === undefined) { outStream.write(line + '\n'); continue; }
    // Replace the trailing graph term with the per-class one.
    const newGraph = `<https://squashage.dev/graph/aonprd/${cls}> .`;
    if (matcher.test(line)) {
      outStream.write(line.replace(matcher, newGraph) + '\n');
      rewrote += 1;
    } else {
      outStream.write(line + '\n');
    }
  }
  outStream.end();
  await new Promise<void>((resolve, reject) => {
    outStream.on('finish', () => resolve());
    outStream.on('error',  reject);
  });
  process.stdout.write(`  pass3 done: rewrote ${String(rewrote)} of ${String(count)} lines\n`);
}

async function main(): Promise<void> {
  process.stdout.write('Pass 1: scan rdf:type ...\n');
  const subjectToClass = await pass1();
  process.stdout.write(`  ${String(subjectToClass.size)} root instances\n`);
  process.stdout.write('Pass 2: BFS expand to skolems ...\n');
  await pass2BfsExpand(subjectToClass);
  process.stdout.write(`  ${String(subjectToClass.size)} subjects-with-class total\n`);
  process.stdout.write('Pass 3: rewrite graph terms ...\n');
  await pass3Rewrite(subjectToClass);
  await rename(TMP, IN);
  process.stdout.write(`\nreplaced ${IN}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
