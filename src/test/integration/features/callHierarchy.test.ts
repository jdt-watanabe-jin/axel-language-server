import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { runAnalysisSteps } from '../../../util/analysisSteps';
import { useWorkspaceFixtures } from '../../support/workspace';
import { positionFromOffset } from '../../support/source';
import type { AnalyzedDocument } from '../../../types/analysis';
import * as hierarchy from '../../../analyzer/callHierarchy';

suite('Call hierarchy graph', () => {
  const { createWorkspaceIndex, createTempDir } = useWorkspaceFixtures();
  function api(): typeof import('../../../analyzer/callHierarchy') {
    return hierarchy;
  }
  function fixture(text: string) {
    const index = createWorkspaceIndex();
    const uri = pathToFileURL(path.join(createTempDir(), 'main.axl')).toString();
    const analysis = index.indexOpenDocument({uri, version:1, text});
    const prepare = (name: string, occurrence = 0, doc: AnalyzedDocument = analysis, source = text) => {
      let offset = -1;
      for (let i = 0; i <= occurrence; i++) { offset = source.indexOf(name, offset + 1); }
      assert.ok(offset >= 0);
      const items = runAnalysisSteps(api().prepareCallHierarchySteps({analysis:doc,
        position:positionFromOffset(source, offset), workspaceIndex:index}));
      assert.ok(items?.length, name);
      return items[0];
    };
    const outgoing = (item: ReturnType<typeof prepare>, doc = analysis) =>
      runAnalysisSteps(api().outgoingCallHierarchySteps({item, analysis:doc, workspaceIndex:index}));
    const incoming = (item: ReturnType<typeof prepare>, doc = analysis) =>
      runAnalysisSteps(api().incomingCallHierarchySteps({item, analysis:doc, workspaceIndex:index}));
    return {index, uri, analysis, prepare, outgoing, incoming};
  }

  test('registration is a value reference in both directions without an invented dispatcher edge', () => {
    const f = fixture('void handler() {}\nvoid Register(void (*cb)()) {}\nvoid setup() { Register(handler); }');
    assert.deepStrictEqual(f.outgoing(f.prepare('setup')).map(c => c.item.name), ['Register', 'handler']);
    assert.deepStrictEqual(f.incoming(f.prepare('handler')).map(c => c.item.name), ['setup']);
    assert.deepStrictEqual(f.outgoing(f.prepare('Register')), []);
  });

  test('groups repeated locations and preserves self recursion', () => {
    const f = fixture('void a() { a(); a(); }');
    const calls = f.outgoing(f.prepare('a'));
    assert.deepStrictEqual(calls.map(c => c.item.name), ['a']);
    assert.deepStrictEqual(calls[0].fromRanges.map(r => r.start.character), [11, 16]);
    assert.deepStrictEqual(f.incoming(f.prepare('a'))[0].fromRanges, calls[0].fromRanges);
  });

  test('includes address-taking but does not infer the later indirect call target', () => {
    const text = 'void handler() {}\nvoid setup() { void (*callback)() = &handler; callback(); }';
    const f = fixture(text);
    const calls = f.outgoing(f.prepare('setup'));
    assert.deepStrictEqual(calls.map(call=>call.item.name),['handler']);
    assert.deepStrictEqual(calls[0].fromRanges,[{start:{line:1,character:37},end:{line:1,character:44}}]);
    assert.strictEqual(runAnalysisSteps(api().prepareCallHierarchySteps({analysis:f.analysis,
      position:positionFromOffset(text,text.lastIndexOf('callback')),workspaceIndex:f.index})),null);
  });

  test('assigns local initializers to functions and global and field initializers to variables', () => {
    const f = fixture('int helper() { return 1; }\nint global = helper();\nclass A { int value = helper(); };\nvoid main() { int local = helper(); }');
    assert.deepStrictEqual(f.incoming(f.prepare('helper')).map(c => c.item.name), ['global', 'main', 'value']);
    assert.deepStrictEqual(f.outgoing(f.prepare('global')).map(c => c.item.name), ['helper']);
  });

  test('updates edges after unsaved edits and rejects a deleted item instead of rebinding its name', () => {
    const f = fixture('void a() {}\nvoid b() {}\nvoid main() { a(); }');
    const main = f.prepare('main');
    const a = f.prepare('a');
    assert.deepStrictEqual(f.outgoing(main).map(c => c.item.name), ['a']);
    const analysis = f.index.indexOpenDocument({uri:f.uri, version:2, text:'void b() {}\nvoid main() { b(); }'});
    assert.deepStrictEqual(f.outgoing(main, analysis).map(c => c.item.name), ['b']);
    assert.deepStrictEqual(f.incoming(a, analysis), []);
  });

  test('does not make edges from comments, type names, unresolved calls or inactive branches', () => {
    const text = 'void a() {}\nvoid main() { /* a() */ Missing(); }\n#if 0\nvoid hidden() { a(); }\n#endif';
    const f = fixture(text);
    assert.deepStrictEqual(f.incoming(f.prepare('a')), []);
    assert.deepStrictEqual(f.outgoing(f.prepare('main')), []);
    assert.strictEqual(runAnalysisSteps(api().prepareCallHierarchySteps({analysis:f.analysis,
      position:positionFromOffset(text, text.indexOf('/*') + 3), workspaceIndex:f.index})), null);
  });

  test('unifies a prototype and definition across includes and prefers the definition location', () => {
    const dir = createTempDir();
    const header = path.join(dir, 'api.h');
    fs.writeFileSync(header, 'void target(int value);');
    const index = createWorkspaceIndex();
    const uri = pathToFileURL(path.join(dir, 'main.axl')).toString();
    const text = '#include "api.h"\nvoid target(int arg) {}\nvoid caller() { target(1); }';
    const analysis = index.indexOpenDocument({uri, version:1, text});
    const item = runAnalysisSteps(api().prepareCallHierarchySteps({analysis,
      position:positionFromOffset(text, text.lastIndexOf('target')), workspaceIndex:index}))?.[0];
    assert.ok(item);
    assert.strictEqual(item.uri, uri);
    assert.strictEqual(item.selectionRange.start.line, 1);
    const incoming = runAnalysisSteps(api().incomingCallHierarchySteps({analysis, item, workspaceIndex:index}));
    assert.deepStrictEqual(incoming.map(c => c.item.name), ['caller']);
    const outgoing = runAnalysisSteps(api().outgoingCallHierarchySteps({analysis,item:incoming[0].item,workspaceIndex:index}));
    assert.deepStrictEqual(outgoing.map(call => ({uri:call.item.uri,range:call.item.selectionRange})),
      [{uri,range:item.selectionRange}]);
  });

  test('keeps unrelated same-name functions in separate files separate', () => {
    const f = fixture('void target() {}\nvoid caller() { target(); }');
    const otherUri = pathToFileURL(path.join(createTempDir(), 'other.axl')).toString();
    f.index.indexOpenDocument({uri:otherUri,version:1,text:'void target() {}\nvoid unrelated() { target(); }'});
    assert.deepStrictEqual(f.incoming(f.prepare('target')).map(c => c.item.name), ['caller']);
  });

  test('maps macro generated calls and argument references to written source positions', () => {
    const f = fixture('void target(int value) {}\n#define RUN(x) target(x)\nvoid main() { RUN(1); }');
    const calls = f.outgoing(f.prepare('main'));
    assert.deepStrictEqual(calls.map(c => c.item.name), ['target']);
    assert.deepStrictEqual(calls[0].fromRanges, [{start:{line:2,character:14},end:{line:2,character:20}}]);
  });

  test('attributes inline and external GUI handler calls to their own event', () => {
    const f = fixture('void target() {}\nclass Dialog : public GCDialog {\n GCControlButton button { OnCreate() { target(); } };\n};\nvoid Dialog::button::OnPush() { target(); }');
    assert.deepStrictEqual(f.incoming(f.prepare('target')).map(c => c.item.name), ['OnCreate','OnPush']);
    assert.deepStrictEqual(f.outgoing(f.prepare('OnCreate')).map(c => c.item.name), ['target']);
    assert.deepStrictEqual(f.outgoing(f.prepare('OnPush')).map(c => c.item.name), ['target']);
  });

  test('does not attribute defaults in prototypes to execution at file scope', () => {
    const f = fixture('int helper() { return 1; }\nvoid api(int value = helper());');
    assert.deepStrictEqual(f.incoming(f.prepare('helper')), []);
  });

  test('keeps every expanded macro call inside its GUI event owner', () => {
    const f = fixture('void target() {}\n#define RUN target(); target(); target(); target();\nclass Dialog : public GCDialog { GCControlButton button { OnCreate() { RUN } }; };');
    assert.deepStrictEqual(f.incoming(f.prepare('target')).map(call=>call.item.name),['OnCreate']);
  });

  test('does not resolve an overloaded value reference by selecting the first matching name', () => {
    const f = fixture('void target(int a) {}\nvoid target(double b) {}\nvoid Register(void (*cb)(int)) {}\nvoid main() { Register(target); }');
    assert.deepStrictEqual(f.outgoing(f.prepare('main')).map(c => c.item.name), ['Register']);
  });

  test('separates declarators in a global variable list', () => {
    const f = fixture('int left() { return 1; }\nint right() { return 2; }\nint first = left(), second = right();');
    assert.deepStrictEqual(f.outgoing(f.prepare('first')).map(c => c.item.name), ['left']);
    assert.deepStrictEqual(f.outgoing(f.prepare('second')).map(c => c.item.name), ['right']);
  });

  test('keeps local-class field initialization separate from the containing function', () => {
    const f = fixture('int helper() { return 1; }\nvoid main() { class C { int value = helper(); }; }');
    assert.deepStrictEqual(f.incoming(f.prepare('helper')).map(c => c.item.name), ['value']);
    assert.deepStrictEqual(f.outgoing(f.prepare('value')).map(c => c.item.name), ['helper']);
    assert.deepStrictEqual(f.outgoing(f.prepare('main')), []);
  });

  test('does not merge independent definitions through a shared header prototype', () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir,'api.h'),'void target();');
    const index = createWorkspaceIndex();
    const aUri = pathToFileURL(path.join(dir,'a.axl')).toString();
    const bUri = pathToFileURL(path.join(dir,'b.axl')).toString();
    index.indexOpenDocument({uri:aUri,version:1,text:'#include "api.h"\nvoid target() {}\nvoid callerA() { target(); }'});
    const text = '#include "api.h"\nvoid target() {}\nvoid callerB() { target(); }';
    const analysis = index.indexOpenDocument({uri:bUri,version:1,text});
    const item = runAnalysisSteps(api().prepareCallHierarchySteps({analysis,position:{line:1,character:5},workspaceIndex:index}))?.[0];
    assert.ok(item);
    assert.strictEqual(item.uri,bUri);
    assert.deepStrictEqual(runAnalysisSteps(api().incomingCallHierarchySteps({analysis,item,workspaceIndex:index})).map(c=>c.item.name),['callerB']);
  });

  test('attributes macro-generated function bodies using expanded ownership coordinates', () => {
    const f = fixture('void target() {}\n#define DEF void main() { target(); }\nDEF');
    assert.deepStrictEqual(f.incoming(f.prepare('target')).map(c=>c.item.name),['main']);
  });

  test('does not rebind a deleted definition through a shared header to another script', () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir,'api.h'),'void target();');
    const index = createWorkspaceIndex();
    const uri = pathToFileURL(path.join(dir,'z.axl')).toString();
    const otherUri = pathToFileURL(path.join(dir,'y.axl')).toString();
    const analysis = index.indexOpenDocument({uri,version:1,text:'#include "api.h"\nvoid target() {}\nvoid callerZ() { target(); }'});
    index.indexOpenDocument({uri:otherUri,version:1,text:'#include "api.h"\nvoid target() {}\nvoid callerY() { target(); }'});
    const item = runAnalysisSteps(api().prepareCallHierarchySteps({analysis,position:{line:1,character:5},workspaceIndex:index}))?.[0];
    assert.ok(item);
    assert.strictEqual(item.uri,uri);
    const edited = index.indexOpenDocument({uri,version:2,text:'#include "api.h"\nvoid callerZ() {}'});
    assert.deepStrictEqual(runAnalysisSteps(api().incomingCallHierarchySteps({analysis:edited,item,workspaceIndex:index})),[]);
  });

  test('unifies qualified static method definitions with their header declarations', () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir,'api.h'),'class C { public: static void target(); };');
    const index = createWorkspaceIndex();
    const uri = pathToFileURL(path.join(dir,'main.axl')).toString();
    const analysis = index.indexOpenDocument({uri,version:1,text:'#include "api.h"\nvoid C::target() {}\nvoid main() { C::target(); }'});
    const item = runAnalysisSteps(api().prepareCallHierarchySteps({analysis,position:{line:1,character:8},workspaceIndex:index}))?.[0];
    assert.ok(item);
    assert.strictEqual(item.uri,uri);
    const incoming = runAnalysisSteps(api().incomingCallHierarchySteps({analysis,item,workspaceIndex:index}));
    assert.deepStrictEqual(incoming.map(call=>call.item.name),['main']);
    const outgoing = runAnalysisSteps(api().outgoingCallHierarchySteps({analysis,item:incoming[0].item,workspaceIndex:index}));
    assert.deepStrictEqual(outgoing.map(call => ({uri:call.item.uri,range:call.item.selectionRange})),
      [{uri,range:item.selectionRange}]);
  });

  test('retains both owners when a macro generates two functions at the same source location', () => {
    const f = fixture('void target() {}\n#define DEF void first() { target(); } void second() { target(); }\nDEF');
    assert.deepStrictEqual(f.incoming(f.prepare('target')).map(c=>c.item.name),['first','second']);
  });

  test('does not attribute a macro-expanded default argument to the file', () => {
    const f = fixture('int helper() { return 1; }\n#define PARAM int aVeryLongParameterNameThatExpandsTheDeclaration\nvoid api(PARAM = helper()) {}');
    assert.deepStrictEqual(f.incoming(f.prepare('helper')),[]);
  });

  test('preserves UTF-16 positions through Japanese comments and CRLF', () => {
    const f = fixture('void target() {}\r\nvoid main() { /* 日本語😀 */ target(); }');
    const calls = f.outgoing(f.prepare('main'));
    assert.deepStrictEqual(calls[0].fromRanges, [{start:{line:1,character:26},end:{line:1,character:32}}]);
  });

  test('adds virtual incoming calls through a non-overriding base while keeping outgoing static', () => {
    const f = fixture('class Base { public: int data; virtual void run(); };\nclass Mid : public Base {};\nclass Derived : public Mid { public: void run() {} };\nvoid caller(Base *value) { value->run(); }');
    const derived = f.prepare('run',1);
    assert.deepStrictEqual(f.incoming(derived).map(c=>c.item.name),['caller']);
    const outgoing = f.outgoing(f.prepare('caller'));
    assert.strictEqual(outgoing.length,1);
    assert.strictEqual(outgoing[0].item.selectionRange.start.line,0);
  });

  test('does not invent a target for an ambiguous direct overload', () => {
    const f = fixture('void target(int value) {}\nvoid target(double value) {}\nvoid main() { target(unknown); }');
    assert.deepStrictEqual(f.outgoing(f.prepare('main')),[]);
  });

  test('includes callable operators and construction in graph navigation', () => {
    const f = fixture('class A { public: int data; A() {} int operator()() { return 1; } };\nvoid main() { A value; value(); }');
    const calls = f.outgoing(f.prepare('main'));
    assert.deepStrictEqual(calls.map(call=>call.item.kind),['constructor','operator']);
    assert.strictEqual(f.prepare('value',1).kind,'operator');
  });

  for (const macro of [
    {definition:'#define REG Register(handler)',body:'REG;',range:{start:{line:3,character:15},end:{line:3,character:18}}},
    {definition:'#define REG(x) Register(x)',body:'REG(handler);',range:{start:{line:3,character:19},end:{line:3,character:26}}},
    {definition:'#define ARG handler',body:'Register(ARG);',range:{start:{line:3,character:24},end:{line:3,character:27}}}
  ]) {
    test(`retains callback references through ${macro.definition}`, () => {
      const f = fixture(`void handler() {}\nvoid Register(void (*cb)()) {}\n${macro.definition}\nvoid setup() { ${macro.body} }`);
      const outgoing = f.outgoing(f.prepare('setup'));
      assert.deepStrictEqual(outgoing.map(call=>call.item.name),['Register','handler']);
      assert.deepStrictEqual(outgoing.find(call=>call.item.name==='handler')!.fromRanges,[macro.range]);
      assert.deepStrictEqual(f.incoming(f.prepare('handler')).map(call=>call.item.name),['setup']);
      const items = runAnalysisSteps(api().prepareCallHierarchySteps({analysis:f.analysis,position:macro.range.start,workspaceIndex:f.index}));
      assert.ok(items?.some(item=>item.name==='handler'));
      assert.deepStrictEqual(f.outgoing(f.prepare('Register')),[]);
    });
  }

  test('keeps callback reference owners distinct in a macro generating two functions', () => {
    const f = fixture('void handler() {}\nvoid Register(void (*cb)()) {}\n#define DEF void first() { Register(handler); } void second() { Register(handler); }\nDEF');
    const incoming = f.incoming(f.prepare('handler'));
    assert.deepStrictEqual(incoming.map(call=>call.item.name),['first','second']);
    for (const call of incoming) {
      assert.deepStrictEqual(call.fromRanges,[{start:{line:3,character:0},end:{line:3,character:3}}]);
      assert.deepStrictEqual(f.outgoing(call.item).map(call=>call.item.name),['Register','handler']);
    }
  });

  test('distinguishes a generated callback token from an identical written argument', () => {
    const f = fixture('void handler() {}\nvoid Register(void (*cb)()) {}\n#define BOTH(x) Register(handler); Register(x)\nvoid setup() { BOTH(handler); }');
    assert.deepStrictEqual(f.outgoing(f.prepare('setup')).find(call=>call.item.name==='handler')?.fromRanges,[
      {start:{line:3,character:15},end:{line:3,character:28}},
      {start:{line:3,character:20},end:{line:3,character:27}}
    ]);
  });

  test('preserves callback argument provenance through nested macros and argument reordering', () => {
    const text = 'void left() {}\nvoid right() {}\nvoid Register(void (*cb)()) {}\n#define INNER(x) Register(x)\n#define SWAP(a,b) INNER(b); INNER(a)\nvoid setup() { SWAP(left,right); }';
    const f = fixture(text);
    const calls = f.outgoing(f.prepare('setup'));
    assert.deepStrictEqual(calls.find(call=>call.item.name==='left')?.fromRanges,[{start:{line:5,character:20},end:{line:5,character:24}}]);
    assert.deepStrictEqual(calls.find(call=>call.item.name==='right')?.fromRanges,[{start:{line:5,character:25},end:{line:5,character:30}}]);
  });

  test('retains virtual ancestry when an intervening class does not override the method', () => {
    const f = fixture('class Base { public: int data; virtual void run() {} };\nclass Gap : public Base {};\nclass Mid : public Gap { public: void run() {} };\nclass Derived : public Mid { public: void run() {} };\nvoid caller(Base *value) { value->run(); }');
    assert.deepStrictEqual(f.incoming(f.prepare('run',2)).map(call=>call.item.name),['caller']);
  });
});
