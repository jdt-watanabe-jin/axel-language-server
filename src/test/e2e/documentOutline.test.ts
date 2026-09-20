import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { DocumentSymbol } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';
import { useWorkspaceFixtures } from '../support/workspace';
const { createTempDir } = useWorkspaceFixtures();
suite('Document outline modes over LSP', function () {
  this.timeout(20000);
  test('defaults to local syntax and switches external context without reopening', async () => {
    const root=createTempDir(); const forced=path.join(root,'forced.h');
    fs.writeFileSync(forced,'#define EXTERNAL_FLAG 1');
    const uri=pathToFileURL(path.join(root,'main.axl')).toString();
    const textDocument={uri}; const server=startLspServer();
    const settings={forcedIncludeFiles:[forced]};
    const names=async () => (await server.request<DocumentSymbol[]>('textDocument/documentSymbol',{textDocument})).map(s=>s.name);
    try {
      await server.request('initialize',{processId:null,rootUri:null,capabilities:{},configuration:settings});
      await server.notify('initialized',{});
      await server.notify('textDocument/didOpen',{textDocument:{uri,languageId:'axel',version:1,text:'#ifdef EXTERNAL_FLAG\nint externalBranch;\n#else\nint localBranch;\n#endif'}});
      assert.deepStrictEqual(await names(),['localBranch']);
      await server.configure({settings:{...settings,workspaceSymbols:'All'}});
      assert.deepStrictEqual(await names(),['externalBranch']);
      await server.configure({settings:{...settings,workspaceSymbols:'Just My Code'}});
      assert.deepStrictEqual(await names(),['localBranch']);
      await server.notify('textDocument/didChange',{textDocument:{uri,version:2},contentChanges:[{text:'int unsaved;'}]});
      assert.deepStrictEqual(await names(),['unsaved']);
      await server.notify('textDocument/didClose',{textDocument});
      assert.deepStrictEqual(await names(),[]);
    } finally { await server.stop(); }
  });
});
