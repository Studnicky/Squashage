/**
 * walk-input — recursively walks the target's input path, producing one
 * `RecordLocator` per input record. JSON files yield one locator; JSONL files
 * yield one per non-blank line. Locators land in `state.locators`, which the
 * downstream fan-out placement reads via its `source` dotted path.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { NodeInterface } from '@noocodex/dagonizer';

import type { SquashageServices } from '../../services/SquashageServices.js';
import type { SquashageRunState } from '../../state/SquashageRunState.js';
import type { RecordLocator } from '../../state/schemas/RecordLocator.js';

type Output = 'walked' | 'empty';

async function locatorsFromJsonl(filePath: string): Promise<RecordLocator[]> {
  const text  = await readFile(filePath, 'utf8');
  const lines = text.split('\n');
  const locators: RecordLocator[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.trim().length > 0) {
      locators.push({ recordPath: filePath, recordLine: i });
    }
  }
  return locators;
}

async function walkDirectory(dirPath: string): Promise<RecordLocator[]> {
  const out: RecordLocator[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkDirectory(full)));
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (ext === '.json') out.push({ recordPath: full, recordLine: 0 });
      else if (ext === '.jsonl') out.push(...(await locatorsFromJsonl(full)));
    }
  }
  return out;
}

export const walkInputNode: NodeInterface<SquashageRunState, Output, SquashageServices> = {
  name:    'walk-input',
  outputs: ['walked', 'empty'],
  async execute(state, context) {
    const log = context.services.logger.forComponent('walk-input');
    const input = context.services.targetConfig.input;

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('execute', 'input path not accessible', { input, message });
      state.locators = [];
      return { output: 'empty' };
    }

    if (info.isDirectory()) {
      state.locators = await walkDirectory(input);
    } else {
      const ext = extname(input).toLowerCase();
      state.locators = ext === '.jsonl'
        ? await locatorsFromJsonl(input)
        : [{ recordPath: input, recordLine: 0 }];
    }

    log.info('execute', 'walk complete', { input, recordCount: state.locators.length });
    return { output: state.locators.length === 0 ? 'empty' : 'walked' };
  },
};
