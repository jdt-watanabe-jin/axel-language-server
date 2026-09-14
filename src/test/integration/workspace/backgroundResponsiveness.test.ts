import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { collectSemanticTokens } from '../../../analyzer/semanticTokens';
import { useWorkspaceFixtures } from '../../support/workspace';
const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();

suite('background dependency responsiveness', () => {
  for (const openDependency of [false, true]) {
    test('yields during a forced include chain (open dependency=' + openDependency + ')', async () => {
      const root = createTempDir();
      let parsed = 0;
      const analyzer = new DocumentAnalyzer(undefined, { info() {}, error(message) { assert.fail(message); },
        timing(message) { if (message.includes('operation=document.analyze')) { parsed++; } } });
      for (let i = 0; i < 20; i++) {
        fs.writeFileSync(path.join(root, 'header' + i + '.h'),
          (i < 19 ? '#include "header' + (i + 1) + '.h"\n' : '') + '#define FLAG' + i + ' 1\nint value' + i + ';');
      }
      const options = { forcedIncludeFiles: [path.join(root, 'header0.h')] };
      const index = createWorkspaceIndex({ ...options, analyzer });
      const input = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1,
        text: 'int main(){ return value19; }' };
      index.analyzeForegroundDocument(input);
      if (openDependency) {
        index.analyzeForegroundDocument({ uri: pathToFileURL(options.forcedIncludeFiles[0]).toString(), version: 1,
          text: fs.readFileSync(options.forcedIncludeFiles[0], 'utf8') });
      }
      parsed = 0;
      let complete = false;
      let maxAnalysesPerTurn = 0;
      const settled = index.waitForBackgroundIndexing().then(() => { complete = true; });
      while (!complete) {
        const before = parsed;
        await new Promise<void>(resolve => setImmediate(resolve));
        maxAnalysesPerTurn = Math.max(maxAnalysesPerTurn, parsed - before);
      }
      await settled;
      assert.ok(maxAnalysesPerTurn < 20, 'one event-loop turn analyzed ' + maxAnalysesPerTurn + ' documents');
      const actual = index.analyzeDiagnosticDocument(input);
      const expectedIndex = createWorkspaceIndex(options);
      const expected = expectedIndex.indexOpenDocument(input);
      assert.deepStrictEqual(actual.diagnostics, expected.diagnostics);
      assert.deepStrictEqual(collectSemanticTokens(actual, index.semanticTokenWorkspaceIndex(input.uri)),
        collectSemanticTokens(expected, expectedIndex.semanticTokenWorkspaceIndex(input.uri)));
      assert.ok(index.findDeclarations('value19').length > 0);
    });
  }

  test('discards a suspended analysis when a dependency changes', async () => {
    const root = createTempDir();
    const header = path.join(root, 'library.h');
    const leaf = path.join(root, 'leaf.h');
    fs.writeFileSync(header, '#include "leaf.h"\n#define FLAG 1');
    fs.writeFileSync(leaf, 'int answer;');
    const options = { forcedIncludeFiles: [header] };
    const index = createWorkspaceIndex(options);
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1,
      text: 'int main(){ return answer; }' };
    index.analyzeForegroundDocument(input);
    const leafUri = pathToFileURL(leaf).toString();
    for (let attempts = 0; !index.getAnalyzedDocument(leafUri); attempts++) {
      assert.ok(attempts < 100, 'dependency must be discovered');
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    fs.writeFileSync(leaf, 'int renamedAnswer;');
    index.invalidateFile(leaf);
    await index.waitForBackgroundIndexing();
    const expected = createWorkspaceIndex(options).indexOpenDocument(input);
    assert.deepStrictEqual(index.analyzeDiagnosticDocument(input).diagnostics, expected.diagnostics);
    assert.ok(expected.diagnostics.length > 0, 'removed identifier must be diagnosed');
  });

  test('uses unsaved header edits received while indexing is suspended', async () => {
    const root = createTempDir();
    const header = path.join(root, 'library.h');
    fs.writeFileSync(header, 'int answer;');
    const options = { forcedIncludeFiles: [header] };
    const index = createWorkspaceIndex(options);
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1,
      text: 'int main(){ return answer; }' };
    index.analyzeForegroundDocument(input);
    await new Promise<void>(resolve => setImmediate(resolve));
    const edited = { uri: pathToFileURL(header).toString(), version: 2, text: 'string answer;' };
    index.analyzeForegroundDocument(edited);
    await index.waitForBackgroundIndexing();
    const expectedIndex = createWorkspaceIndex(options);
    expectedIndex.indexOpenDocument(edited);
    assert.deepStrictEqual(index.analyzeDiagnosticDocument(input).diagnostics,
      expectedIndex.indexOpenDocument(input).diagnostics);
    assert.strictEqual(index.getAnalyzedDocument(edited.uri)?.version, 2);
  });

  test('settles existing waiters after configuration replaces a suspended job', async () => {
    const root = createTempDir();
    const oldHeader = path.join(root, 'old.h');
    fs.writeFileSync(oldHeader, '#if __OS_WINDOWS__\nint oldValue;\n#else\nint newValue;\n#endif');
    const index = createWorkspaceIndex({ forcedIncludeFiles: [oldHeader], targetPlatform: 'windows-x64' });
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1,
      text: 'int main(){ return newValue; }' };
    let completions = 0;
    index.onBackgroundIndexingComplete(() => completions++);
    index.analyzeForegroundDocument(input);
    const pending = index.waitForBackgroundIndexing();
    await new Promise<void>(resolve => setImmediate(resolve));
    index.configure({ targetPlatform: 'linux-x86' });
    index.analyzeForegroundDocument(input);
    await pending;
    assert.deepStrictEqual(index.analyzeDiagnosticDocument(input).diagnostics, []);
    assert.deepStrictEqual(index.findDeclarations('oldValue'), []);
    assert.strictEqual(completions, 1);
  });

});
