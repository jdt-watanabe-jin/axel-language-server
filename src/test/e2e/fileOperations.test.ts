import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { InitializeResult, DocumentDiagnosticReport, WorkspaceEdit, TextDocumentEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { useWorkspaceFixtures } from '../support/workspace';
import { startLspServer } from '../support/lspClient';

suite('LSP file operations', function () {
  this.timeout(20000);
  const fixtures = useWorkspaceFixtures();
  test('returns edits on pre-rename URIs and refreshes definitions after the operation', async () => {
    const root = fs.realpathSync.native(fixtures.createTempDir());
    const uri = (name: string) => pathToFileURL(path.join(root, name)).toString();
    fs.writeFileSync(path.join(root, 'api.h'), 'int value;');
    const source = '#include "api.h"\nvoid main(){ value; }';
    fs.writeFileSync(path.join(root, 'main.axl'), source);
    const server = startLspServer();
    try {
      await server.request('initialize', { rootUri: uri(''), processId: null,
        capabilities: { workspace: { workspaceEdit: { documentChanges: true }, fileOperations: { willRename: true, didRename: true } } } });
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: { uri: uri('main.axl'), version: 4, languageId: 'axel', text: source } });
      const files = [{ oldUri: uri('api.h'), newUri: uri('renamed.h') }];
      const result = await server.request<WorkspaceEdit>('workspace/willRenameFiles', { files });
      const edit = result.documentChanges![0] as TextDocumentEdit;
      assert.deepStrictEqual(edit.textDocument, { uri: uri('main.axl'), version: 4 });
      const text = TextDocument.applyEdits(TextDocument.create(uri('main.axl'), 'axel', 4, source), edit.edits);
      assert.ok(text.includes('"renamed.h"'));
      await server.notify('textDocument/didChange', { textDocument: { uri: uri('main.axl'), version: 5 }, contentChanges: [{ text }] });
      fs.renameSync(path.join(root, 'api.h'), path.join(root, 'renamed.h'));
      await server.notify('workspace/didRenameFiles', { files });
      const definitions = await server.request<{ uri: string }[]>('textDocument/definition', { textDocument: { uri: uri('main.axl') }, position: { line: 1, character: 14 } });
      assert.ok(definitions.some(item => item.uri === uri('renamed.h')), JSON.stringify(definitions));
    } finally { await server.stop(); }
  });
  test('advertises supported operations and handles creation and deletion without watchers', async () => {
    const root = fixtures.createTempDir();
    const uri = (name: string) => pathToFileURL(path.join(root, name)).toString();
    const server = startLspServer();
    try {
      const result = await server.request<InitializeResult>('initialize', { rootUri: uri(''), processId: null,
        capabilities: { workspace: { fileOperations: { willCreate: true, didCreate: true, willRename: true,
          didRename: true, willDelete: true, didDelete: true } } } });
      assert.ok(result.capabilities.workspace?.fileOperations?.willRename);
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: { uri: uri('main.axl'), languageId: 'axel', version: 1,
        text: '#include "lib/api.h"\nvoid main() {}' } });
      const diagnostics = async () => {
        const report = await server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument: { uri: uri('main.axl') } });
        assert.strictEqual(report.kind, 'full'); return report.kind === 'full' ? report.items : [];
      };
      assert.ok((await diagnostics()).length);
      assert.strictEqual(await server.request('workspace/willCreateFiles', { files: [{ uri: uri('lib/api.h') }] }), null);
      fs.mkdirSync(path.join(root, 'lib')); fs.writeFileSync(path.join(root, 'lib/api.h'), 'int value;');
      await server.notify('workspace/didCreateFiles', { files: [{ uri: uri('lib') }] });
      assert.deepStrictEqual(await diagnostics(), []);
      assert.strictEqual(await server.request('workspace/willDeleteFiles', { files: [{ uri: uri('lib') }] }), null);
      fs.unlinkSync(path.join(root, 'lib/api.h')); fs.rmdirSync(path.join(root, 'lib'));
      await server.notify('workspace/didDeleteFiles', { files: [{ uri: uri('lib') }] });
      assert.ok((await diagnostics()).length);
    } finally { await server.stop(); }
  });
});
