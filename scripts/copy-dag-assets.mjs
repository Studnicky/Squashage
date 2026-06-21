// copy-dag-assets.mjs
// tsc never copies non-TS assets. Mirror .dag.jsonld from src/ → dist/ so
// the compiled CLI can load them by path relative to import.meta.dirname.

import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative }                  from 'node:path';

const SRC  = 'src';
const DIST = 'dist';

const stack = [SRC];
let copied = 0;
while (stack.length > 0) {
  const dir = stack.pop();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      stack.push(path);
    } else if (name.endsWith('.dag.jsonld') || name.endsWith('.schema.json')) {
      const dest = join(DIST, relative(SRC, path));
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(path, dest);
      copied += 1;
      process.stdout.write(`  copied ${dest}\n`);
    }
  }
}
process.stdout.write(`Copied ${copied.toString()} .dag.jsonld asset(s) into ${DIST}/\n`);
