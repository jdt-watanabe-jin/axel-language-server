import * as typeSyntax from '../../../analyzer/typeChecking/syntax';
import { WorkspaceIndex } from '../../../analyzer/workspaceIndex';
import type { AnalyzeDocumentInput } from '../../../types/analysis';
import * as assert from 'assert';
import { collectTypeDiagnostics } from '../../../analyzer/typeChecking/diagnostics';
import { createAxelParser } from '../../../analyzer/axelParser';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { collectSemanticTokens } from '../../../analyzer/semanticTokens';

suite('DocumentAnalyzer', () => {
  test('reparses assertion macros with stringified expressions without syntax errors', () => {
    const text = [
      '#define TEST_CASE(name) printf("Test case: %s", name);',
      '#define ASSERT_EQ(a,b) if ((a)!=(b)) { printf("%s != %s", #a, #b); return; }',
      'void main() {',
      'TEST_CASE("constructors")',
      '{ int value = 0; ASSERT_EQ(value, 0); }',
      '}'
    ].join('\n');
    const result = new DocumentAnalyzer().analyzeDocument({uri: 'file:///assert.axl', version: 1, text});
    assert.deepStrictEqual(result.diagnostics, []);
    assert.ok(result.typeSnapshot);
  });

  test('releases native syntax views after workspace diagnostics', () => {
    const released: string[] = [];
    class ReleasingAnalyzer extends DocumentAnalyzer {
      public override releaseSyntax(uri: string) {
        released.push(uri);
        super.releaseSyntax(uri);
      }
    }
    const index = new WorkspaceIndex({analyzer: new ReleasingAnalyzer()});
    const input = {uri: 'file:///release.axl', version: 1, text: 'int value;'};
    const result = index.analyzeDocument(input);
    assert.deepStrictEqual(released, [input.uri]);
    assert.strictEqual(index.analyzeDocument(input), result);
    assert.ok(result.typeSnapshot);
  });

  test('builds the type snapshot only for the final macro-expanded source', () => {
    const descriptor=Object.getOwnPropertyDescriptor(typeSyntax,'buildTypeSnapshot')!;
    const build=typeSyntax.buildTypeSnapshot;
    let snapshots=0;
    Object.defineProperty(typeSyntax,'buildTypeSnapshot',{...descriptor,value:(...args:Parameters<typeof build>)=>{
      snapshots++;return build(...args);
    }});
    try {
      const result=new DocumentAnalyzer().analyzeDocument({uri:'file:///snapshot.axl',version:1,text:'#define VALUE 1\nvoid f(){ int value=VALUE; }'});
      assert.ok(result.typeSnapshot);
      assert.strictEqual(snapshots,1);
    } finally { Object.defineProperty(typeSyntax,'buildTypeSnapshot',descriptor); }
  });

  test('uses the foreground analysis when collecting final diagnostics for the same version', () => {
    let dependencies=0;
    class CountingAnalyzer extends DocumentAnalyzer {
      public override analyzeDocument(input:AnalyzeDocumentInput,expand=true,dependenciesOnly=false) {
        if(dependenciesOnly) { dependencies++; }
        return super.analyzeDocument(input,expand,dependenciesOnly);
      }
    }
    const index=new WorkspaceIndex({analyzer:new CountingAnalyzer()});
    const input={uri:'file:///foreground.axl',version:1,text:'void f(){ missing; }'};
    index.analyzeForegroundDocument(input);
    const result=index.indexOpenDocument(input);
    assert.ok(result.diagnostics.some(d=>d.message==="Unknown identifier 'missing'."));
    assert.strictEqual(dependencies,0);
  });

  test('collects dependencies without building a full type snapshot', () => {
    const analyzer=new DocumentAnalyzer();
    const input={uri:'file:///dependency.axl',version:1,text:'#define ENABLED 1\n#include "api.h"\nclass D:GCDialog { GCCheckBox box; }; void f(){ int value=1; }'};
    const dependency=analyzer.analyzeDocument(input,true,true);
    assert.strictEqual(dependency.typeSnapshot,undefined);
    assert.strictEqual(dependency.includes[0].includePath,'api.h');
    assert.strictEqual(dependency.macroDefinitions[0].name,'ENABLED');
    assert.strictEqual(dependency.guiClasses[0].name,'D');
    const full=analyzer.analyzeDocument(input);
    assert.ok(full.typeSnapshot);
    assert.ok(full.declarations.some(d=>d.name==='value'));
  });

  test('reuses syntax when only visible context changes and reparses after an edit', () => {
    const parser=createAxelParser();
    const parse=parser.parse.bind(parser);
    let parses=0;
    Object.defineProperty(parser,'parse',{value:(...args:Parameters<typeof parse>)=>{parses++;return parse(...args);}});
    const analyzer=new DocumentAnalyzer(parser);
    const input={uri:'file:///context.axl',version:1,text:'int value;'};
    analyzer.analyzeDocument(input);
    analyzer.analyzeDocument({...input,knownGuiClassNames:['First']});
    analyzer.analyzeDocument({...input,knownGuiClassNames:['Second']});
    assert.strictEqual(parses,1);
    const edited=analyzer.analyzeDocument({...input,version:2,text:'int edited;'});
    assert.strictEqual(parses,2);
    assert.strictEqual(edited.declarations[0].name,'edited');
    analyzer.clear(input.uri);
    analyzer.analyzeDocument(input);
    assert.strictEqual(parses,3);
  });


  test('reuses cached analysis and refreshes symbols and type diagnostics on edit and clear', () => {
    const analyzer = new DocumentAnalyzer();
    const first = analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: 'void main() { int *pointer = nullptr; }'
    });
    const second = analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: 'void main() { int *pointer = nullptr; }'
    });

    assert.strictEqual(second, first);
    assert.deepStrictEqual(collectTypeDiagnostics({ analysis: first }), []);
    assert.strictEqual(second.symbols[0].name, 'main');
    const updated = analyzer.analyzeDocument({ uri: first.uri, version: 2, text: 'void changed() { int *pointer = 0; }' });
    assert.deepStrictEqual(updated.symbols.map(symbol => symbol.name), ['changed']);
    const diagnostics = collectTypeDiagnostics({ analysis: updated });
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, 'axel.type.initialization');
    const initializer = 'void changed() { int *pointer = 0; }'.indexOf('0');
    assert.deepStrictEqual(diagnostics[0].range, { start: { line: 0, character: initializer }, end: { line: 0, character: initializer + 1 } });
    analyzer.clear(first.uri);
    const cleared = analyzer.analyzeDocument({ uri: first.uri, version: 2, text: 'void changed() { int *pointer = nullptr; }' });
    assert.deepStrictEqual(collectTypeDiagnostics({ analysis: cleared }), []);
  });

  test('uses indirect same-document GUI classes for parts and declarations', () => {
    const analyzer = new DocumentAnalyzer();
    const result = analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: [
        'class CustomWidget : public GCWidget {};',
        'class ReusableWidget : public CustomWidget {};',
        'class MyDialog : public GCDialog { CustomWidget custom; ReusableWidget reusable; };'
      ].join('\n')
    });

    const dialog = result.guiClasses.find((guiClass) => guiClass.name === 'MyDialog');
    assert.ok(dialog !== undefined);
    assert.deepStrictEqual(dialog.parts.map((part) => ({
      name: part.name,
      typeName: part.typeName,
      path: part.path
    })), [{
      name: 'custom', typeName: 'CustomWidget', path: ['custom']
    }, {
      name: 'reusable',
      typeName: 'ReusableWidget',
      path: ['reusable']
    }]);

    assert.ok(result.declarations.some((declaration) => (
      declaration.name === 'reusable'
      && declaration.detail === 'ReusableWidget reusable'
      && declaration.containerName === 'MyDialog'
    )));
  });

  test('excludes inactive preprocessor regions from language features', () => {
    const lines = [
      '#if 0',
      'int ;',
      'BROKEN_MACRO(int)',
      'int inactiveValue;',
      '#else',
      'void activeFunction() {}',
      '#endif'
    ];
    const analyzer = new DocumentAnalyzer();
    const result = analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: lines.join('\n')
    });

    assert.deepStrictEqual(result.diagnostics, []);
    assert.deepStrictEqual(result.symbols.map((symbol) => symbol.name), ['activeFunction']);
    assert.deepStrictEqual(result.declarations.map((declaration) => declaration.name), ['activeFunction']);
    assert.ok(result.references.every((reference) => reference.range.start.line !== 3));
    assert.deepStrictEqual(collectSemanticTokens(result).map((token) => token.range.start.line), [5]);
    assert.deepStrictEqual(result.inactiveRanges, [
      { start: { line: 1, character: 0 }, end: { line: 3, character: 18 } }
    ]);
  });

  test('collects macro invocations outside inactive preprocessor regions', () => {
    const analyzer = new DocumentAnalyzer();
    const result = analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: [
        '#if 0',
        'class Inactive { INACTIVE_MACRO(int) };',
        '#else',
        'class Active { ACTIVE_MACRO(int) };',
        '#endif'
      ].join('\n')
    });

    assert.deepStrictEqual(result.macroInvocations.map((invocation) => invocation.name), ['ACTIVE_MACRO']);
    assert.strictEqual(result.diagnostics[0]?.message, 'Syntax error.');
  });

  test('does not use inactive local macro definitions for syntax suppression', () => {
    const analyzer = new DocumentAnalyzer();
    const result = analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: [
        '#if 0',
        '#define DEFINE_FIELD(T) T value;',
        '#endif',
        'class C { DEFINE_FIELD(int) };'
      ].join('\n')
    });

    assert.deepStrictEqual(result.macroDefinitions, []);
    assert.strictEqual(result.diagnostics[0]?.message, 'Syntax error.');
  });

  test('keeps syntax errors for macro invocations before local definitions', () => {
    const analyzer = new DocumentAnalyzer();
    const result = analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: [
        'class C { FIELD(int) };',
        '#define FIELD(T) T value;'
      ].join('\n')
    });

    assert.deepStrictEqual(result.diagnostics.map((diagnostic) => diagnostic.message), [
      'Syntax error.'
    ]);
  });

  test('invalidates cached diagnostics when macro parameter labels change', () => {
    const analyzer = new DocumentAnalyzer();
    const macro = {
      name: 'FIELD',
      uri: 'file:///macros.h',
      range: zeroRange(),
      selectionRange: zeroRange(),
      detail: '#define FIELD(T) T value;',
      parameters: [{ label: 'T' }],
      replacementText: 'T value;'
    };
    const input = {
      uri: 'file:///main.axl',
      version: 1,
      text: 'class C { FIELD(foo()) };'
    };
    const first = analyzer.analyzeDocument({
      ...input,
      macroDefinitions: [macro]
    });
    const second = analyzer.analyzeDocument({
      ...input,
      macroDefinitions: [{
        ...macro,
        parameters: [{ label: 'U' }]
      }]
    });

    assert.ok(first.diagnostics.length > 0);
    assert.deepStrictEqual(second.diagnostics, []);
  });
});

function zeroRange() {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 }
  };
}
