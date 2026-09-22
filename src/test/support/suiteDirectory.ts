import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Only immutable input files belong here. Analyzer instances remain per-test.
export function useSuiteDirectory(): () => string {
  let directory: string;
  suiteSetup(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-suite-')); });
  suiteTeardown(() => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return () => directory;
}
