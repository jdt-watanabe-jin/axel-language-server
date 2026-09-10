import * as assert from 'assert';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadTypeCheckingCases, typeCheckingFixtureRoot, type RuntimeCase } from '../support/typeCheckingCorpus';

// Explicit opt-in: ordinary CI never starts AXEL or requires proprietary files.
// AXEL_TEST_RUNTIME=1 AXEL_TEST_RUNTIME_EXE=<axel.exe> npm run test:external -- --grep "Type checking: external runtime"
// Optional: AXEL_TEST_RUNTIME_FILTER=<case-id substring>, AXEL_TEST_RUNTIME_OUTPUT=<directory>,
// AXEL_TEST_RUNTIME_INCLUDE_CRASH=1 (run the separately tracked compiler crash).
const enabled = process.env.AXEL_TEST_RUNTIME === '1';
const cases = loadTypeCheckingCases();
const filter = process.env.AXEL_TEST_RUNTIME_FILTER;
const selected = cases.filter(item => !filter || item.id.includes(filter));
const decoder = new TextDecoder('shift_jis');

interface Observation {
  id: string;
  expectedError: boolean | null;
  expectedCodes: string[];
  compilerCodes: string[];
  state: 'accepted' | 'compiler_error' | 'crash' | 'inconclusive' | 'not_run';
  exitCode: number | null;
  signal?: string | null;
  error?: string;
  loadSuccess?: boolean;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

suite('Type checking: external runtime', () => {
  let executable: string;
  let output: string;
  let runtimeHome: string;
  const observations: Observation[] = [];

  suiteSetup(function () {
    if (!enabled) { this.skip(); }
    assert.strictEqual(process.platform, 'win32', 'The verified AXEL runtime profile requires Windows.');
    assert.ok(process.env.AXEL_TEST_RUNTIME_EXE, 'Set AXEL_TEST_RUNTIME_EXE to the verified axel.exe.');
    executable = path.resolve(process.env.AXEL_TEST_RUNTIME_EXE!);
    const manifest = JSON.parse(fs.readFileSync(path.join(typeCheckingFixtureRoot, 'manifest.json'), 'utf8'));
    const executableSha256 = createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
    assert.strictEqual(executableSha256, manifest.executableSha256, 'Runtime differs from the verified compiler profile.');
    assert.ok(selected.length > 0, 'Runtime filter matched no corpus cases.');
    runtimeHome = process.env.AXEL_TEST_RUNTIME_HOME ?? path.dirname(path.dirname(executable));
    output = process.env.AXEL_TEST_RUNTIME_OUTPUT
      ? path.resolve(process.env.AXEL_TEST_RUNTIME_OUTPUT)
      : fs.mkdtempSync(path.join(os.tmpdir(), 'axel-type-runtime-'));
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'environment.json'), JSON.stringify({
      executable, executableSha256, runtimeHome, profile: manifest.profile,
      mode: '-nogui', startedAt: new Date().toISOString(), filter, selected: selected.map(item => item.id)
    }, null, 2));
    console.log(`AXEL runtime evidence: ${output}`);
  });

