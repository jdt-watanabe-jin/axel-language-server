import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, CancellationTokenSource, type TextDocumentEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { FileRenameIndex } from '../../../analyzer/fileOperations';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('file rename includes', () => {
  const fixtures = useWorkspaceFixtures();
  function fixture() {
    const root = fs.realpathSync.native(fixtures.createTempDir());
    const uri = (name: string) => pathToFileURL(path.join(root, name)).toString();
    const write = (name: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };
    let open: TextDocument[] = [];
    const logs: string[] = [];
    const index = new FileRenameIndex(() => open, message => logs.push(message));
    index.configure([uri('')], {});
    const move = (oldName: string, newName: string) => ({ oldUri: uri(oldName), newUri: uri(newName) });
    const rename = async (...files: ReturnType<typeof move>[]) => {
      const result = await index.getEdits(files, CancellationToken.None);
      return result?.documentChanges as TextDocumentEdit[] | undefined;
    };
    return { root, uri, write, index, move, rename, logs, setOpen: (documents: TextDocument[]) => { open = documents; } };
  }
  test('rewrites unopened literal includes, including inactive and wide strings', async () => {
    const f = fixture();
    f.write('old.h', 'int value;');
    f.write('main.axl', '#include "old.h" // keep\n#if 0\n#include L"old.h"\n#endif\n');
    const changes = await f.rename(f.move('old.h', 'new.h'));
    assert.strictEqual(changes?.length, 1, JSON.stringify(f.logs));
    assert.strictEqual(changes![0].textDocument.uri, f.uri('main.axl'));
    assert.deepStrictEqual(changes![0].edits.map(edit => edit.newText), ['new.h', 'new.h']);
  });
  test('uses unsaved contents and old URI/version when moving the source', async () => {
    const f = fixture(); f.write('api.h', 'int value;'); f.write('main.axl', '');
    f.setOpen([TextDocument.create(f.uri('main.axl'), 'axel', 7, '#include "api.h"\n')]);
    const changes = await f.rename(f.move('main.axl', 'nested/deeper/main.axl'));
    assert.deepStrictEqual(changes![0].textDocument, { uri: f.uri('main.axl'), version: 7 });
    assert.strictEqual(changes![0].edits[0].newText, '../../api.h');
  });
  test('moves folders atomically and leaves internal relative paths unchanged', async () => {
    const f = fixture(); f.write('lib/api.h', ''); f.write('lib/internal.axl', '#include "api.h"\n');
    f.write('main.axl', '#include "lib/api.h"\n');
    const changes = await f.rename(f.move('lib', 'renamed'));
    assert.strictEqual(changes!.length, 1); assert.strictEqual(changes![0].edits[0].newText, 'renamed/api.h');
  });
  test('verifies search precedence and edits only the resolved target', async () => {
    const f = fixture(); f.write('one/api.h', ''); f.write('two/api.h', ''); f.write('main.axl', '#include <api.h>\n');
    f.index.configure([f.uri('')], { includeRoots: [path.join(f.root, 'one'), path.join(f.root, 'two')] });
    assert.strictEqual(await f.rename(f.move('two/api.h', 'two/other.h')), undefined);
    const changes = await f.rename(f.move('one/api.h', 'one/new.h'));
    assert.strictEqual(changes![0].edits[0].newText, 'new.h');
  });
  test('honors exclusion and disabling without editing macros or comments', async () => {
    const f = fixture(); f.write('api.h', ''); f.write('main.axl', '#define HEADER "api.h"\n#include HEADER\n// #include "api.h"');
    assert.strictEqual(await f.rename(f.move('api.h', 'new.h')), undefined);
    f.write('main.axl', '#include "api.h"\n');
    f.index.configure([f.uri('')], { project: { exclude: ['main.axl'] } });
    assert.strictEqual(await f.rename(f.move('api.h', 'new.h')), undefined);
    f.index.configure([f.uri('')], { fileOperations: { updateIncludesOnRename: false } });
    assert.strictEqual(await f.rename(f.move('api.h', 'new.h')), undefined);
  });
  test('requires source membership before and after a move while allowing excluded targets', async () => {
    const f = fixture(); f.write('api.h', ''); f.write('src/main.axl', '#include "../api.h"\n');
    f.index.configure([f.uri('')], { project: { include: ['src'], exclude: [] } });
    assert.strictEqual(await f.rename(f.move('src/main.axl', 'outside/deep/deeper/main.axl')), undefined);
    const changes = await f.rename(f.move('api.h', 'new.h'));
    assert.strictEqual(changes?.[0].edits[0].newText, '../new.h');
    f.index.configure([f.uri('')], { project: { include: [], exclude: [] } });
    assert.strictEqual(await f.rename(f.move('api.h', 'new.h')), undefined);
  });
  test('checks the future filename for folderless open-source renames', async () => {
    const f = fixture(); f.write('api.h', ''); f.write('main.axl', '#include "api.h"\n');
    f.setOpen([TextDocument.create(f.uri('main.axl'), 'axel', 1, '#include "api.h"\n')]);
    f.index.configure([], { project: { include: ['*.axl'], exclude: ['excluded.axl'] } });
    const changes = await f.rename(f.move('main.axl', 'deep/nested/new.axl'));
    assert.strictEqual(changes?.[0].edits[0].newText, '../../api.h');
    assert.strictEqual(await f.rename(f.move('main.axl', 'deep/nested/excluded.axl')), undefined);
  });
  test('cancellation never returns partial edits', async () => {
    const f = fixture(); f.write('api.h', ''); f.write('main.axl', '#include "api.h"');
    const source = new CancellationTokenSource(); source.cancel();
    await assert.rejects(f.index.getEdits([f.move('api.h', 'new.h')], source.token), { code: -32800 });
    source.dispose();
  });
  test('updates case-only renames and preserves non-ASCII source offsets', async () => {
    const f = fixture(); f.write('api.h', ''); f.write('main.axl', '// 日本語😀\n#include "api.h"\n');
    const changes = await f.rename(f.move('api.h', 'API.h'));
    assert.strictEqual(changes![0].edits[0].newText, 'API.h');
    const document = TextDocument.create(f.uri('main.axl'), 'axel', 0, '// 日本語😀\n#include "api.h"\n');
    assert.strictEqual(TextDocument.applyEdits(document, changes![0].edits), '// 日本語😀\n#include "API.h"\n');
  });
  test('treats a multi-file rename as one mapping', async () => {
    const f = fixture(); f.write('a.h', ''); f.write('b.h', ''); f.write('main.axl', '#include "a.h"\n#include "b.h"\n');
    const changes = await f.rename(f.move('a.h', 'b.h'), f.move('b.h', 'c.h'));
    assert.deepStrictEqual(changes![0].edits.map(edit => edit.newText), ['b.h', 'c.h']);
  });
  test('returns no partial edits on deadline or incomplete enumeration', async () => {
    const f = fixture(); f.write('api.h', ''); f.write('main.axl', '#include "api.h"\n');
    assert.strictEqual(await f.index.getEdits([f.move('api.h', 'new.h')], CancellationToken.None, 0), null);
    f.index.configure([f.uri(''), f.uri('missing-root')], {});
    assert.strictEqual(await f.rename(f.move('api.h', 'new.h')), undefined);
    assert.ok(f.logs.length);
  });
});
