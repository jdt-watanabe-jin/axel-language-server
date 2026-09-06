import * as assert from 'assert';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { collectSemanticTokens } from '../../../analyzer/semanticTokens';

suite('DocumentAnalyzer', () => {
  test('analyzes diagnostics and symbols for a document', () => {
    const analyzer = new DocumentAnalyzer();
    const result = analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: 'void main() {}'
    });

    assert.strictEqual(result.uri, 'file:///main.axl');
    assert.strictEqual(result.version, 1);
    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.symbols[0].name, 'main');
  });

  test('returns cached analysis for the same uri and version', () => {
    const analyzer = new DocumentAnalyzer();
    const first = analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: 'void main() {}'
    });
    const second = analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: 'void changed() {}'
    });

    assert.strictEqual(second, first);
    assert.strictEqual(second.symbols[0].name, 'main');
  });

  test('reanalyzes when document version changes', () => {
    const analyzer = new DocumentAnalyzer();
    analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: 'void main() {}'
    });
    const second = analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 2,
      text: 'void changed() {}'
    });

    assert.strictEqual(second.symbols[0].name, 'changed');
  });

  test('composes declaration and type-reference analysis', () => {
    const analyzer = new DocumentAnalyzer();
    const result = analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: 'Widget value;'
    });

    assert.deepStrictEqual(
      result.declarations.map((declaration) => `${declaration.kind}:${declaration.name}`),
      ['variable:value']
    );
    assert.strictEqual(result.references[0].name, 'Widget');
  });

  test('includes GUI class analysis in document results', () => {
    const analyzer = new DocumentAnalyzer();
    const result = analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: 'class MyDialog : public GCDialog { GCText input; };'
    });

    assert.deepStrictEqual(result.guiClasses.map((guiClass) => ({
      name: guiClass.name,
      baseName: guiClass.baseName,
      kind: guiClass.kind,
      parts: guiClass.parts.map((part) => ({
        name: part.name,
        typeName: part.typeName,
        path: part.path
      }))
    })), [{
      name: 'MyDialog',
      baseName: 'GCDialog',
      kind: 'dialog',
      parts: [{
        name: 'input',
        typeName: 'GCText',
        path: ['input']
      }]
    }]);
  });

  test('uses same-document GUI classes when extracting reusable part instances', () => {
    const analyzer = new DocumentAnalyzer();
    const result = analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: [
        'class CustomWidget : public GCWidget {};',
        'class MyDialog : public GCDialog { CustomWidget custom; };'
      ].join('\n')
    });

    const dialog = result.guiClasses.find((guiClass) => guiClass.name === 'MyDialog');
    assert.ok(dialog !== undefined);
    assert.deepStrictEqual(dialog.parts.map((part) => ({
      name: part.name,
      typeName: part.typeName,
      path: part.path
    })), [{
      name: 'custom',
      typeName: 'CustomWidget',
      path: ['custom']
    }]);
  });

  test('uses indirect same-document GUI classes for parts and declarations', () => {
    const analyzer = new DocumentAnalyzer();
    const result = analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: [
        'class CustomWidget : public GCWidget {};',
        'class ReusableWidget : public CustomWidget {};',
        'class MyDialog : public GCDialog { ReusableWidget reusable; };'
      ].join('\n')
    });

    const dialog = result.guiClasses.find((guiClass) => guiClass.name === 'MyDialog');
    assert.ok(dialog !== undefined);
    assert.deepStrictEqual(dialog.parts.map((part) => ({
      name: part.name,
      typeName: part.typeName,
      path: part.path
    })), [{
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

  test('emits timing logs when logger is provided', () => {
    const entries: string[] = [];
    const analyzer = new DocumentAnalyzer(undefined, {
      info: (message) => entries.push(message),
      error: () => undefined
    });

    analyzer.analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: 'int value;'
    });

    assert.ok(entries.some((entry) => (
      entry.includes('operation=document.analyze')
      && entry.includes('uri=file:///main.axl')
      && /durationMs=\d+/.test(entry)
    )));
  });
});

function zeroRange() {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 }
  };
}
