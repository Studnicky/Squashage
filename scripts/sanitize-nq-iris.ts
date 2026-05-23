/**
 * One-shot stream sanitizer: walks graphs/aonprd/aonprd.nq and percent-encodes
 * any whitespace / control-char that leaked into an IRI before the wrapper's
 * sanitizeIri fix landed. The pipeline now writes clean IRIs natively; this
 * script exists only to repair the pre-fix output file in place.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { rename } from 'node:fs/promises';

const IN  = './graphs/aonprd/aonprd.nq';
const TMP = './graphs/aonprd/aonprd.nq.tmp';

function isIriForbidden(c: number): boolean {
  if (c <= 0x20) return true;
  if (c === 0x7F) return true;
  if (c === 0x3C || c === 0x3E) return true;        // < >
  if (c === 0x22) return true;                       // "
  if (c === 0x7B || c === 0x7D) return true;        // { }
  if (c === 0x7C) return true;                       // |
  if (c === 0x5C) return true;                       // backslash
  if (c === 0x5E) return true;                       // ^
  if (c === 0x60) return true;                       // backtick
  return false;
}

function pctEncode(c: number): string {
  return '%' + c.toString(16).padStart(2, '0').toUpperCase();
}

/**
 * Walk the line one char at a time. When we're inside `<...>` (an IRI), any
 * forbidden char gets percent-encoded. Literal strings (`"..."`) are left
 * intact — they may legitimately contain spaces.
 */
function sanitizeLine(line: string): string {
  let out = '';
  let inIri = false;
  let inLit = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (inIri) {
      if (ch === '>') { inIri = false; out += ch; i += 1; continue; }
      const c = ch.charCodeAt(0);
      if (isIriForbidden(c)) out += pctEncode(c);
      else out += ch;
      i += 1;
      continue;
    }
    if (inLit) {
      if (ch === '\\' && i + 1 < line.length) { out += ch + line[i + 1]; i += 2; continue; }
      if (ch === '"') inLit = false;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '<') { inIri = true; out += ch; i += 1; continue; }
    if (ch === '"') { inLit = true; out += ch; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

async function main(): Promise<void> {
  const inStream  = createReadStream(IN,  { encoding: 'utf8' });
  const outStream = createWriteStream(TMP, { encoding: 'utf8' });
  const lines     = createInterface({ input: inStream, crlfDelay: Infinity });

  let total = 0;
  let fixed = 0;
  for await (const line of lines) {
    total += 1;
    const sanitized = sanitizeLine(line);
    if (sanitized !== line) fixed += 1;
    outStream.write(sanitized + '\n');
    if (total % 1000000 === 0) process.stdout.write(`  ${String(total)} lines (${String(fixed)} touched)\n`);
  }
  outStream.end();
  await new Promise<void>((resolve, reject) => {
    outStream.on('finish', () => resolve());
    outStream.on('error',  reject);
  });
  process.stdout.write(`scanned ${String(total)} lines, sanitized ${String(fixed)}\n`);
  await rename(TMP, IN);
  process.stdout.write(`replaced ${IN}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
