import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { WorkspaceIndex } from '../../../analyzer/workspaceIndex';
import { ProjectScope } from '../../../analyzer/projectScope';
import { useWorkspaceFixtures } from '../../support/workspace';
const { createTempDir } = useWorkspaceFixtures();
suite('Project scope', () => {
  test('cancels even empty collections and never traverses open junction aliases', async () => {
    const scope = new ProjectScope(); const source = new CancellationTokenSource(); source.cancel();
    await assert.rejects(scope.collect(source.token), { code: LSPErrorCodes.RequestCancelled }); source.dispose();
    const root = createTempDir(); const outside = createTempDir();
    fs.writeFileSync(path.join(outside, 'external.axl'), '');
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    const uri = pathToFileURL(path.join(root, 'link/external.axl')).toString();
    scope.setRoots([pathToFileURL(root).toString()]);
    assert.strictEqual(scope.contains(uri), false);
    assert.strictEqual((await scope.collect(CancellationToken.None, [uri])).size, 0);
  });
  test('retains excluded dependencies while filtering unrelated horizontal candidates', () => {
    const root = createTempDir();
    const uri = (name: string) => pathToFileURL(path.join(root, name)).toString();
    fs.writeFileSync(path.join(root, 'base.h'), 'class Base { int field; };');
    const scope = new ProjectScope(); scope.setRoots([uri('')]); scope.configure({ include: ['main.axl'], exclude: [] });
    const index = new WorkspaceIndex();
    index.setProjectScope(scope);
    index.analyzeDocument({ uri: uri('main.axl'), version: 1, text: '#include "base.h"\nBase value;' });
    index.analyzeDocument({ uri: uri('excluded.axl'), version: 1, text: 'int unrelated;' });
    assert.ok(index.listVisibleDocuments(uri('main.axl')).some(doc => doc.uri === uri('base.h')));
    const searched = index.listReferenceSearchDocuments(uri('main.axl')).map(doc => doc.uri);
    assert.ok(searched.includes(uri('base.h')));
    assert.ok(!searched.includes(uri('excluded.axl')));
    assert.ok(index.getAnalyzedDocument(uri('excluded.axl')), 'open excluded documents retain analysis');
  });
  test('selects files consistently across overlapping roots and open excluded buffers', async () => {
    const root = createTempDir();
    const uri = (name: string) => pathToFileURL(path.join(root, name)).toString();
    for (const name of ['src/main.AXL', 'src/deep/a.hh', 'src/generated/a.h', '.git/a.h', 'other/a.h']) {
      const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '');
    }
    const scope = new ProjectScope((message: string) => assert.fail(message));
    scope.setRoots([uri('')]); scope.configure({ include: ['src'], exclude: ['**/generated'] });
    assert.strictEqual(scope.contains(uri('src/main.AXL')), true);
    assert.strictEqual(scope.contains(uri('other/a.h')), false);
    let files = await scope.collect(CancellationToken.None, [uri('src/generated/a.h')]);
    assert.strictEqual(files.size, 2);
    const revision = scope.revision;
    scope.configure({ include: [], exclude: [] });
    assert.ok(scope.revision > revision);
    assert.strictEqual((await scope.collect(CancellationToken.None, [uri('src/main.AXL')])).size, 0);
    scope.configure({ include: ['a.h'], exclude: [] }); scope.setRoots([uri(''), uri('other')]);
    assert.strictEqual((await scope.collect(CancellationToken.None)).size, 1);
    scope.setRoots([]); scope.configure({ include: ['**/*'], exclude: [] });
    files = await scope.collect(CancellationToken.None, [uri('src/main.AXL')]);
    assert.strictEqual(files.size, 1);
    assert.strictEqual(scope.contains(uri('other/a.h')), false, 'folderless candidates must be open');
  });
});
