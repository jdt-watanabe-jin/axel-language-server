import * as assert from 'assert';
import { CancellationToken, type CodeLens, type CodeLensParams } from 'vscode-languageserver/node';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';
import { createTestDocument } from '../support/handlerFixtures';
import { getReferences } from '../../analyzer/navigation';
import { registerCodeLensHandlers } from '../../lsp/codeLens';
import { TypeHierarchyIndex } from '../../analyzer/typeHierarchy/index';
import { ProjectScope } from '../../analyzer/projectScope';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { useWorkspaceFixtures } from '../support/workspace';

function fixture(enabled = true, refreshSupport = true, text = 'int foo() { return 1; }\nint main() { return foo(); }', navigate?:TypeHierarchyIndex['navigate']) {
  const document = createTestDocument(text);
  document.uri = pathToFileURL(path.join(os.tmpdir(), 'r3-code-lens-main.axl')).toString();
  const analyzer = new DocumentAnalyzer();
  let requests = 0, implementations = 0, refreshes = 0, revision = 0;
  const settings = { codeLens: { enabled } };
  let list!: (params: CodeLensParams) => Promise<CodeLens[]>;
  let resolve!: (lens: CodeLens) => Promise<CodeLens>;
  const controller = registerCodeLensHandlers({
    connection: { onCodeLens: (handler: typeof list) => { list = handler; }, onCodeLensResolve: (handler: typeof resolve) => { resolve = handler; },
      sendRequest: async (type: {method:string}) => { assert.strictEqual(type.method, "workspace/codeLens/refresh"); refreshes++; } },
    documents: { get: () => document }, analyzer, configuration: { settings },
    clientCapabilities: { workspace: { codeLens: { refreshSupport } } }, logger: { error: (message: string) => { throw new Error(message); } }
  } as never, { navigate: async (...args:Parameters<TypeHierarchyIndex['navigate']>) => { implementations++; return navigate ? navigate(...args) : []; } } as never, {
    request: work => params => work(params, CancellationToken.None),
    analyzeRequest: async (_token, input) => { requests++; return analyzer.analyzeDocument(input); }
  }, () => revision);
  return { document, analyzer, settings, list: () => list({textDocument:{uri:document.uri}}), resolve, controller,
    counts: () => ({requests, implementations, refreshes}), change: () => { revision++; } };
}

