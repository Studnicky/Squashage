// render-favicons.mjs
//
// Render docs/public/favicon.svg to the PNG variants required by the SEO
// asset suite. Browsers and crawlers that do not support inline SVG favicons
// fall back to these raster files. Wired into docs:build via predocs:build.
//
// Dependency: rsvg-convert (librsvg). Install via Homebrew on macOS:
//   brew install librsvg
// or via apt on Linux:
//   sudo apt-get install librsvg2-bin

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync }              from 'node:fs';
import { join, dirname }           from 'node:path';
import { fileURLToPath }           from 'node:url';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'public');
const SRC        = join(PUBLIC_DIR, 'favicon.svg');

if (!existsSync(SRC)) {
  process.stdout.write('render-favicons: favicon.svg missing; skipping\n');
  process.exit(0);
}

// Resolve rsvg-convert — try PATH first, then the Homebrew prefix on macOS.
const CANDIDATES = ['rsvg-convert', '/opt/homebrew/bin/rsvg-convert', '/usr/local/bin/rsvg-convert'];
let rsvgConvert = null;
for (const candidate of CANDIDATES) {
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf-8' });
  if (probe.status === 0) { rsvgConvert = candidate; break; }
}

if (rsvgConvert === null) {
  process.stdout.write(
    'render-favicons: rsvg-convert not found.\n' +
    '  macOS: brew install librsvg\n' +
    '  Linux: sudo apt-get install librsvg2-bin\n' +
    'Skipping PNG render — favicon PNGs will not be updated.\n',
  );
  process.exit(0);
}

/** @type {ReadonlyArray<{ size: number; name: string }>} */
const SIZES = [
  { size: 32,  name: 'favicon-32.png'  },
  { size: 48,  name: 'favicon-48.png'  },
  { size: 64,  name: 'favicon-64.png'  },
  { size: 180, name: 'favicon-180.png' },
  { size: 192, name: 'favicon-192.png' },
  { size: 512, name: 'favicon-512.png' },
];

for (const { size, name } of SIZES) {
  const out = join(PUBLIC_DIR, name);
  execFileSync(rsvgConvert, ['-w', String(size), '-h', String(size), SRC, '-o', out]);
  const { statSync } = await import('node:fs');
  const bytes = statSync(out).size;
  process.stdout.write(`render-favicons: wrote ${name} (${size}x${size}, ${bytes.toString()} bytes)\n`);
}
