import * as assert from 'assert';
import { CancellationTokenSource, LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';
import { getDocumentHighlightsSteps } from '../../analyzer/documentHighlights';
import { runAnalysisSteps, runAnalysisStepsAsync } from '../../util/analysisSteps';

suite('Document highlights performance', () => {
  for (const count of [20]) {
    test(`preserves initial, repeated and edited requests with ${count} references`, function () {
      this.timeout(30000);
      const analyzer = new DocumentAnalyzer();
      const text = `int value = 0;\nvoid main() {\n${'value += 1;\n'.repeat(count)}}`;
      const analysis = analyzer.analyzeDocument({uri:'file:///highlight-performance.axl',version:1,text});
      const workspaceIndex = {};
      const input = {analysis,workspaceIndex,position:{line:0,character:4}};
      assert.strictEqual(runAnalysisSteps(getDocumentHighlightsSteps(input)).length,count+1);
      for (let i=0; i<2; i++) {
        assert.strictEqual(runAnalysisSteps(getDocumentHighlightsSteps(input)).length,count+1);
      }
      const edited = analyzer.analyzeDocument({uri:analysis.uri,version:2,text:text.replace('int value = 0;','int value = 1;')});
      assert.strictEqual(runAnalysisSteps(getDocumentHighlightsSteps({...input,analysis:edited})).length,count+1);
    });
  }

  test('cancels in-flight collection without caching a partial result', async () => {
    const analysis = new DocumentAnalyzer().analyzeDocument({uri:'file:///highlight-cancel.axl',version:1,
      text:`int value; void main() { ${'value++;'.repeat(5000)} }`});
    const input = {analysis,workspaceIndex:{},position:{line:0,character:4}};
    const token = new CancellationTokenSource();
    const pending = runAnalysisStepsAsync(getDocumentHighlightsSteps(input),token.token);
    setImmediate(()=>token.cancel());
    await assert.rejects(pending,(error: unknown)=>error instanceof ResponseError && error.code === LSPErrorCodes.RequestCancelled);
    token.dispose();
    assert.strictEqual(runAnalysisSteps(getDocumentHighlightsSteps(input)).length,5001);
  });
});
