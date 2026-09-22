import * as assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import { CancellationTokenSource, LSPErrorCodes } from 'vscode-languageserver/node';
import { useWorkspaceFixtures } from '../support/workspace';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { InitializeResult, InlayHint } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';

suite('LSP parameter inlay hints', function () {
  this.timeout(30_000);
  const fixtures = useWorkspaceFixtures();
  test('advertises hints and applies defaults and live suppression without editing', async () => {
    const server = startLspServer();
    const uri = pathToFileURL(path.join(os.tmpdir(), 'inlay-settings.axl')).toString();
    const text = 'void f(int count) {} void main() { f(10); f(discount); }';
    const params = {textDocument:{uri},range:{start:{line:0,character:0},end:{line:1,character:0}}};
    try {
      const initialized = await server.request<InitializeResult>('initialize', {
        processId:null,rootUri:null,capabilities:{}
      });
      assert.ok(initialized.capabilities.inlayHintProvider);
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', {textDocument:{uri,languageId:'axel',version:1,text}});
      assert.deepStrictEqual(await server.request('textDocument/inlayHint', params), []);
      const configure = (enabled: unknown, suppress: unknown) => server.configure( {
        settings:{inlayHints:{parameterNames:{enabled,suppressWhenArgumentContainsName:suppress}}}
      });
      await configure(true, true);
      assert.deepStrictEqual(await server.request<InlayHint[]>('textDocument/inlayHint', params), [{
        position:{line:0,character:text.indexOf('10')},label:'count:',kind:2,paddingRight:true
      }]);
      await configure(true, false);
      assert.strictEqual((await server.request<InlayHint[]>('textDocument/inlayHint', params)).length, 2);
      await configure(false, true);
      assert.deepStrictEqual(await server.request('textDocument/inlayHint', params), []);
    } finally { await server.stop(); }
  });
  test('refreshes supported clients after settings, disk and open dependency changes', async () => {
    const root = fixtures.createTempDir();
    const header = path.join(root,'api.h');
    const headerUri = pathToFileURL(header).toString();
    fs.writeFileSync(header,'void f(int count);');
    const server = startLspServer();
    let refreshes = 0;
    server.onInlayHintRefresh(()=>{ refreshes++; });
    const uri = pathToFileURL(path.join(root,'main.axl')).toString();
    const params = {textDocument:{uri},range:{start:{line:0,character:0},end:{line:5,character:0}}};
    const enabled = {inlayHints:{parameterNames:{enabled:true,suppressWhenArgumentContainsName:true}}};
    try {
      await server.request('initialize',{processId:null,rootUri:null,capabilities:{workspace:{inlayHint:{refreshSupport:true}}},configuration:enabled});
      await server.notify('initialized',{});
      await server.notify('textDocument/didOpen',{textDocument:{uri,languageId:'axel',version:1,text:'#include "api.h"\nvoid main(){f(1);}'}});
      assert.deepStrictEqual((await server.request<InlayHint[]>('textDocument/inlayHint',params)).map(h=>h.label),['count:']);
      let previous = refreshes;
      await server.configure({settings:{inlayHints:{parameterNames:{enabled:true,suppressWhenArgumentContainsName:false}}}});
      await server.request('textDocument/inlayHint',params);
      assert.ok(refreshes > previous,'configuration requests refresh');
      previous = refreshes;
      fs.writeFileSync(header,'void f(int size);');
      await server.notify('workspace/didChangeWatchedFiles',{changes:[{uri:headerUri,type:2}]});
      assert.deepStrictEqual((await server.request<InlayHint[]>('textDocument/inlayHint',params)).map(h=>h.label),['size:']);
      assert.ok(refreshes > previous,'disk dependency requests refresh');
      await server.notify('textDocument/didOpen',{textDocument:{uri:headerUri,languageId:'axel',version:1,text:'void f(int latest);'}});
      assert.deepStrictEqual((await server.request<InlayHint[]>('textDocument/inlayHint',params)).map(h=>h.label),['latest:']);
      previous = refreshes;
      await server.notify('textDocument/didChange',{textDocument:{uri:headerUri,version:2},contentChanges:[{text:'void f(int edited);'}]});
      assert.deepStrictEqual((await server.request<InlayHint[]>('textDocument/inlayHint',params)).map(h=>h.label),['edited:']);
      assert.ok(refreshes > previous,'unsaved dependency requests refresh');
    } finally { await server.stop(); }
  });

  test('keeps hints and lenses stable while hovering an unchanged dependency and closing it', async () => {
    const root = fixtures.createTempDir();
    const header = path.join(root, 'api.h');
    const text = '/** @param count number of items */\nvoid f(int count);';
    fs.writeFileSync(header, text);
    const headerUri = pathToFileURL(header).toString().replace('api.h', '%61pi.h');
    const uri = pathToFileURL(path.join(root, 'main.axl')).toString();
    const server = startLspServer();
    const refreshes = { inlay: 0, lens: 0, diagnostics: 0, tokens: 0 };
    server.onInlayHintRefresh(() => { refreshes.inlay++; });
    server.onRequest('workspace/codeLens/refresh', () => { refreshes.lens++; return null; });
    server.onDiagnosticRefresh(() => { refreshes.diagnostics++; });
    server.onRequest('workspace/semanticTokens/refresh', () => { refreshes.tokens++; return null; });
    const params = { textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } } };
    try {
      await server.request('initialize', { processId: null, rootUri: null, capabilities: {
        textDocument: { inlayHint: { resolveSupport: { properties: ['label.tooltip', 'label.location'] } } },
        workspace: { inlayHint: { refreshSupport: true }, codeLens: { refreshSupport: true },
          semanticTokens: { refreshSupport: true }, diagnostics: { refreshSupport: true } }
      }, configuration: { forcedIncludeFiles: [header], inlayHints: { parameterNames: { enabled: true } }, codeLens: { enabled: true } } });
      await server.notify('initialized', {});
      await server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'axel', version: 1, text: 'void main(){ f(1); }' } });
      await server.request('textDocument/inlayHint', params);
      // Observe past the 40ms Code Lens refresh debounce after warm-up and after each lifecycle event.
      await new Promise(resolve => setTimeout(resolve, 100));
      const hint = (await server.request<InlayHint[]>('textDocument/inlayHint', params))[0];
      const before = { ...refreshes };
      await server.notify('textDocument/didOpen', { textDocument: { uri: headerUri, version: 1, languageId: 'axel', text } });
      const hover = await server.request('textDocument/hover', { textDocument: { uri: headerUri }, position: { line: 1, character: 11 } });
      assert.match(JSON.stringify(hover), /int count/);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepStrictEqual(refreshes, before, 'unchanged open must not refresh other features');
      assert.ok(await server.request('inlayHint/resolve', hint), 'opening a view must not stale existing hint identity');
      await server.notify('textDocument/didClose', { textDocument: { uri: headerUri } });
      await server.request('textDocument/inlayHint', params);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepStrictEqual(refreshes, before, 'unchanged close must not refresh other features');
      assert.ok(await server.request('inlayHint/resolve', hint));
    } finally { await server.stop(); }
  });

  test('cancels requests, discards obsolete versions, and serves subsequent edits', async () => {
    const server = startLspServer(15000);
    const source = new CancellationTokenSource();
    const uri = pathToFileURL(path.join(os.tmpdir(),'inlay-cancel.axl')).toString();
    const params = {textDocument:{uri},range:{start:{line:0,character:0},end:{line:10000,character:0}}};
    const text = 'void f(int count) {}\nvoid main(){\n' + 'f(1);\n'.repeat(2000) + '}';
    try {
      await server.request('initialize',{processId:null,rootUri:null,capabilities:{},configuration:{inlayHints:{parameterNames:{enabled:true}}}});
      await server.notify('initialized',{});
      await server.notify('textDocument/didOpen',{textDocument:{uri,languageId:'axel',version:1,text}});
      const cancelled = server.request('textDocument/inlayHint',params,source.token);
      source.cancel();
      await assert.rejects(cancelled,(error: unknown)=>(error as {code:number}).code === LSPErrorCodes.RequestCancelled);
      const stale = server.request('textDocument/inlayHint',params);
      await server.notify('textDocument/didChange',{textDocument:{uri,version:2},contentChanges:[{text:'void f(int fresh) {} void main(){f(2);}'}]});
      await assert.rejects(stale,(error: unknown)=>(error as {code:number}).code === LSPErrorCodes.ContentModified);
      assert.deepStrictEqual((await server.request<InlayHint[]>('textDocument/inlayHint',params)).map(h=>h.label),['fresh:']);
    } finally { source.dispose(); await server.stop(); }
  });
});
