import * as assert from 'assert';
import { collectTypeDiagnostics } from '../../../analyzer/typeChecking/diagnostics';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { collectSemanticTokens } from '../../../analyzer/semanticTokens';

suite('DocumentAnalyzer', () => {

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
