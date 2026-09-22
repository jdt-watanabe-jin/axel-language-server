import * as assert from 'assert';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { WorkspaceIndex, type WorkspaceIndexOptions } from '../../analyzer/workspaceIndex';
import { collectSemanticTokens } from '../../analyzer/semanticTokens';

suite('external semantic and diagnostic performance', function () {
  this.timeout(180_000);
  test('measures open, dependency indexing and edited feature results', async function () {
    const sample = process.env.AXEL_PERF_SAMPLE;
    if (!sample) { this.skip(); }
    const settings = JSON.parse(process.env.AXEL_PERF_SETTINGS ?? '{}') as WorkspaceIndexOptions;
    const text = new TextDecoder(process.env.AXEL_PERF_ENCODING ?? 'utf-8').decode(fs.readFileSync(sample));
    const uri = pathToFileURL(sample).toString();

    const timings: Record<string, number> = {};
    function measure<T>(name: string, work: () => T): T {
      const start = performance.now();
      try { return work(); } finally { timings[name] = performance.now() - start; }
    }
    let maxBackgroundMs = 0;
    // Timing logger is local to this benchmark; production protocol is unchanged.
    const measuredIndex = new WorkspaceIndex({ ...settings, logger: {
      info: () => undefined, error: message => { throw new Error(message); },
      timing: message => {
        if (message.includes('operation=workspace.background')) {
          maxBackgroundMs = Math.max(maxBackgroundMs, Number(message.split('durationMs=')[1]));
        }
      }
    } });

    try {
      const input = { uri, version: 1, text };
      const foreground = measure('openAnalysisMs', () => measuredIndex.analyzeForegroundDocument(input));
      measure('initialTokensMs', () => collectSemanticTokens(foreground, measuredIndex.semanticTokenWorkspaceIndex(uri)));
      const start = performance.now();
      await measuredIndex.waitForBackgroundIndexing();
      timings.backgroundElapsedMs = performance.now() - start;
      timings.maxBackgroundTaskMs = maxBackgroundMs;
      const initial = measure('settledDiagnosticsMs', () => measuredIndex.analyzeDiagnosticDocument(input));
      const initialTokens = measure('settledTokensMs', () => collectSemanticTokens(initial, measuredIndex.semanticTokenWorkspaceIndex(uri)));
      assert.ok(initialTokens.length > 0);
      const edit = { ...input, version: 2, text: text + '\n' };
      const edited = measure('editAnalysisMs', () => measuredIndex.analyzeForegroundDocument(edit));
      measure('editedTokensMs', () => collectSemanticTokens(edited, measuredIndex.semanticTokenWorkspaceIndex(uri)));
      await measuredIndex.waitForBackgroundIndexing();
      const diagnosed = measure('editedDiagnosticsMs', () => measuredIndex.analyzeDiagnosticDocument(edit));
      assert.deepStrictEqual(collectSemanticTokens(diagnosed, measuredIndex.semanticTokenWorkspaceIndex(uri)), initialTokens);
      console.log(JSON.stringify({ lines: text.split('\n').length, diagnosticCount: diagnosed.diagnostics.length,
        tokenCount: initialTokens.length, timings }, null, 2));
    } finally { await measuredIndex.waitForBackgroundIndexing(); }
  });
});
