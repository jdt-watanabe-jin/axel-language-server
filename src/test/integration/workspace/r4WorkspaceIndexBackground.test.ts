import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver/node';
import type { WorkspaceIndex } from '../../../analyzer/workspaceIndex';
import { useWorkspaceFixtures } from '../../support/workspace';
const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
type ObservableIndex = WorkspaceIndex & {
  onBackgroundIndexingActivity(listener: (active: boolean) => void): () => void;
  cancelBackgroundIndexing(): void;
};
suite('R4 workspace index background activity', () => {
  function fixture() {
    const root = createTempDir(); const header = path.join(root, 'header.h');
    fs.writeFileSync(header, 'int dependency;');
    const index = createWorkspaceIndex({ forcedIncludeFiles: [header] }) as ObservableIndex;
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1, text: 'int main(){ return dependency; }' };
    return { index, input, header };
  }
  test('reports one active and one inactive event for an entire dependency scan', async () => {
    const { index, input } = fixture(); const activity: boolean[] = [];
    assert.strictEqual(typeof index.onBackgroundIndexingActivity, 'function');
    const unsubscribe = index.onBackgroundIndexingActivity(active => activity.push(active));
    index.analyzeForegroundDocument(input); await index.waitForBackgroundIndexing();
    assert.deepStrictEqual(activity, [true, false]); unsubscribe();
  });
  test('cancellation removes provisional dependencies, stops scanning and permits foreground recovery', async () => {
    const { index, input, header } = fixture();
    assert.strictEqual(typeof index.cancelBackgroundIndexing, 'function');
    index.analyzeForegroundDocument(input);
    for (let i = 0; !index.getAnalyzedDocument(pathToFileURL(header).toString()); i++) {
      assert.ok(i < 100); await new Promise<void>(resolve => setImmediate(resolve));
    }
    index.cancelBackgroundIndexing(); await index.waitForBackgroundIndexing();
    assert.strictEqual(index.getAnalyzedDocument(pathToFileURL(header).toString()), undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.strictEqual(index.getAnalyzedDocument(pathToFileURL(header).toString()), undefined);
    assert.deepStrictEqual((await index.analyzeRequestDocument(input, CancellationToken.None)).diagnostics, []);
  });
  test('cancelling queued background work leaves an active foreground request intact', async () => {
    const { index, input } = fixture();
    assert.strictEqual(typeof index.cancelBackgroundIndexing, 'function');
    index.analyzeForegroundDocument(input);
    const pending = index.analyzeRequestDocument(input, CancellationToken.None);
    await new Promise<void>(resolve => setImmediate(resolve));
    index.cancelBackgroundIndexing();
    assert.deepStrictEqual((await pending).diagnostics, []);
  });
  test('observes initial login indexing and cancellation without publishing a partial login snapshot', async () => {
    const root = createTempDir(); fs.mkdirSync(path.join(root, 'bin'));
    const login = path.join(root, 'bin', '_login.axl');
    fs.writeFileSync(login, 'int startupValue;');
    const index = createWorkspaceIndex({ sxmHome: root }) as ObservableIndex;
    const activity: boolean[] = [];
    index.onBackgroundIndexingActivity(active => activity.push(active));
    index.getLoginDependencies(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    index.cancelBackgroundIndexing(); await index.waitForBackgroundIndexing();
    assert.deepStrictEqual(activity, [true, false]);
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1, text: 'int main(){ return startupValue; }' };
    assert.deepStrictEqual((await index.analyzeRequestDocument(input, CancellationToken.None)).diagnostics, []);
    assert.strictEqual(index.findVisibleDeclarations(input.uri, 'startupValue').length, 1);
  });
  test('resumes activity after analysis is disabled and reenabled before the next turn', async () => {
    const { index, input } = fixture(); const activity: boolean[] = [];
    index.onBackgroundIndexingActivity(active => activity.push(active));
    index.analyzeForegroundDocument(input);
    index.setAnalysisEnabled(false); index.setAnalysisEnabled(true);
    await index.waitForBackgroundIndexing();
    assert.deepStrictEqual(activity, [true, false, true, false]);
  });

  test('a restarted stale job cannot retain provisional declarations after cancellation', async () => {
    const { index, input, header } = fixture();
    const headerUri = pathToFileURL(header).toString();
    index.analyzeForegroundDocument(input);
    for (let i = 0; !index.getAnalyzedDocument(headerUri); i++) {
      assert.ok(i < 100); await new Promise<void>(resolve => setImmediate(resolve));
    }
    index.invalidateUri(pathToFileURL(path.join(path.dirname(header), 'unrelated.axl')).toString());
    await new Promise<void>(resolve => setImmediate(resolve));
    index.cancelBackgroundIndexing(); await index.waitForBackgroundIndexing();
    assert.strictEqual(index.getAnalyzedDocument(headerUri), undefined);
    assert.deepStrictEqual(index.findDeclarations('dependency'), []);
    assert.deepStrictEqual((await index.analyzeRequestDocument(input, CancellationToken.None)).diagnostics, []);
  });

});
