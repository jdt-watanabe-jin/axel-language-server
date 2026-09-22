import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, CancellationTokenSource } from 'vscode-languageserver/node';
import { getInlayHints } from '../../../analyzer/inlayHints';
import { getHover } from '../../../analyzer/hover';
import { getDefinitions, getReferences } from '../../../analyzer/navigation';
import { getRenameEdits } from '../../../analyzer/rename';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('unchanged dependency opens', () => {
  const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
  test('defers semantic diagnostics until a diagnostic request without losing later errors', async () => {
    const index = createWorkspaceIndex();
    const input = { uri: 'file:///hover-only.axl', version: 1, text: 'void main() { missing = 1; }' };
    const interactive = await index.analyzeRequestDocument(input, CancellationToken.None, false);
    assert.ok(!interactive.diagnostics.some(item => item.message.includes('missing')));
    const diagnostic = await index.analyzeRequestDocument(input, CancellationToken.None);
    assert.ok(diagnostic.diagnostics.some(item => item.message.includes('missing')));
  });
  for (const close of ['unchanged', 'unsaved', 'disk-changed']) {
    test('preserves dependency updates when closing a ' + close + ' editor view', async () => {
      const root = createTempDir();
      const header = path.join(root, 'api.h');
      const text = 'void consume(int count);';
      fs.writeFileSync(header, text);
      const index = createWorkspaceIndex({ forcedIncludeFiles: [header] });
      const source = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1,
        text: 'void main() { consume(1); }' };
      const labels = async () => {
        const analysis = await index.analyzeRequestDocument(source, CancellationToken.None);
        return getInlayHints({ analysis, text: source.text, workspaceIndex: index,
          range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
          suppressWhenArgumentContainsName: false }).map(hint => hint.label);
      };
      assert.deepStrictEqual(await labels(), ['count:']);
      const uri = pathToFileURL(header).toString().replace('api.h', '%61pi.h');
      assert.ok(index.tryReuseOpenDocument({ uri, version: 1, text }));
      if (close === 'unsaved') {
        await index.analyzeForegroundDocumentAsync({ uri, version: 2, text: 'void consume(int edited);' }, CancellationToken.None);
        assert.deepStrictEqual(await labels(), ['edited:']);
      }
      if (close === 'disk-changed') { fs.writeFileSync(header, 'void consume(int disk);'); }
      const reused = index.tryCloseUnchangedDocument(uri);
      assert.strictEqual(reused, close === 'unchanged');
      if (!reused) { index.deleteDocument(uri); }
      assert.deepStrictEqual(await labels(), [close === 'disk-changed' ? 'disk:' : 'count:']);
    });
  }

  test('does not reuse a previous configuration or changed initial buffer', async () => {
    const root = createTempDir();
    const header = path.join(root, 'api.h');
    const text = '#ifdef NEW_API\nvoid consume(int next);\n#else\nvoid consume(int old);\n#endif';
    fs.writeFileSync(header, text);
    const index = createWorkspaceIndex({ forcedIncludeFiles: [header] });
    const source = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1, text: 'void main(){consume(1);}' };
    await index.analyzeRequestDocument(source, CancellationToken.None);
    const uri = pathToFileURL(header).toString();
    assert.strictEqual(index.tryReuseOpenDocument({ uri, version: 1, text: 'void consume(int different);' }), false);
    index.configure({ forcedIncludeFiles: [header], defines: ['NEW_API=1'] });
    assert.strictEqual(index.tryReuseOpenDocument({ uri, version: 1, text }), false);
    const analysis = await index.analyzeRequestDocument({ uri, version: 1, text }, CancellationToken.None);
    assert.ok(analysis.declarations.some(value => value.name === 'next'));
    assert.ok(!analysis.declarations.some(value => value.name === 'old'));
  });

  for (const alias of [true]) {
    test('reuses parsed declarations on open and hover, alias=' + alias, async () => {
      const root = createTempDir();
      const header = path.join(root, 'api.h');
      const text = '#ifndef API_H\n#define API_H\n/** @param count number of items */\nvoid consume(int count);\nvoid wrapper() { consume(2); }\n#endif';
      fs.writeFileSync(header, text);
      const timings: string[] = [];
      const index = createWorkspaceIndex({ forcedIncludeFiles: [header], logger: {
        info() {}, error(message) { assert.fail(message); }, timing(message) { timings.push(message); }
      } });
      const source = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1,
        text: 'void main() { consume(1); }' };
      const original = await index.analyzeRequestDocument(source, CancellationToken.None);
      await index.waitForBackgroundIndexing();
      const uri = alias ? pathToFileURL(header).toString().replace('api.h', '%61pi.h') : pathToFileURL(header).toString();
      const input = { uri, version: 7, text };
      timings.length = 0;
      await index.analyzeForegroundDocumentAsync(input, CancellationToken.None);
      const analysis = await index.analyzeRequestDocument(input, CancellationToken.None);
      const position = { line: 3, character: 17 };
      assert.match(getHover({ analysis, position, workspaceIndex: index })?.plainText ?? '', /int count/);
      assert.deepStrictEqual(getDefinitions({ analysis, position, workspaceIndex: index }), [{ uri,
        range: { start: position, end: { line: 3, character: 22 } } }]);
      const navigation = { analysis, position: { line: 3, character: 6 }, workspaceIndex: index };
      const references = getReferences({ ...navigation, includeDeclaration: false });
      assert.strictEqual(references.length, 2);
      assert.ok(references.some(location => location.uri === source.uri));
      const edits = getRenameEdits({ ...navigation, newName: 'consumeMore' });
      assert.ok('changes' in edits);
      if ('changes' in edits) {
        assert.deepStrictEqual(Object.keys(edits.changes).sort(), [uri, source.uri].sort());
        assert.strictEqual(edits.changes[uri].length, 2);
      }
      const callerEdits = getRenameEdits({ analysis: original, position: { line: 0, character: 15 },
        workspaceIndex: index, newName: 'consumeMore' });
      assert.ok('changes' in callerEdits);
      if ('changes' in callerEdits) {
        assert.deepStrictEqual(Object.keys(callerEdits.changes).sort(), [uri, source.uri].sort());
        assert.strictEqual(callerEdits.changes[uri].length, 2);
      }
      const cancellation = new CancellationTokenSource();
      const cancelled = index.analyzeRequestDocument(input, cancellation.token, false);
      setImmediate(() => cancellation.cancel());
      await assert.rejects(cancelled, (error: unknown) => (error as { code: number }).code === -32800);
      cancellation.dispose();
      assert.ok(index.tryCloseUnchangedDocument(uri));
      assert.strictEqual(await index.analyzeRequestDocument(source, CancellationToken.None), original);
      assert.strictEqual(timings.filter(line => line.includes('operation=document.analyze ')).length, 0);
    });
  }
});
