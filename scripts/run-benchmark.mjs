import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { URL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  assert.ok(['--output', '--baseline', '--samples'].includes(key) && value, 'Expected --output PATH, --baseline PATH or --samples N');
  assert.ok(!options.has(key), 'Duplicate option ' + key);
  options.set(key, value);
}
const count = Number(options.get('--samples') ?? 3);
assert.ok(Number.isInteger(count) && count >= 3 && count <= 100, 'Use 3-100 independent process samples');
const output = options.get('--output');
if (output) { assert.ok(!fs.existsSync(output), 'Output already exists: ' + output); }
const baselinePath = options.get('--baseline');
const readJson = file => {
  const bytes = fs.readFileSync(file);
  return JSON.parse(bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\uFEFF/, ''));
};
const baseline = baselinePath ? readJson(baselinePath) : undefined;
function run(args, json = false) {
  const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (child.error) { throw child.error; }
  if (child.status !== 0) { throw new Error(child.stderr || child.stdout || 'Child failed: ' + child.status); }
  return json ? JSON.parse(child.stdout) : undefined;
}
run([require.resolve('typescript/bin/tsc')]);
const samples = [];
for (let i = 0; i < count; i++) {
  console.error('Benchmark process ' + (i + 1) + '/' + count);
  samples.push(run(['--expose-gc', 'scripts/benchmark.mjs'], true));
}
const identity = sample => JSON.stringify([sample.schemaVersion, sample.node, sample.platform, sample.arch, sample.cpu, sample.gc]);
function validate(candidates) {
  for (const sample of candidates) {
    assert.equal(identity(sample), identity(samples[0]), 'Runtime/machine mismatch');
    assert.equal(sample.rows.length, samples[0].rows.length, 'Workload mismatch');
    sample.rows.forEach((row, i) => {
      const expected = samples[0].rows[i];
      assert.equal(row.scenario + ':' + row.size, expected.scenario + ':' + expected.size, 'Workload mismatch');
      assert.equal(row.resultHash, expected.resultHash, 'Result mismatch: ' + row.scenario + '/' + row.size);
      for (const metric of ['wallMs', 'cpuMs', 'heapDelta', 'rss']) { assert.ok(Number.isFinite(row[metric]), 'Invalid ' + metric); }
    });
  }
}
validate(samples);
if (baseline) {
  assert.equal(baseline.schemaVersion, 1);
  assert.ok(Array.isArray(baseline.samples) && baseline.samples.length >= 3);
  validate(baseline.samples);
}
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const summary = samples[0].rows.map((row, i) => ({
  scenario: row.scenario, size: row.size,
  ...Object.fromEntries(['wallMs', 'cpuMs', 'heapDelta', 'rss'].map(key => [key, median(samples.map(sample => sample.rows[i][key]))])),
  ...(baseline ? { baselineWallMs: median(baseline.samples.map(sample => sample.rows[i].wallMs)) } : {})
}));
const result = { schemaVersion: 1, samples, summary };
const json = JSON.stringify(result, null, 2) + '\n';
if (output) {
  fs.writeFileSync(path.resolve(output), json, { encoding: 'utf8', flag: 'wx' });
  console.table(summary.map(row => ({ scenario: row.scenario, size: row.size,
    medianMs: row.wallMs.toFixed(2), ...(baseline ? {beforeMs: row.baselineWallMs.toFixed(2)} : {}) })));
} else { process.stdout.write(json); }