  function persist(observation: Observation): void {
    observations.push(observation);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(observations, null, 2));
  }

  async function run(runtimeCase: RuntimeCase): Promise<Observation> {
    const directory = path.join(output, ...runtimeCase.id.split('/'));
    fs.mkdirSync(directory, { recursive: true });
    // Keep corpus bytes unchanged; LoadFunction compiles without running the source main.
    fs.writeFileSync(path.join(directory, 'case.axl'), runtimeCase.source, 'utf8');
    fs.writeFileSync(path.join(directory, 'driver.axl'), [
      'void main(){',
      'int result = LoadFunction("case.axl");',
      'printf("AXEL_TYPE_RESULT:%d\\n", result);',
      '}', ''
    ].join('\n'), 'ascii');
    const start = performance.now();
    const child = await new Promise<{status:number|null; signal:string|null; error?:Error; stdout:Buffer; stderr:Buffer; timedOut:boolean}>(resolve => {
      const compiler = spawn(executable, ['-nogui', path.join(directory, 'driver.axl')], {
        cwd: directory, windowsHide: true,
        env: { ...process.env, SXM_HOME: runtimeHome, SXM_TEMP: directory,
          PATH: `${path.dirname(executable)};${process.env.PATH ?? ''}` }
      });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let error: Error | undefined, timedOut = false, size = 0;
      const timer = setTimeout(() => { timedOut = true; compiler.kill(); }, 20_000);
      const capture = (target: Buffer[]) => (chunk: Buffer): void => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { error = new Error('Compiler output exceeded 4 MB'); compiler.kill(); }
        else { target.push(chunk); }
      };
      compiler.stdout.on('data', capture(stdout)); compiler.stderr.on('data', capture(stderr));
      compiler.on('error', value => { error = value; });
      compiler.on('close', (status, signal) => {
        clearTimeout(timer);
        resolve({status, signal, error, stdout:Buffer.concat(stdout), stderr:Buffer.concat(stderr), timedOut});
      });
    });
    const stdout = decoder.decode(child.stdout);
    const stderr = decoder.decode(child.stderr);
    const compilerCodes = [...new Set([...`${stdout}\n${stderr}`.matchAll(/error\s+(C\d+)\b/gi)].map(match => match[1].toUpperCase()))];
    const marker = /AXEL_TYPE_RESULT:([01])/.exec(stdout);
    const exited = child.status === 0 && !child.error && !child.signal && !child.timedOut;
    const state: Observation['state'] = !exited
      ? child.timedOut ? 'inconclusive' : 'crash'
      : compilerCodes.length ? 'compiler_error'
      : marker?.[1] === '1' ? 'accepted' : 'inconclusive';
    const observation: Observation = {
      id: runtimeCase.id, expectedError: runtimeCase.expectedError, expectedCodes: runtimeCase.compilerCodes,
      compilerCodes, state, exitCode: child.status, signal: child.signal, error: child.error?.message,
      loadSuccess: marker ? marker[1] === '1' : undefined, stdout, stderr, elapsedMs: Math.round(performance.now() - start)
    };
    fs.writeFileSync(path.join(directory, 'observation.json'), JSON.stringify(observation, null, 2));
    persist(observation);
    return observation;
  }

  test('matches ordinary compiler cases using four isolated workers', async function () {
    const ordinary = selected.filter(item => item.expectedError !== null);
    this.timeout(Math.ceil(ordinary.length / 4) * 25_000 + 10_000);
    let cursor = 0;
    await Promise.all(Array.from({length:Math.min(4, ordinary.length)}, async () => {
      while (cursor < ordinary.length) {
        const runtimeCase = ordinary[cursor++];
        const observed = await run(runtimeCase);
        console.log(`${observations.length}/${ordinary.length} ${runtimeCase.id}: ${observed.state}`);
      }
    }));
    const mismatches = observations.filter(observed => observed.expectedError !== null && (
      observed.state !== (observed.expectedError ? 'compiler_error' : 'accepted')
      || observed.expectedError && !observed.expectedCodes.some(code => observed.compilerCodes.includes(code))
    ));
    assert.deepStrictEqual(mismatches.map(item => ({id:item.id, state:item.state, expected:item.expectedError,
      expectedCodes:item.expectedCodes, actualCodes:item.compilerCodes})), [], `See runtime evidence in ${output}`);
  });

  test('records the known compiler crash separately', async function () {
    this.timeout(25_000);
    const runtimeCase = selected.find(item => item.expectedError === null);
    if (!runtimeCase) { this.skip(); return; }
    if (process.env.AXEL_TEST_RUNTIME_INCLUDE_CRASH !== '1') {
      persist({ id: runtimeCase.id, expectedError: null, expectedCodes: [], compilerCodes: [],
        state: 'not_run', exitCode: null, stdout: '', stderr: '', elapsedMs: 0 });
      this.skip(); return;
    }
    const observed = await run(runtimeCase);
    // A compiler crash is evidence, never an ordinary accepted/error assertion.
    console.log(`Separately tracked compiler crash ${runtimeCase.id}: ${observed.state}`);
  });
});
