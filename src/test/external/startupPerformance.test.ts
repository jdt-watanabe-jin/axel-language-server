import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import type { FullDocumentDiagnosticReport } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';
import { diagnosticDigest, median } from '../support/startupMeasurement';

interface StartupSample { coldMs: number; warmMs: number; digest: string; diagnosticCount: number }
interface StartupMeasurement {
  schemaVersion: number; nodeVersion: string; inputHash: string; settingsHash: string; encoding: string;
  rootUri: string; sampleUri: string; samples: StartupSample[]; coldMedianMs: number; warmMedianMs: number;
}

suite('External startup performance', function () {
  this.timeout(600_000);
  test('measures three fresh processes and compares complete diagnostic results', async function () {
    const sample = process.env.AXEL_STARTUP_SAMPLE;
    if (!sample) { this.skip(); }
    const root = process.env.AXEL_STARTUP_ROOT;
    assert.ok(root, 'AXEL_STARTUP_ROOT is required');
    assert.ok(fs.statSync(root).isDirectory());
    assert.ok(process.env.AXEL_STARTUP_SETTINGS, 'AXEL_STARTUP_SETTINGS is required');
    const settings: unknown = JSON.parse(process.env.AXEL_STARTUP_SETTINGS);
    assert.ok(settings && typeof settings === 'object' && !Array.isArray(settings));
    const encoding = process.env.AXEL_STARTUP_ENCODING ?? 'shift_jis';
    const bytes = fs.readFileSync(sample);
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    const uri = pathToFileURL(sample).toString();
    const rootUri = pathToFileURL(root).toString();
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const inputHash = hash(bytes), settingsHash = hash(JSON.stringify(settings));
    const baseline: StartupMeasurement | undefined = process.env.AXEL_STARTUP_BASELINE
      ? JSON.parse(fs.readFileSync(process.env.AXEL_STARTUP_BASELINE, 'utf8')) : undefined;
    if (baseline) {
      assert.deepStrictEqual([baseline.schemaVersion, baseline.nodeVersion, baseline.inputHash, baseline.settingsHash,
        baseline.encoding, baseline.rootUri, baseline.sampleUri], [1, process.version, inputHash, settingsHash, encoding, rootUri, uri],
      'Baseline must use the same runtime, source and configuration');
      assert.strictEqual(baseline.samples.length, 3);
    }
    const profileDirectory = process.env.AXEL_STARTUP_PROFILE_DIR;
    if (profileDirectory) { assert.ok(fs.statSync(profileDirectory).isDirectory()); }
    const samples: StartupSample[] = [];
    for (let run = 0; run < 3; run++) {
      const server = startLspServer(120_000, { execArgv: profileDirectory
        ? ['--cpu-prof', `--cpu-prof-dir=${profileDirectory}`] : [] });
      server.onRequest('workspace/codeLens/refresh', () => null);
      server.onInlayHintRefresh(() => null);
      try {
        await server.request('initialize', { processId: null, rootUri,
          capabilities: { textDocument: { diagnostic: {} } }, configuration: settings });
        await server.notify('initialized', {});
        const start = performance.now();
        await server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'axel', version: 1, text } });
        const first = await server.request<FullDocumentDiagnosticReport>('textDocument/diagnostic', { textDocument: { uri } });
        const coldMs = performance.now() - start;
        const warmStart = performance.now();
        const warm = await server.request<FullDocumentDiagnosticReport>('textDocument/diagnostic', { textDocument: { uri } });
        const warmMs = performance.now() - warmStart;
        const digest = diagnosticDigest(first.items);
        assert.strictEqual(diagnosticDigest(warm.items), digest);
        if (samples.length) { assert.strictEqual(digest, samples[0].digest); }
        if (baseline) { for (const previous of baseline.samples) { assert.strictEqual(digest, previous.digest); } }
        samples.push({ coldMs, warmMs, digest, diagnosticCount: first.items.length });
        console.log(JSON.stringify({ run: run + 1, ...samples.at(-1) }));
      } finally { await server.stop(); }
    }
    const result: StartupMeasurement = { schemaVersion: 1, nodeVersion: process.version,
      inputHash, settingsHash, encoding, rootUri, sampleUri: uri, samples,
      coldMedianMs: median(samples.map(s => s.coldMs)), warmMedianMs: median(samples.map(s => s.warmMs)) };
    const output = process.env.AXEL_STARTUP_OUTPUT;
    if (output) {
      for (const protectedPath of [sample, process.env.AXEL_STARTUP_BASELINE]) {
        assert.ok(!protectedPath || path.resolve(output).toLowerCase() !== path.resolve(protectedPath).toLowerCase(),
          'Measurement output must not overwrite source or baseline');
      }
      fs.writeFileSync(output, JSON.stringify(result, null, 2));
    }
    console.log(JSON.stringify({ coldMedianMs: result.coldMedianMs, warmMedianMs: result.warmMedianMs,
      ...(baseline ? { improvementPercent: (1 - result.coldMedianMs / baseline.coldMedianMs) * 100 } : {}) }));
  });
});
