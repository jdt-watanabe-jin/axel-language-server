import { canonicalPath, fileIdentity, filePath } from '../../analyzer/projectScope';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CancellationTokenSource, type InitializeResult, type Location, type SelectionRange } from 'vscode-languageserver/node';
import { startLspServer } from '../support/lspClient';
import { useWorkspaceFixtures } from '../support/workspace';
import { positionFromOffset } from '../support/source';
const {createTempDir}=useWorkspaceFixtures();
suite('R1 navigation over LSP', function () {
  this.timeout(30000);
  let server:ReturnType<typeof startLspServer>;let root:string;
  const uri=(file:string)=>pathToFileURL(path.join(root,file)).toString();
  setup(()=>{root=createTempDir();server=startLspServer(20000);});
  teardown(async()=>{await server.stop();});
  async function initialize(settings={}) {const r=await server.request<InitializeResult>('initialize',{processId:null,rootUri:uri(''),capabilities:{},configuration:settings});await server.notify('initialized',{});return r;}
  async function open(text:string,version=1){await server.notify('textDocument/didOpen',{textDocument:{uri:uri('main.axl'),languageId:'axel',version,text}});}
  const request=(method:string,text:string,name:string,last=false)=>server.request<Location[]>('textDocument/'+method,{textDocument:{uri:uri('main.axl')},position:positionFromOffset(text,last?text.lastIndexOf(name):text.indexOf(name))});
  test('advertises navigation capabilities and follows a typedef',async()=>{
    const capabilities = (await initialize()).capabilities;
    for (const key of ['declarationProvider', 'typeDefinitionProvider', 'implementationProvider', 'selectionRangeProvider'] as const) { assert.strictEqual(capabilities[key], true, key); }
    const text='class Target { int field; };\ntypedef Target Alias;\ntypedef Alias Second;\nSecond **values[2];\nint number;';await open(text);
    assert.strictEqual((await request('typeDefinition',text,'values'))[0]?.range.start.line,2);
  });
  test('separates matching declaration from definition without mixing overloads',async()=>{
    await initialize();const text='int pick(int value);\nint pick(string value);\nint pick(int value) { return value; }\nvoid main() { pick(1); }';await open(text);
    assert.strictEqual((await request('declaration',text,'pick',true))[0]?.range.start.line,0);
    assert.strictEqual((await request('definition',text,'pick',true))[0]?.range.start.line,2);
    assert.strictEqual((await request('declaration',text,'main'))[0]?.range.start.line,3);
  });
  test('finds unopened virtual overrides and derived types and updates exclusions',async()=>{
    fs.writeFileSync(path.join(root,'base.h'),'class Base { public: virtual void run(int value); };');
    fs.writeFileSync(path.join(root,'child.axl'),'#include "base.h"\nclass Child : Base { public: void run(int value) {} void run(string value) {} };');
    await initialize();const text='#include "base.h"\nvoid main() { Base value; value.run(1); }';await open(text);
    const result=await request('implementation',text,'run');assert.strictEqual(result.length,1);assert.strictEqual(fileIdentity(canonicalPath(filePath(result[0].uri)!)),fileIdentity(canonicalPath(path.join(root,'child.axl'))));
    assert.ok((await request('implementation',text,'Base'))[0]?.uri.toLowerCase().endsWith('/child.axl'));
    await server.configure({settings:{project:{exclude:['child.axl']}}});assert.deepStrictEqual(await request('implementation',text,'run'),[]);
  });
  test('returns nested original-source selections for multiple positions and edits',async()=>{
    await initialize();const text='void main() { string s = "hello"; /* comment */ int n = (1 + 2); }';await open(text);
    const positions=['hello','comment','1 +'].map(s=>positionFromOffset(text,text.indexOf(s)));
    const result=await server.request<SelectionRange[]>('textDocument/selectionRange',{textDocument:{uri:uri('main.axl')},positions});assert.strictEqual(result.length,positions.length);
    for (let i = 0; i < result.length; i++) { assert.ok(result[i].range.start.character <= positions[i].character && result[i].range.end.character >= positions[i].character); }
    await server.notify('textDocument/didChange',{textDocument:{uri:uri('main.axl'),version:2},contentChanges:[{text:'int edited;'}]});
    const edited=await server.request<SelectionRange[]>('textDocument/selectionRange',{textDocument:{uri:uri('main.axl')},positions:[{line:0,character:6}]});assert.deepStrictEqual(edited[0].range,{start:{line:0,character:4},end:{line:0,character:10}});
    const token=new CancellationTokenSource();const pending=server.request('textDocument/selectionRange',{textDocument:{uri:uri('main.axl')},positions:Array.from({length:5000},()=>({line:0,character:6}))},token.token);token.cancel();await assert.rejects(pending,{code:-32800});token.dispose();
  });
  test('refreshes unopened implementations after unsaved changes and disk deletion',async()=>{
    fs.writeFileSync(path.join(root,'base.h'),'class Base { public: virtual void run(int value); };');
    const child=path.join(root,'child.axl');const original='#include "base.h"\nclass Child : Base { public: void run(int value) {} };';fs.writeFileSync(child,original);
    await initialize();const text='#include "base.h"\nvoid main() { Base value; value.run(1); }';await open(text);
    assert.strictEqual((await request('implementation',text,'run')).length,1);
    await server.notify('textDocument/didOpen',{textDocument:{uri:uri('child.axl'),languageId:'axel',version:1,text:'#include "base.h"\nclass Child : Base { public: void unrelated() {} };'}});
    assert.deepStrictEqual(await request('implementation',text,'run'),[]);
    await server.notify('textDocument/didClose',{textDocument:{uri:uri('child.axl')}});
    assert.strictEqual((await request('implementation',text,'run')).length,1);
    fs.unlinkSync(child);await server.notify('workspace/didChangeWatchedFiles',{changes:[{uri:uri('child.axl'),type:3}]});
    assert.deepStrictEqual(await request('implementation',text,'run'),[]);
  });

});
