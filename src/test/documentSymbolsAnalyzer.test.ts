import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createAxelParser } from '../analyzer/axelParser';
import { collectDocumentSymbols } from '../analyzer/documentSymbols';
import { DocumentAnalyzer } from '../analyzer/documentAnalyzer';
import type { AnalysisSymbol } from '../types/analysis';

suite('collectDocumentSymbols', () => {
  test('extracts function, object, typedef, and type symbols', () => {
    const parser = createAxelParser();
    const tree = parser.parse([
      '#define N 100',
      'typedef int Count;',
      'int value;',
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
    assert.ok(names.includes('function:main'));
    assert.ok(names.includes('class:Widget'));
    assert.ok(names.includes('struct:Point'));
    assert.ok(names.includes('union:Payload'));
    assert.ok(names.includes('enum:Mode'));
    assert.ok(names.includes('macro:N'));
  });

  test('adds enum members as children of enum symbols', () => {
    const parser = createAxelParser();
    const tree = parser.parse('enum Mode { A, B = 2 };');

    const symbols = collectDocumentSymbols(tree.rootNode);

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
      '  int IsNull();',
      '  string Mid(int cpos, int clen);',
      '};'
    ].join('\n'));

    const symbols = collectDocumentSymbols(tree.rootNode);

    assert.deepStrictEqual(symbols.map(symbolSummary), [{
      name: 'string',
      kind: 'class',
      children: [
        { name: 'Length', kind: 'method' },
        { name: 'IsNull', kind: 'method' },
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
    const parser = createAxelParser();
    const tree = parser.parse([
      'class string {',
      'public:',
      '  enum {',
      '    NoCase = 1 << 0,',
      '    Reverse = 1 << 1,',
      '  };',
      '};'
    ].join('\n'));

    const symbols = collectDocumentSymbols(tree.rootNode);

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

  test('outlines GUI parts from the regression fixture', () => {
    const analyzer = new DocumentAnalyzer();
    const fixturePath = path.resolve(__dirname, '..', '..', 'src', 'test', 'fixtures', 'hover-regression.axl');
    const analysis = analyzer.analyzeDocument({
      uri: `file:///${fixturePath.replace(/\\/g, '/')}`,
      version: 1,
      text: fs.readFileSync(fixturePath, 'utf8')
    });

    const dialog = analysis.symbols.find((symbol) => symbol.name === 'mydialog');

    assert.deepStrictEqual(dialog?.children?.map(symbolSummary), [
      { name: 'One', kind: 'field' },
      { name: 'Two', kind: 'field' },
      {
        name: 'Check1',
        kind: 'field',
        children: [
          { name: 'OnCreate', kind: 'method' }
        ]
      },
      {
        name: 'box',
        kind: 'field',
        children: [
          { name: 'Two', kind: 'field' }
        ]
      },
      { name: 'OnCreate', kind: 'method' }
    ]);
  });

  test('extracts macro document symbols', () => {
    const parser = createAxelParser();
    const tree = parser.parse([
      '#define N 100',
      '#define MAX(a, b) ((a) > (b) ? (a) : (b))'
    ].join('\n'));

    const symbols = collectDocumentSymbols(tree.rootNode);

    assert.deepStrictEqual(symbols.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      detail: symbol.detail
    })), [
      { name: 'N', kind: 'macro', detail: '#define N 100' },
      { name: 'MAX', kind: 'macro', detail: '#define MAX(a, b) ((a) > (b) ? (a) : (b))' }
    ]);
  });

  test('uses name range as selection range', () => {
    const parser = createAxelParser();
    const tree = parser.parse('void main() {}');
    const symbols = collectDocumentSymbols(tree.rootNode);

    assert.strictEqual(symbols[0].name, 'main');
    assert.deepStrictEqual(symbols[0].selectionRange.start, { line: 0, character: 5 });
    assert.deepStrictEqual(symbols[0].selectionRange.end, { line: 0, character: 9 });
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
