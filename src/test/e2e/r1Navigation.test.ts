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
  test('advertises all four capabilities',async()=>{const c=(await initialize()).capabilities;for(const key of ['declarationProvider','typeDefinitionProvider','implementationProvider','selectionRangeProvider'] as const)assert.strictEqual(c[key],true,key);});
  test('follows nearest typedef then underlying type and rejects builtin types',async()=>{
    await initialize();const text='class Target { int field; };\ntypedef Target Alias;\ntypedef Alias Second;\nSecond **values[2];\nint number;';await open(text);
    assert.strictEqual((await request('typeDefinition',text,'values'))[0]?.range.start.line,2);
    assert.strictEqual((await request('typeDefinition',text,'Second'))[0]?.range.start.line,1);
    assert.strictEqual((await request('typeDefinition',text,'Alias'))[0]?.range.start.line,0);
    assert.deepStrictEqual(await request('typeDefinition',text,'number'),[]);
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
    for(let i=0;i<result.length;i++){let current=result[i];assert.ok(current.range.start.character<=positions[i].character && current.range.end.character>=positions[i].character);while(current.parent){assert.ok(current.parent.range.start.character<=current.range.start.character);assert.ok(current.parent.range.end.character>=current.range.end.character);assert.notDeepStrictEqual(current.range,current.parent.range);current=current.parent;}}
    await server.notify('textDocument/didChange',{textDocument:{uri:uri('main.axl'),version:2},contentChanges:[{text:'int edited;'}]});
    const edited=await server.request<SelectionRange[]>('textDocument/selectionRange',{textDocument:{uri:uri('main.axl')},positions:[{line:0,character:6}]});assert.deepStrictEqual(edited[0].range,{start:{line:0,character:4},end:{line:0,character:10}});
    const token=new CancellationTokenSource();const pending=server.request('textDocument/selectionRange',{textDocument:{uri:uri('main.axl')},positions:Array.from({length:5000},()=>({line:0,character:6}))},token.token);token.cancel();await assert.rejects(pending,{code:-32800});token.dispose();
  });
  test('does not merge method implementations from incompatible macro contexts',async()=>{
    fs.writeFileSync(path.join(root,'base.h'),'class Base { public: virtual void run(ARG value); };');
    fs.writeFileSync(path.join(root,'child.axl'),'#define ARG double\n#include "base.h"\nclass Child : Base { public: void run(double value) {} };');
    await initialize();const text='#define ARG int\n#include "base.h"\nvoid main() { Base value; value.run; }';await open(text);
    assert.strictEqual((await request('declaration',text,'run')).length,1);
    assert.deepStrictEqual(await request('implementation',text,'run'),[]);
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

  test('finds overrides through a global typedef receiver',async()=>{
    const text='class R1Base { public: virtual void run(int value); };\ntypedef R1Base R1Alias;\nR1Alias object;\nint choose(int value);\nint choose(int value) { return value; }\nvoid main() { choose(1); object.run(1); }';
    fs.writeFileSync(path.join(root,'main.axl'),text);
    fs.writeFileSync(path.join(root,'child.axl'),'#include "main.axl"\nclass R1Child : R1Base { public: void run(int value) {} };');
    await initialize();await open(text);
    assert.strictEqual((await request('implementation',text,'run',true)).length,1);
  });
  test('matches value parameter qualifiers using AXEL signature semantics',async()=>{
    await initialize();const text='int foo(int value);\nint foo(const int value) { return value; }';await open(text);
    assert.strictEqual((await request('declaration',text,'foo',true))[0]?.range.start.line,0);
  });

  test('type implementations exclude inherited and explicit pure virtual classes',async()=>{
    const text='class Base { public: virtual void run() = 0; };\nclass Abstract : Base {};\nclass Concrete : Abstract { public: void run() {} };\nclass AgainAbstract : Concrete { public: virtual void run() = 0; };\nclass StillConcrete : Concrete {};';
    await initialize();await open(text);
    const result=await request('implementation',text,'Base');
    assert.deepStrictEqual(result.map(item=>item.range.start.line),[2,4]);
  });

  test('keeps method definition identity when a separate prototype exists',async()=>{
    await initialize();const text='class C { public: void run(int value); };\nvoid C::run(int value) {}\nvoid main() { C c; c.run(1); }';await open(text);
    const definitions=await request('definition',text,'run',true);
    assert.strictEqual(definitions.length,1);assert.strictEqual(definitions[0].range.start.line,1);
    const declarations=await request('declaration',text,'run',true);
    assert.strictEqual(declarations.length,1);assert.strictEqual(declarations[0].range.start.line,0);
    const refs=await server.request<Location[]>('textDocument/references',{textDocument:{uri:uri('main.axl')},position:positionFromOffset(text,text.lastIndexOf('run')),context:{includeDeclaration:false}});
    assert.ok(refs.some(item=>item.range.start.line===2));
  });

});
