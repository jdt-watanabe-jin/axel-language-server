import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { Hover, Location, MarkupContent, SignatureHelp } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';
import { useWorkspaceFixtures } from '../support/workspace';

suite('Overload LSP agreement', function () {
  this.timeout(20_000);
  const fixtures = useWorkspaceFixtures();
  test('shares typed selection across requests and updates after edits', async () => {
    const root = fixtures.createTempDir();
    const header = path.join(root, 'api.h');
    fs.writeFileSync(header, 'class string {public:int data;};\nint f(int value);\nint f(string value);');
    fs.writeFileSync(path.join(root, 'api.analysis.json'), JSON.stringify({schemaVersion:1,profile:'axel-510',
      declarationFiles:['api.h'],types:{string:'api.h'},analysisOnlyMacros:[]}));
    const server = startLspServer();
    try {
      await server.request('initialize',{processId:null,rootUri:null,capabilities:{},configuration:{forcedIncludeFiles:[header]}});
      await server.notify('initialized',{});
      const uri = pathToFileURL(path.join(root,'main.axl')).toString();
      const textDocument = {uri};
      const position = {line:0,character:12};
      await server.notify('textDocument/didOpen',{textDocument:{uri,languageId:'axel',version:1,text:'void main(){f("x");}'}});
      const hover = await server.request<Hover>('textDocument/hover',{textDocument,position});
      assert.match((hover.contents as MarkupContent).value,/f\(string value\)/);
      const definitions = await server.request<Location[]>('textDocument/definition',{textDocument,position});
      assert.strictEqual(definitions[0].range.start.line,2);
      const help = await server.request<SignatureHelp>('textDocument/signatureHelp',{textDocument,position:{line:0,character:15}});
      assert.match(help.signatures[0].label,/f\(string value\)/);
      const references = await server.request<Location[]>('textDocument/references',{textDocument,position,context:{includeDeclaration:false}});
      assert.strictEqual(references.length,1);
      assert.strictEqual(references[0].uri,uri);
      await server.notify('textDocument/didChange',{textDocument:{uri,version:2},contentChanges:[{text:'void main(){f(1);}'}]});
      const changed = await server.request<Location[]>('textDocument/definition',{textDocument,position});
      assert.strictEqual(changed[0].range.start.line,1);
    } finally { await server.stop(); }
  });
});
