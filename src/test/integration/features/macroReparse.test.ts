import { mock } from 'node:test';
import * as diagnostics from '../../../analyzer/diagnostics';
import * as scopeIndex from '../../../analyzer/scopeIndex';
import * as documentSymbols from '../../../analyzer/documentSymbols';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { getDefinitions, getReferences } from '../../../analyzer/navigation';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('General macro reparsing', () => {
  const fixtures = useWorkspaceFixtures();
  for (const newline of ['\n', '\r\n']) {
    test(`resolves GUI receivers and local scopes inside included macros ${JSON.stringify(newline)}`, async () => {
      const directory = fixtures.createTempDir();
      fs.writeFileSync(path.join(directory, 'parts.h'), [
        'class GCWidget { int value; void SetValue(int n) {} };',
        'class GCLabel : public GCWidget { int text; };',
        'class GCPushButton : public GCWidget { int pixmap; };',
        '#define PARTS GCLabel { OnCreate() { text=1; int local; local=2; } }; \\',
        'GCPushButton { OnCreate() { pixmap=1; int local; local=2; SetValue(local); } OnPush(int command) { SetValue(command); } };'
      ].join(newline));
      const index = fixtures.createWorkspaceIndex();
      const input = {uri:pathToFileURL(path.join(directory,'main.axl')).toString(),version:1,
        text:'#include "parts.h"\nclass Dialog : public GCDialog {\n PARTS\n};'};
      index.indexOpenDocument(input);
      await index.waitForBackgroundIndexing();
      assert.deepStrictEqual(index.indexOpenDocument(input).diagnostics, []);
    });
  }
  test('checks expanded scopes before mapping real errors to the macro invocation', () => {
    const analysis = check([
      'class GCText { int value; void SetValue(int n) {} };',
      '#define PARTS GCText { OnCreate() { int local; local=1; } }; GCText { OnCreate() { local=1; value=this; SetValue(this); Missing(); } };',
      'class Dialog : public GCDialog {',
      ' PARTS',
      '};'
    ].join('\n'));
    assert.deepStrictEqual(analysis.diagnostics.map(d=>d.message).filter(m=>m.startsWith('Unknown')).sort(),
      ["Unknown identifier 'Missing'.", "Unknown identifier 'local'."]);
    assert.deepStrictEqual(analysis.diagnostics.filter(d=>d.code).map(d=>d.code).sort(),
      ['axel.type.argument_type','axel.type.assignment']);
    assert.ok(analysis.diagnostics.every(d=>d.range.start.line===3 && d.range.start.character===1 && d.range.end.character===6));
  });
  test('evaluates __LINE__ at the written position after a multiline macro call', () => {
    const analysis = check('#define ID(x) x\nint x = ID(\n 1\n);\nint a[1 / (__LINE__ - 5)];');
    assert.ok(analysis.diagnostics.some(d => d.code === 'axel.type.constant_expression'), JSON.stringify(analysis.diagnostics));
    assert.deepStrictEqual(check('#define ID(x) x\nint x = ID(\n 1\n);\nint a[2 / (__LINE__ - 3)];').diagnostics, []);
  });
  for (const expand of [true, false]) {
    test(`builds final metadata once with macro expansion ${expand}`, () => {
      const spies = [mock.method(diagnostics, 'collectSyntaxDiagnostics'),
        mock.method(scopeIndex, 'buildScopeIndex'), mock.method(documentSymbols, 'collectDocumentSymbols')];
      try {
        const analyzer = new DocumentAnalyzer();
        const input = {uri:'file:///metadata.axl',version:1,
          text:'#define VALUE 1\nvoid main(){ int answer = ' + (expand ? 'VALUE' : '0') + '; }'};
        const analysis = analyzer.analyzeDocument(input);
        assert.strictEqual(analysis.expandedMacroReferences?.length ?? 0, expand ? 1 : 0);
        for (const spy of spies) { assert.strictEqual(spy.mock.callCount(), 1); }
        assert.deepStrictEqual(analysis.diagnostics, []);
        assert.ok(analysis.symbols.some(symbol => symbol.name === 'main'));
        assert.ok(analysis.scopes.length > 1);
        assert.ok(Object.values(Object.getOwnPropertyDescriptors(analysis)).every(property => !property.get));
        const snapshot = JSON.stringify(analysis);
        analyzer.releaseSyntax(input.uri);
        assert.strictEqual(analyzer.analyzeDocument(input), analysis);
        assert.strictEqual(JSON.stringify(analysis), snapshot);
      } finally { for (const spy of spies) { spy.mock.restore(); } }
    });
  }

  function check(text: string) {
    return fixtures.createWorkspaceIndex().analyzeDocument({uri:'file:///macros.axl',version:1,text});
  }
  for (const newline of ['\n', '\r\n']) {
    for (const prefix of ['', '  ', newline, newline + newline + '  ']) {
      test(`preserves source positions with leading whitespace ${JSON.stringify({newline, prefix})}`, () => {
        const text = prefix + ['#define DEBUG if(0)', '', '',
          'void main(){ int value; DEBUG { value = 1; } }', ''].join(newline);
        const analysis = check(text);
        const lines = text.split('\n');
        const mainLine = lines.findIndex(line => line.startsWith('void main'));
        assert.deepStrictEqual(analysis.diagnostics, []);
        assert.strictEqual(analysis.expandedMacroReferences?.length, 1);
        assert.deepStrictEqual(analysis.declarations.find(d => d.name === 'main')?.selectionRange,
          {start:{line:mainLine, character:5}, end:{line:mainLine, character:9}});
        for (const declaration of analysis.declarations) {
          const range = declaration.selectionRange;
          assert.strictEqual(lines[range.start.line].slice(range.start.character, range.end.character), declaration.name);
        }
        for (const reference of analysis.navigationReferences ?? []) {
          const range = reference.range;
          assert.strictEqual(lines[range.start.line].slice(range.start.character, range.end.character), reference.name);
        }
      });
    }
  }
  test('reparses conditional prefixes before member calls', () => {
    const a = check('#define DEBUG if(0)\nclass Date { int x; void Now(){} }; void f(Date dat){ DEBUG dat.Now(); }');
    assert.deepStrictEqual(a.diagnostics, []);
    assert.ok(!a.declarations.some(d => d.name === 'Now' && d.containerName === 'f'));
  });
  test('reparses prefixes even when the original tree has no syntax error', () => {
    const a = check('#define DEBUG if(0)\nvoid ping(){} void f(){ DEBUG ping(); }');
    assert.deepStrictEqual(a.diagnostics, []);
    assert.strictEqual(a.declarations.filter(d => d.name === 'ping').length, 1);
  });
  test('indexes declarations generated by object macros', () => {
    const a = check('#define DECL int value;\nDECL\nvoid f(){ value = 1; }');
    assert.deepStrictEqual(a.diagnostics, []);
    assert.ok(a.declarations.some(d => d.name === 'value'));
  });
  test('indexes declarations generated by function macros', () => {
    const a = check('#define DECL(name) int name;\nDECL(value)\nvoid f(){ value = 1; }');
    assert.deepStrictEqual(a.diagnostics, []);
    assert.ok(a.declarations.some(d => d.name === 'value'));
  });
  test('reports invalid syntax introduced by expansion at its invocation', () => {
    const a = check('#define BAD )\nvoid f(){ BAD; }');
    assert.ok(a.diagnostics.some(d => d.message === 'Syntax error.' && d.range.start.line === 1));
  });
  test('honors undef and redefinition at each use', () => {
    const a = check('#define DECL int first;\nDECL\n#undef DECL\n#define DECL int second;\nDECL\nvoid f(){ first=1; second=2; }');
    assert.deepStrictEqual(a.diagnostics, []);
    assert.ok(a.declarations.some(d => d.name === 'first'));
    assert.ok(a.declarations.some(d => d.name === 'second'));
  });
  test('expands aliases of function macros', () => {
    const a = check('#define DECL(name) int name;\n#define ALIAS DECL\nALIAS(value)\nvoid f(){ value=1; }');
    assert.deepStrictEqual(a.diagnostics, []);
    assert.ok(a.declarations.some(d => d.name === 'value'));
  });
  test('does not substitute inside numeric tokens, strings or comments', () => {
    const a = check('#define xFF )\n#define HEX 0xFF\n#define TOKEN )\nvoid f(){ int value=HEX; string s="TOKEN"; /* TOKEN */ }');
    assert.deepStrictEqual(a.diagnostics, []);
  });
  test('checks missing types introduced by a declaration macro', () => {
    const a = check('#define DECL MissingType value;\nDECL');
    assert.ok(a.diagnostics.some(d => d.message === "Unknown type 'MissingType'." && d.range.start.line === 1));
  });
  test('preserves distinct argument references for navigation and rename', () => {
    const text='#define SUM(x,y) ((x)+(y))\nvoid f(){ int a; int b; int c=SUM(a,b); }';
    const index=fixtures.createWorkspaceIndex();
    const analysis=index.analyzeDocument({uri:'file:///args.axl',version:1,text});
    const b=analysis.declarations.find(d=>d.name==='b')!;
    assert.deepStrictEqual(getDefinitions({analysis,workspaceIndex:index,position:{line:1,character:36}}), [{uri:analysis.uri,range:b.selectionRange}]);
    const a=analysis.declarations.find(d=>d.name==='a')!;
    const refs=getReferences({analysis,workspaceIndex:index,position:a.selectionRange.start,includeDeclaration:false});
    assert.ok(refs.some(r=>r.range.start.line===1 && r.range.start.character===34), JSON.stringify(refs));
  });
  test('keeps imported conditional symbols aligned after multiline expansion', () => {
    const text='#define TWO int a; \\\n int b;\nTWO\n#include "header.axh"\n#if FLAG\nint selected;\n#else\nint other;\n#endif';
    const analysis=new DocumentAnalyzer().analyzeDocument({uri:'file:///branches.axl',version:1,text,
      preprocessorSymbols:[{name:'FLAG',value:'1',sourceRange:{start:{line:3,character:0},end:{line:3,character:21}}}]});
    assert.ok(analysis.declarations.some(d=>d.name==='selected'));
    assert.ok(!analysis.declarations.some(d=>d.name==='other'));
  });
  test('preserves positions following a multiline expansion', () => {
    const a = check('#define DECL int a; \\\nint b;\nvoid f(){ DECL missing; }');
    const d = a.diagnostics.find(d => d.message === "Unknown identifier 'missing'.");
    assert.ok(d, JSON.stringify(a.diagnostics));
    assert.deepStrictEqual(d.range, {start:{line:2,character:15},end:{line:2,character:22}});
  });
});
