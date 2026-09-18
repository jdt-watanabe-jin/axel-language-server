import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getDefinitions } from '../../../analyzer/navigation';
import { getInlayHints } from '../../../analyzer/inlayHints';
import { positionFromOffset } from '../../support/source';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('parameter inlay hints analyzer', () => {
  const {createWorkspaceIndex,createTempDir} = useWorkspaceFixtures();
  const whole = {start:{line:0,character:0},end:{line:10000,character:0}};
  function hints(text: string, suppress = true) {
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({uri:'file:///inlay.axl',version:1,text});
    return getInlayHints({analysis,text,range:whole,workspaceIndex:index,suppressWhenArgumentContainsName:suppress});
  }
  test('places named fixed parameters before expressions, including nested calls and inherited methods', () => {
    const text = 'class Base { int f(int count) {} }; class Child : public Base {}; int outer(int value) {} void main(){ Child c; outer(c.f(10)); }';
    assert.deepStrictEqual(hints(text), [
      {position:positionFromOffset(text,text.indexOf('c.f(10)')),label:'value:'},
      {position:positionFromOffset(text,text.indexOf('10')),label:'count:'}
    ]);
  });
  for (const arg of ['count','itemCount','COUNT','discount','count + 1','"count"','/* count: */ 10','10 /* count */']) {
    test('suppresses source argument containing name: ' + arg, () => {
      const text = 'void f(int count) {} void main(){f(' + arg + ');}';
      assert.deepStrictEqual(hints(text), []);
      assert.strictEqual(hints(text,false).length,1);
    });
  }
  test('shows arguments without the name and uses source spelling of strings', () => {
    assert.strictEqual(hints('void f(int count) {} void main(){ f(10); f(size); f("c\\x6funt"); }').length,3);
  });
  test('assigns comments only within direct comma boundaries', () => {
    const text = 'void f(int count, int size) {} void main(){ f(/* count, */ 1, 2 /* count */); f(3 /* size */, /* size */ 4); }';
    assert.deepStrictEqual(hints(text).map(h=>h.label),['size:','count:']);
  });
  test('keeps nested commas, comment commas and string commas inside their argument', () => {
    const text = 'int g(int n, int m) {} void f(string label, int count) {} void main(){ f("x,y", g(1, 2) /* count, */); }';
    assert.deepStrictEqual(hints(text).map(h=>h.label),['label:','n:','m:']);
  });
  test('preserves UTF16 positions across multiline and non-ASCII text', () => {
    const text = 'void f(string label, int count) {}\nvoid main(){ f("日本語😀",\n /* note */ 10); }';
    assert.deepStrictEqual(hints(text).map(h=>h.position),[
      positionFromOffset(text,text.indexOf('"日本語')),positionFromOffset(text,text.indexOf('10'))
    ]);
  });
  test('omits unnamed and variadic arguments, omitted defaults, and unresolved callees', () => {
    const text = 'void f(int, int count, ...); void g(int first, int next = 0); void main(){ f(1,2,3,4); g(5); missing(6); }';
    assert.deepStrictEqual(hints(text).map(h=>h.label),['count:','first:']);
  });
  test('omits calls without a matching complete arity', () => {
    assert.deepStrictEqual(hints('void f(int count);void g(int count,int size);void main(){f(1,2);g(1);}'),[]);
  });
  test('ignores inactive branches and safely handles incomplete calls', () => {
    const text = 'void f(int count, int size) {}\n#if 0\nvoid inactive(){f(1,2);}\n#endif\nvoid main(){ f(3,';
    assert.deepStrictEqual(hints(text),[]);
    assert.deepStrictEqual(hints('void f(int count, int size) {} void main(){f(3;}').map(h=>h.label),['count:']);
    assert.deepStrictEqual(hints('void f(int count, int size) {} void main(){f(3,);}').map(h=>h.label),['count:']);
    assert.deepStrictEqual(hints('void f(int count, int size) {} void main(){ f(, 2); }'),[]);
  });
  test('uses all ordinary partial arity candidates and keeps complete identity unchanged', () => {
    const declarations = 'void f(int left);void f(int right,int size);';
    assert.deepStrictEqual(hints(declarations + 'void main(){f(1;}'),[]);
    assert.deepStrictEqual(hints(declarations + 'void main(){f(1,);}'),[]);
    assert.deepStrictEqual(hints(declarations + 'void main(){f(1);}').map(h=>h.label),['left:']);
    assert.deepStrictEqual(hints('void f(int count);void f(int count,int size);void main(){f(1;}').map(h=>h.label),['count:']);
  });
  test('does not attach comments after an unfinished comma to the preceding argument', () => {
    assert.deepStrictEqual(hints('void f(int count,int size);void main(){f(1, /* count */);}').map(h=>h.label),['count:']);
  });
  test('uses UTF16 columns after non-ASCII characters on the same line with CRLF', () => {
    const text = 'void f(string label,int count);\r\nvoid main(){f("日本語😀",10);}';
    assert.deepStrictEqual(hints(text).map(h=>h.position),[
      positionFromOffset(text,text.indexOf('"日本語')),positionFromOffset(text,text.indexOf('10'))
    ]);
  });
  test('filters on argument positions even when callee precedes the request range', () => {
    const text = 'void f(int count,int size) {}\nvoid main(){f(1,\n2);}';
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({uri:'file:///range.axl',version:1,text});
    const position = positionFromOffset(text,text.indexOf('2)'));
    const result = getInlayHints({analysis,text,workspaceIndex:index,range:{start:position,end:{...position,character:position.character+1}},suppressWhenArgumentContainsName:true});
    assert.deepStrictEqual(result,[{position,label:'size:'}]);
  });
  test('resolves included declarations and invalidates names after dependency changes', () => {
    const root = createTempDir();
    const header = path.join(root,'api.h');
    fs.writeFileSync(header,'void f(int count);');
    const index = createWorkspaceIndex();
    const text = '#include "api.h"\nvoid main(){f(1);}';
    const input = {uri:pathToFileURL(path.join(root,'main.axl')).toString(),version:1,text};
    const get = () => getInlayHints({analysis:index.indexOpenDocument(input),text,range:whole,workspaceIndex:index,suppressWhenArgumentContainsName:true});
    assert.deepStrictEqual(get().map(h=>h.label),['count:']);
    fs.writeFileSync(header,'void f(int size);');
    index.invalidateUri(pathToFileURL(header).toString());
    assert.deepStrictEqual(get().map(h=>h.label),['size:']);
  });
  test('uses typed builtin overloads, arity, unknown candidates and exact name consensus', () => {
    const root = createTempDir();
    const header = path.join(root,'api.h');
    fs.writeFileSync(header,[
      'class string {public:int data;};',
      'int find(int id); int find(string value);',
      'int same(int count, int left); int same(string count, int right);',
      'int casing(int Count); int casing(string count);',
      'int arity(int one); int arity(int one,int two);',
      'int var(int fixed, ...);',
      'int mixed(int common,...); int mixed(int common,int second);',
      'class Api {public:int lookup(int id); int lookup(string value);};'
    ].join('\n'));
    fs.writeFileSync(path.join(root,'api.analysis.json'),JSON.stringify({schemaVersion:1,profile:'axel-510',declarationFiles:['api.h'],types:{string:'api.h',Api:'api.h'},analysisOnlyMacros:[]}));
    const index = createWorkspaceIndex({forcedIncludeFiles:[header]});
    const text = 'void main(){int n; string s; find(/* count */ 1);find("x");find(n+1);find(s);find(unknown);same(unknown,unknown);casing(unknown);arity(1,2);var(1,2,3);mixed(unknown,2);Api api;api.lookup(1);api.lookup("x");}';
    const analysis = index.indexOpenDocument({uri:pathToFileURL(path.join(root,'main.axl')).toString(),version:1,text});
    const result = getInlayHints({analysis,text,range:whole,workspaceIndex:index,suppressWhenArgumentContainsName:false});
    assert.deepStrictEqual(result.map(h=>h.label),['id:','value:','id:','value:','count:','one:','two:','fixed:','common:','id:','value:']);
  });
  test('comments do not select a different ordinary arity or poison nested builtin types', () => {
    const ordinary = 'void f(int one); void f(int wrong,int other); void main(){ f(/* comment */ 1); }';
    assert.deepStrictEqual(hints(ordinary).map(h=>h.label),['one:']);
    const ordinaryIndex = createWorkspaceIndex();
    const ordinaryAnalysis = ordinaryIndex.indexOpenDocument({uri:'file:///ordinary.axl',version:1,text:ordinary});
    const definitions = getDefinitions({analysis:ordinaryAnalysis,position:positionFromOffset(ordinary,ordinary.lastIndexOf('f(')),workspaceIndex:ordinaryIndex});
    assert.deepStrictEqual(definitions.map(item=>item.range.start),[positionFromOffset(ordinary,ordinary.indexOf('f('))]);
    const root = createTempDir();
    const header = path.join(root,'api.h');
    fs.writeFileSync(header,'class string {public:int data;}; int convert(int raw); int f(int count); int f(string text);');
    fs.writeFileSync(path.join(root,'api.analysis.json'),JSON.stringify({schemaVersion:1,profile:'axel-510',declarationFiles:['api.h'],types:{string:'api.h'},analysisOnlyMacros:[]}));
    const index = createWorkspaceIndex({forcedIncludeFiles:[header]});
    const text = 'void main(){ f(convert(/* comment */ 1)); }';
    const analysis = index.indexOpenDocument({uri:pathToFileURL(path.join(root,'main.axl')).toString(),version:1,text});
    assert.deepStrictEqual(getInlayHints({analysis,text,range:whole,workspaceIndex:index,suppressWhenArgumentContainsName:false}).map(h=>h.label),['count:','raw:']);
  });
  test('retains active calls after an initial inactive branch', () => {
    assert.deepStrictEqual(hints('#if 0\nvoid bad(){missing(1);}\n#endif\nvoid f(int count);\nvoid main(){f(2);}')
      .map(h=>h.label),['count:']);
  });
  test('uses original scalar macro arguments and rejects one argument expanded into multiple slots', () => {
    const text = '#define COUNT 10\n#define VALUE "count"\n#define PAIR 1,2\nvoid f(int count,int size);\nvoid main(){f(COUNT,3);f(VALUE,4);f(PAIR);}';
    assert.deepStrictEqual(hints(text).map(h=>h.label),['size:','count:','size:']);
    assert.deepStrictEqual(hints(text,false).map(h=>h.label),['count:','size:','count:','size:']);
  });
  test('retains unique argument origins when transparent and scalar macros are composed', () => {
    const text = '#define ID(x) x\n#define VALUE 1\nvoid f(int count,int size);void main(){ID(f(VALUE,2));}';
    assert.deepStrictEqual(hints(text,false),[
      {position:positionFromOffset(text,text.lastIndexOf('VALUE')),label:'count:'},
      {position:positionFromOffset(text,text.indexOf('2)')),label:'size:'}
    ]);
  });
  test('preserves per-argument comment attribution inside transparent macro expansions', () => {
    const text = '#define ID(x) x\nvoid f(int count,int size);\nvoid main(){ID(f(1,2 /* count */));}';
    assert.deepStrictEqual(hints(text).map(h=>h.label),['count:','size:']);
  });
  test('maps written nested macro arguments once and omits generated ambiguous arguments', () => {
    const text = '#define ID(x) x\n#define TWICE(x) x+x\n#define CALL(x) f(x)\nvoid f(int count) {}\nvoid main(){ ID(f(1)); TWICE(f(2)); CALL(3); }';
    const result = hints(text,false);
    assert.ok(result.some(h=>h.position.character === positionFromOffset(text,text.indexOf('1)')).character));
    const keys = result.map(h=>JSON.stringify(h));
    assert.strictEqual(new Set(keys).size,keys.length);
    assert.ok(result.every(h=>h.position.line === 4));
  });
});