suite('R3 Code Lens', () => {
  const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
  test('counts pending edits in other open documents without a notification flush', async () => {
    const root = createTempDir(); const file = path.join(root,'source.h');
    const text = 'int foo() { return 1; }'; fs.writeFileSync(file,text);
    const uri = pathToFileURL(file).toString(); const callerUri = pathToFileURL(path.join(root,'caller.axl')).toString();
    const analyzer = createWorkspaceIndex();
    analyzer.indexOpenDocument({uri,version:1,text});
    analyzer.indexOpenDocument({uri:callerUri,version:1,text:'#include "source.h"\nint main() { return foo(); }'});
    let list!:(params:CodeLensParams)=>Promise<CodeLens[]>;
    let resolve!:(lens:CodeLens)=>Promise<CodeLens>;
    let revision = 0;
    const controller = registerCodeLensHandlers({
      connection:{onCodeLens:(handler:typeof list)=>{list=handler;},onCodeLensResolve:(handler:typeof resolve)=>{resolve=handler;}},
      analyzer,documents:{get:()=>({uri,version:1,getText:()=>text})},configuration:{settings:{codeLens:{enabled:true}}},
      logger:{error:(message:string)=>assert.fail(message)}
    } as never, {} as never, {
      request:work=>params=>work(params,CancellationToken.None),
      analyzeRequest:(token,input)=>analyzer.analyzeRequestDocument(input,token)
    },()=>revision);
    try {
      const [first] = await list({textDocument:{uri}});
      assert.strictEqual((await resolve(first)).command?.title,'1 reference (indexed scope)');
      analyzer.updateOpenDocument({uri:callerUri,version:2,text:'#include "source.h"\nint main() { foo(); return foo(); }'});
      revision++; controller.refresh();
      assert.strictEqual((await resolve(first)).command,undefined);
      const [current] = await list({textDocument:{uri}});
      const result = await resolve(current);
      assert.strictEqual(result.command?.title,'2 references (indexed scope)');
      assert.ok(result.command?.arguments?.[2].every((location:{uri:string})=>location.uri===callerUri));
    } finally {controller.dispose();}
  });
  test('resolves virtual counts to exactly the existing implementation navigation locations', async () => {
    const f = fixture(true,true,'class Base { public: virtual int run() { return 1; } };\nclass Child : public Base { public: int run() { return 2; } };', (...args) => index.navigate(...args));
    const scope = new ProjectScope(); scope.setOpenUris([f.document.uri]);
    const index = new TypeHierarchyIndex(scope, () => [{uri:f.document.uri,version:1,text:f.document.getText()}]);
    index.resume();
    try {
      const lenses = await f.list();
      const resolved = await f.resolve(lenses[1]);
      const expected = await index.navigate('implementation',f.document.uri,lenses[1].range.start,CancellationToken.None);
      assert.strictEqual(expected.length,2);
      assert.strictEqual(resolved.command?.title,'2 implementations (project scope)');
      assert.deepStrictEqual(resolved.command?.arguments?.[2],expected);
    } finally { f.controller.dispose(); await index.dispose(); }
  });
  test('reuses source analysis and resolved results across repeated lens requests', async () => {
    const f = fixture();
    try {
      const [first] = await f.list(); await f.resolve(first); const before = f.counts();
      const [second] = await f.list(); await f.resolve(second); assert.deepStrictEqual(f.counts(), before);
    } finally { f.controller.dispose(); }
  });
  test('offers implementation lenses for virtual methods and their overrides only', async () => {
    const f = fixture(true, true, 'class Base { public: virtual int run() { return 1; } int plain() { return 0; } };\nclass Child : public Base { public: int run() { return 2; } };');
    try {
      const lenses = await f.list(); assert.strictEqual(lenses.length, 5); assert.strictEqual(f.counts().implementations, 0);
      const resolved = await Promise.all(lenses.map(lens => f.resolve(lens)));
      assert.strictEqual(resolved.filter(lens => lens.command?.title === '0 implementations (project scope)').length, 2);
      assert.strictEqual(f.counts().implementations, 2);
    } finally { f.controller.dispose(); }
  });
  test('disabled requests and stale resolves perform no analysis', async () => {
    const f = fixture(false);
    try { assert.deepStrictEqual(await f.list(), []); assert.deepStrictEqual(f.counts(), {requests:0,implementations:0,refreshes:0});
      f.settings.codeLens.enabled = true;
      const lenses = await f.list(); assert.strictEqual(lenses.length, 2);
      f.settings.codeLens.enabled = false;
      const before = f.counts(); assert.strictEqual((await f.resolve(lenses[0])).command, undefined);
      assert.deepStrictEqual(f.counts(), before);
    } finally { f.controller.dispose(); }
  });
  test('returns unresolved lenses then resolves exact reference locations and reuses results', async () => {
    const f = fixture();
    try {
      const lenses = await f.list(); assert.strictEqual(lenses.length, 2); assert.ok(lenses.every(lens => !lens.command));
      assert.strictEqual(f.counts().implementations, 0);
      const result = await f.resolve(lenses[0]);
      assert.strictEqual(result.command?.title, '1 reference (indexed scope)');
      assert.strictEqual(result.command?.command, 'editor.action.showReferences');
      const analysis = f.analyzer.analyzeDocument({uri:f.document.uri, version:1, text:f.document.getText()});
      assert.deepStrictEqual(result.command?.arguments?.[2], getReferences({analysis,position:lenses[0].range.start,workspaceIndex:{},includeDeclaration:false}));
      const before = f.counts(); assert.deepStrictEqual(await f.resolve(lenses[0]), result); assert.deepStrictEqual(f.counts(), before);
    } finally { f.controller.dispose(); }
  });
  test('keeps both unchanged enumeration batches resolvable', async () => {
    const f = fixture();
    try {
      const first = await f.list(); const second = await f.list();
      assert.strictEqual((await f.resolve(first[0])).command?.title, '1 reference (indexed scope)');
      assert.strictEqual((await f.resolve(second[0])).command?.title, '1 reference (indexed scope)');
      assert.strictEqual((await f.resolve(first[1])).command?.title, '0 references (indexed scope)');
      assert.deepStrictEqual(first.map(lens => lens.data), second.map(lens => lens.data));
    } finally { f.controller.dispose(); }
  });
  test('rejects forged and revision-stale lens identities without analysis', async () => {
    const f = fixture();
    try {
      const [newLens] = await f.list(); const before = f.counts();
      assert.strictEqual((await f.resolve({...newLens,data:{id:'forged'}})).command, undefined);
      f.change(); assert.strictEqual((await f.resolve(newLens)).command, undefined); assert.deepStrictEqual(f.counts(), before);
    } finally { f.controller.dispose(); }
  });
  test('debounces negotiated refresh and clears disabled lenses once', async () => {
    const f = fixture();
    try {
      await f.list(); f.controller.refresh(); f.controller.refresh();
      await new Promise(resolve => setTimeout(resolve, 80)); assert.strictEqual(f.counts().refreshes, 1);
      f.settings.codeLens.enabled = false; f.controller.refresh(); f.controller.refresh();
      await new Promise(resolve => setTimeout(resolve, 80)); assert.strictEqual(f.counts().refreshes, 2);
      f.controller.refresh(); await new Promise(resolve => setTimeout(resolve, 80)); assert.strictEqual(f.counts().refreshes, 2);
    } finally { f.controller.dispose(); }
    const unsupported = fixture(true, false);
    try { unsupported.controller.refresh(); await new Promise(resolve => setTimeout(resolve,80)); assert.strictEqual(unsupported.counts().refreshes,0); }
    finally { unsupported.controller.dispose(); }
  });
});
