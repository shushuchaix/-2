import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = fileURLToPath(new URL('../../.cache/', import.meta.url));
let runDirectory;
const suites = new Map();
const segment = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new TypeError('invalid_test_evidence_name');
  return value;
};

// Allocate lazily: skipped/imported suites leave no artifacts. Never reuse or
// remove a prior run's directory, even when this process runs a suite twice.
export async function writeTestEvidence(suite, filename, contents) {
  segment(suite); segment(filename);
  runDirectory ??= (async () => {
    await fs.mkdir(cache, { recursive: true });
    return fs.mkdtemp(path.join(cache, 'test-evidence-'));
  })();
  if (!suites.has(suite)) suites.set(suite, (async () => {
    const directory = path.join(await runDirectory, suite);
    await fs.mkdir(directory);
    return directory;
  })());
  const file = path.join(await suites.get(suite), filename);
  await fs.writeFile(file, contents, { flag: 'wx' });
  console.log('[test-evidence] ' + file);
  return file;
}
