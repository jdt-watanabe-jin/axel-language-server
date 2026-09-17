import * as assert from 'assert';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import * as formatting from '../../../analyzer/formatting';
import * as navigation from '../../../analyzer/navigation';
import * as rename from '../../../analyzer/rename';
import { WorkspaceIndex } from '../../../analyzer/workspaceIndex';
import { runAnalysisStepsAsync } from '../../../util/analysisSteps';

suite('cooperative LSP features', () => {
  for (const feature of ['formatting', 'references', 'rename']) {
    test(feature + ' can cancel during result construction without changing subsequent results', async () => {
      const text = 'int value;\nvoid main() {\n' + 'value = 1;\n'.repeat(300) + '}';
      const index = new WorkspaceIndex();
      const analysis = index.indexOpenDocument({ uri: 'file:///cooperative.axl', version: 1, text });
      const source = new CancellationTokenSource();
      const run = (token: CancellationToken) => {
        if (feature === 'formatting') { return runAnalysisStepsAsync(formatting.getFormattingEditsSteps(
          { text, options: { insertSpaces: true, tabSize: 2 } }), token); }
        const input = { analysis, position: { line: 0, character: 5 }, workspaceIndex: index };
        return feature === 'references' ? runAnalysisStepsAsync(navigation.getReferencesSteps(
          { ...input, includeDeclaration: true }), token) : runAnalysisStepsAsync(rename.getRenameEditsSteps(
          { ...input, newName: 'renamed' }), token);
      };
      const pending = run(source.token);
      setImmediate(() => source.cancel());
      await assert.rejects(pending, (e: unknown) => (e as { code?: number }).code === LSPErrorCodes.RequestCancelled);
      const result = await run(CancellationToken.None);
      if (feature === 'rename') {
        assert.strictEqual(Object.values((result as { changes: Record<string, unknown[]> }).changes).flat().length, 301);
      } else { assert.strictEqual((result as unknown[]).length, feature === 'references' ? 301 : 300); }
      source.dispose();
    });
  }
});
