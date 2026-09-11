import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { createRequire } from 'node:module';
import { URL, fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const groups = {
  unit: ['unit'], integration: ['integration'], e2e: ['e2e'],
  performance: ['performance'], external: ['external'],
  fast: ['unit', 'integration'], all: ['unit', 'integration', 'e2e'],
  complete: ['unit', 'integration', 'e2e', 'performance', 'external']
};
const [group = 'all', ...args] = process.argv.slice(2);
if (!groups[group]) { throw new Error('Unknown test group: ' + group); }
const build = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc')], { cwd: root, stdio: 'inherit' });
if (build.error) { throw build.error; }
if (build.status !== 0) { process.exit(build.status ?? 1); }
const files = groups[group].flatMap(dir => {
  const source = path.join(root, 'src/test', dir);
  if (!fs.existsSync(source)) { return []; }
  return fs.readdirSync(source, { recursive: true }).filter(file => file.endsWith('.test.ts'))
    .sort().map(file => path.join(root, 'out/test', dir, file.replace(/\.ts$/, '.js')));
});
// Source discovery excludes all stale compiler output after moves or deletions.
const result = spawnSync(process.execPath, [require.resolve('mocha/bin/mocha.js'), '--ui', 'tdd', '--fail-zero',
  ...files, ...args], { cwd: root, stdio: 'inherit' });
if (result.error) { throw result.error; }
process.exit(result.status ?? 1);
