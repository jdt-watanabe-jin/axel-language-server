import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';
import { WorkspaceIndex } from '../../../analyzer/workspaceIndex';
import type { AnalyzeDocumentInput, AnalyzedDocument } from '../../../types/analysis';
import { useWorkspaceFixtures } from '../../support/workspace';
const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
function request(index: WorkspaceIndex, input: AnalyzeDocumentInput, token = CancellationToken.None): Promise<AnalyzedDocument> {
  return index.analyzeRequestDocument(input, token);
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
suite('cooperative request analysis', function () {
  this.timeout(15000);
  function fixture() {
    const root = createTempDir();
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(root, 'header' + i + '.h'),
        (i < 11 ? '#include "header' + (i + 1) + '.h"\n' : '') + 'int value' + i + ';');
    }
    const input = { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1,
      text: '#include "header0.h"\nint main(){ return value11; }' };
    return { root, input, index: createWorkspaceIndex() };
  }
  test('yields while dependencies are incomplete and preserves synchronous results', async () => {
    const { input, index } = fixture();
    let settled = false;
    const pending = request(index, input).then(value => { settled = true; return value; });
    await tick();
    assert.strictEqual(settled, false, 'analysis must give the transport an opportunity to run');
    const result = await pending;
    const expected = createWorkspaceIndex().indexOpenDocument(input);
    assert.deepStrictEqual(result, expected);
    assert.ok(index.findVisibleDeclarations(input.uri, 'value11').length);
  });
  test('cancels an in-flight include traversal and can retry without partial cache results', async () => {
    const { input, index } = fixture();
    const source = new CancellationTokenSource();
    const pending = request(index, input, source.token);
    const rejected = assert.rejects(pending, (e: unknown) => e instanceof ResponseError && e.code === LSPErrorCodes.RequestCancelled);
    for (let turns = 0; !index.getAnalyzedDocument(input.uri); turns++) {
      assert.ok(turns < 1000, 'request must enter include traversal');
      await tick();
    }
    source.cancel();
    await rejected;
    const result = await request(index, input);
    assert.deepStrictEqual(result, createWorkspaceIndex().indexOpenDocument(input));
    source.dispose();
  });
  for (const change of ['edit', 'configure', 'close', 'dependency']) {
    test('discards suspended work after ' + change, async () => {
      const { root, input, index } = fixture();
      const pending = request(index, input);
      const rejected = assert.rejects(pending, (e: unknown) => e instanceof ResponseError && e.code === LSPErrorCodes.ContentModified);
      await tick();
      if (change === 'edit') { index.analyzeForegroundDocument({ ...input, version: 2, text: 'string latest;' }); }
      if (change === 'configure') { index.configure({ defines: ['UPDATED'] }); }
      if (change === 'close') { index.deleteDocument(input.uri); }
      if (change === 'dependency') { index.invalidateFile(path.join(root, 'header0.h')); }
      await rejected;
      const next = await request(index, { ...input, version: 3, text: 'string latest;' });
      assert.ok(next.declarations.some(d => d.name === 'latest'));
      assert.ok(!next.declarations.some(d => d.name === 'main'));
    });
  }
  test('an open forced include does not re-enter synchronous forced indexing during a request', async () => {
    const root = createTempDir();
    const header = path.join(root, 'forced.h');
    fs.writeFileSync(header, 'int shared;');
    const index = createWorkspaceIndex({ forcedIncludeFiles: [header] });
    index.analyzeForegroundDocument({ uri: pathToFileURL(header).toString(), version: 1, text: 'int shared;' });
    const syncIndex = index.indexForcedIncludes.bind(index);
    let synchronousEntries = 0;
    index.indexForcedIncludes = () => { synchronousEntries++; return syncIndex(); };
    const result = await request(index, { uri: pathToFileURL(path.join(root, 'main.axl')).toString(), version: 1,
      text: 'void main(){ shared = 1; }' });
    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(synchronousEntries, 0, 'a cooperative request must not restart forced indexing synchronously');
  });

  test('cancelling one request retains unrelated open documents in reference searches', async () => {
    const { input, index } = fixture();
    const other = { uri: 'file:///unrelated.axl', version: 1, text: 'int unrelated;' };
    index.indexOpenDocument(other);
    const source = new CancellationTokenSource();
    const pending = request(index, input, source.token);
    const rejected = assert.rejects(pending, (e: unknown) => (e as { code?: number }).code === LSPErrorCodes.RequestCancelled);
    await tick(); source.cancel(); await rejected;
    await request(index, { ...input, version: 2, text: 'int updated;' });
    assert.ok(index.listReferenceSearchDocuments(input.uri).some(document => document.uri === other.uri));
    source.dispose();
  });

});
