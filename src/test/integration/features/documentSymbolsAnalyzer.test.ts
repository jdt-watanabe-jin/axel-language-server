import * as assert from 'assert';
import { createAxelParser } from '../../../analyzer/axelParser';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { collectDocumentSymbols } from '../../../analyzer/documentSymbols';
import { SymbolKind } from 'vscode-languageserver/node';
import { toLspDocumentSymbol } from '../../../lsp/documentSymbols';
import type { AnalysisSymbol } from '../../../types/analysis';

suite('collectDocumentSymbols', () => {

  test('nests external methods and preserves overloads, declarations and navigation', () => {
    const text = [
      'class Version { static Version makeVersion(int value); };',
      'static Version Version::makeVersion(int value) { Version v; return v; }',
      'static Version Version::makeVersion() { Version v; return v; }',
      'void unrelated() {}'
    ].join('\n');
    const tree = createAxelParser().parse(text);
    assert.strictEqual(tree.rootNode.hasError, false);
    const symbols = collectDocumentSymbols(tree.rootNode).map(toLspDocumentSymbol);
    assert.deepStrictEqual(symbols.map(s => s.name), ['Version', 'unrelated']);
    const methods = symbols[0].children!;
    assert.deepStrictEqual(methods.map(s => [s.name, s.kind]), [
      ['makeVersion', SymbolKind.Method], ['makeVersion', SymbolKind.Method], ['makeVersion', SymbolKind.Method]
    ]);
    assert.deepStrictEqual(methods.map(s => s.selectionRange.start.line), [0, 1, 2]);
    assert.strictEqual(methods[1].selectionRange.start.character, text.split('\n')[1].indexOf('makeVersion'));
    assert.match(methods[1].detail!, /\(int value\)/);
    assert.match(methods[2].detail!, /\(\)/);
    assert.strictEqual(symbols[0].range.end.line, 0);
  });

  test('classifies inline and external constructors and external operators', () => {
    const tree = createAxelParser().parse([
      'class Version { Version(int value) {} };',
      'Version::Version() {}',
      'bool Version::operator==(Version other) { return 1; }'
    ].join('\n'));
    assert.strictEqual(tree.rootNode.hasError, false);
    const symbols = collectDocumentSymbols(tree.rootNode).map(toLspDocumentSymbol);
    assert.strictEqual(symbols.length, 1);
    assert.deepStrictEqual(symbols[0].children!.map(s => [s.name, s.kind]), [
      ['Version', SymbolKind.Constructor], ['Version', SymbolKind.Constructor], ['operator==', SymbolKind.Operator]
    ]);
  });

  test('keeps qualified names for methods whose class is absent', () => {
    const tree = createAxelParser().parse('Version::Version() {}\nvoid Version::reset() {}\nvoid freeFunction() {}');
    assert.strictEqual(tree.rootNode.hasError, false);
    assert.deepStrictEqual(collectDocumentSymbols(tree.rootNode).map(toLspDocumentSymbol).map(s => [s.name, s.kind]), [
      ['Version::Version', SymbolKind.Constructor], ['Version::reset', SymbolKind.Method], ['freeFunction', SymbolKind.Function]
    ]);
  });

  test('preserves the complete destructor name and selection range', () => {
    const tree = createAxelParser().parse('class Version {};\nVersion::~Version() {}');
    assert.strictEqual(tree.rootNode.hasError, false);
    const method = collectDocumentSymbols(tree.rootNode)[0].children![0];
    assert.strictEqual(method.name, '~Version');
    assert.strictEqual(method.kind, 'method');
    assert.deepStrictEqual(method.selectionRange, {
      start: { line: 1, character: 9 }, end: { line: 1, character: 17 }
    });
  });

  test('finds the owner even when its definition follows the method', () => {
    const tree = createAxelParser().parse('void Version::reset() {}\nclass Version {};');
    const symbols = collectDocumentSymbols(tree.rootNode);
    assert.strictEqual(symbols.length, 1);
    assert.strictEqual(symbols[0].children![0].name, 'reset');
  });

  test('does not lose active methods when a class is in an inactive branch', () => {
    const analyzer = new DocumentAnalyzer();
    const result = analyzer.analyzeDocument({ uri: 'file:///external.axl', version: 1, text: [
      '#if 0', 'class Version {};', '#endif', 'void Version::reset() {}'
    ].join('\n') });
    assert.deepStrictEqual(result.symbols.map(s => [s.name, s.kind]), [['Version::reset', 'method']]);
  });

  test('does not attach external definitions to ambiguous class names', () => {
    const tree = createAxelParser().parse('class Version {};\nclass Version {};\nvoid Version::reset() {}');
    const symbols = collectDocumentSymbols(tree.rootNode);
    assert.strictEqual(symbols.length, 3);
    assert.strictEqual(symbols[2].kind, 'method');
  });

  test('extracts function, object, typedef, and type symbols', () => {
    const parser = createAxelParser();
    const tree = parser.parse([
      '#define N 100',
      '#define MAX(a, b) ((a) > (b) ? (a) : (b))',
      'typedef int Count;',
      'int *value;',
      'void main() {}',
      'class Widget {};',
      'struct Point {};',
      'union Payload {};',
      'enum Mode { A, B };'
    ].join('\n'));

    const symbols = collectDocumentSymbols(tree.rootNode);
    const names = symbols.map((symbol) => `${symbol.kind}:${symbol.name}`);

    assert.ok(names.includes('typedef:Count'));
    assert.ok(names.includes('variable:value'));
    assert.deepStrictEqual(symbols.find(symbol => symbol.name === 'value')?.selectionRange, {
      start: { line: 3, character: 5 }, end: { line: 3, character: 10 }
    });
    assert.ok(names.includes('function:main'));
    assert.ok(names.includes('class:Widget'));
    assert.ok(names.includes('struct:Point'));
    assert.ok(names.includes('union:Payload'));
    assert.ok(names.includes('enum:Mode'));
    assert.ok(names.includes('macro:N'));
    assert.deepStrictEqual(symbols.filter(symbol => symbol.kind === 'macro').map(symbol => symbol.detail), [
      '#define N 100', '#define MAX(a, b) ((a) > (b) ? (a) : (b))'
    ]);
    const main = toLspDocumentSymbol(symbols.find(symbol => symbol.name === 'main')!);
    assert.strictEqual(main.kind, SymbolKind.Function);
    assert.deepStrictEqual(main.range, {
      start: { line: 4, character: 0 }, end: { line: 4, character: 14 }
    });
    assert.deepStrictEqual(main.selectionRange, {
      start: { line: 4, character: 5 }, end: { line: 4, character: 9 }
    });
  });

  test('adds enum members as children of enum symbols', () => {
    const parser = createAxelParser();
    const tree = parser.parse('enum Mode { A, B = 2 };');

    const symbols = collectDocumentSymbols(tree.rootNode);

    assert.deepStrictEqual(toLspDocumentSymbol(symbols[0]).children?.map(child => child.kind), [SymbolKind.EnumMember, SymbolKind.EnumMember]);
    assert.deepStrictEqual(symbols, [{
      name: 'Mode',
      kind: 'enum',
      detail: 'enum',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 22 }
      },
      selectionRange: {
        start: { line: 0, character: 5 },
        end: { line: 0, character: 9 }
      },
      children: [
        {
          name: 'A',
          kind: 'enumMember',
          detail: 'enum Mode::A',
          range: {
            start: { line: 0, character: 12 },
            end: { line: 0, character: 13 }
          },
          selectionRange: {
            start: { line: 0, character: 12 },
            end: { line: 0, character: 13 }
          }
        },
        {
          name: 'B',
          kind: 'enumMember',
          detail: 'enum Mode::B = 2',
          range: {
            start: { line: 0, character: 15 },
            end: { line: 0, character: 20 }
          },
          selectionRange: {
            start: { line: 0, character: 15 },
            end: { line: 0, character: 16 }
          }
        }
      ]
    }]);
  });

  test('adds class members as nested children', () => {
    const parser = createAxelParser();
    const tree = parser.parse([
      'class Widget {',
      '  int value;',
      '  void Reset() {}',
      '};'
    ].join('\n'));

    const symbols = collectDocumentSymbols(tree.rootNode);

    assert.deepStrictEqual(symbols.map(symbolSummary), [{
      name: 'Widget',
      kind: 'class',
      children: [
        { name: 'value', kind: 'field' },
        { name: 'Reset', kind: 'method' }
      ]
    }]);
  });

  test('adds class method prototypes as nested method symbols', () => {
    const parser = createAxelParser();
    const tree = parser.parse([
      'class string {',
      'public:',
      '  int Length();',
      '  string Mid(int cpos, int clen);',
      '};'
    ].join('\n'));

    const symbols = collectDocumentSymbols(tree.rootNode);

    assert.deepStrictEqual(symbols.map(symbolSummary), [{
      name: 'string',
      kind: 'class',
      children: [
        { name: 'Length', kind: 'method' },
        { name: 'Mid', kind: 'method' }
      ]
    }]);
  });

  test('adds operator prototypes as nested operator symbols', () => {
    const parser = createAxelParser();
    const tree = parser.parse([
      'class FileIter {',
      'public:',
      '  int Next();',
      '  int operator++ ();',
      '  icoord operator + (ipoint);',
      '};'
    ].join('\n'));

    const symbols = collectDocumentSymbols(tree.rootNode);

    assert.deepStrictEqual(symbols.map(symbolSummary), [{
      name: 'FileIter',
      kind: 'class',
      children: [
        { name: 'Next', kind: 'method' },
        { name: 'operator++', kind: 'operator' },
        { name: 'operator +', kind: 'operator' }
      ]
    }]);
  });

  test('adds symbols nested inside preprocessor conditionals', () => {
    const parser = createAxelParser();
    const tree = parser.parse([
      '#ifndef _AXEL_STRING_H',
      '#define _AXEL_STRING_H',
      'class string {',
      'public:',
      '  int Length();',
      '#if __AXEL_INTERNAL__',
      '  int64 GetHash();',
      '#endif',
      '};',
      '#endif'
    ].join('\n'));

    const symbols = collectDocumentSymbols(tree.rootNode);

    assert.deepStrictEqual(symbols.map(symbolSummary), [{
      name: '_AXEL_STRING_H',
      kind: 'macro'
    }, {
      name: 'string',
      kind: 'class',
      children: [
        { name: 'Length', kind: 'method' },
        { name: 'GetHash', kind: 'method' }
      ]
    }]);
  });

  test('adds anonymous enum members without an empty parent symbol', () => {
    const analysis = new DocumentAnalyzer().analyzeDocument({
      uri: 'file:///anonymous-enum.axl', version: 1, text: [
      'class string {',
      'public:',
      '  enum {',
      '    NoCase = 1 << 0,',
      '    Reverse = 1 << 1,',
      '  };',
      '};'
    ].join('\n') });

    assert.deepStrictEqual(analysis.diagnostics, []);
    const symbols = analysis.symbols;

    assert.deepStrictEqual(symbols.map(symbolSummary), [{
      name: 'string',
      kind: 'class',
      children: [
        { name: 'NoCase', kind: 'enumMember' },
        { name: 'Reverse', kind: 'enumMember' }
      ]
    }]);
  });

  test('adds include symbols from preprocessor include nodes', () => {
    const parser = createAxelParser();
    const tree = parser.parse('#include "gui.h"\n#include <system.h>\n');

    const symbols = collectDocumentSymbols(tree.rootNode);

    assert.deepStrictEqual(symbols.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      detail: symbol.detail
    })), [
      { name: 'gui.h', kind: 'include', detail: '#include "gui.h"' },
      { name: 'system.h', kind: 'include', detail: '#include <system.h>' }
    ]);
  });

  test('adds GUI parts and resolved event handlers as nested children', () => {
    const analyzer = new DocumentAnalyzer();
    const analysis = analyzer.analyzeDocument({
      uri: 'file:///dialog.axl',
      version: 1,
      text: [
        'class mydialog : public GCDialog {',
        '  GCVBoxLayout {',
        '    GCCheckBox One;',
        '    GCCheckBox Two;',
        '    GCGroupBox box {',
        '      GCCheckBox Two;',
        '    };',
        '    GCControlButton ctlBtn { OnCreate() {} };',
        '  };',
        '};',
        'void mydialog::box.Two::OnChanged() {}'
      ].join('\n')
    });

    assert.deepStrictEqual(analysis.symbols.map(symbolSummary), [{
      name: 'mydialog',
      kind: 'class',
      children: [
        { name: 'One', kind: 'field' },
        { name: 'Two', kind: 'field' },
        {
          name: 'box',
          kind: 'field',
          children: [
            {
              name: 'Two',
              kind: 'field',
              children: [
                { name: 'OnChanged', kind: 'method' }
              ]
            }
          ]
        },
        {
          name: 'ctlBtn',
          kind: 'field',
          children: [
            { name: 'OnCreate', kind: 'method' }
          ]
        }
      ]
    }]);
  });

});

function symbolSummary(symbol: Pick<AnalysisSymbol, 'name' | 'kind' | 'children'>): {
  name: string;
  kind: string;
  children?: ReturnType<typeof symbolSummary>[];
} {
  return {
    name: symbol.name,
    kind: symbol.kind,
    ...(symbol.children === undefined ? {} : { children: symbol.children.map(symbolSummary) })
  };
}
