import * as assert from 'assert';
import { createAxelParser } from '../analyzer/axelParser';
import { buildSymbolIndex } from '../analyzer/symbolIndex';

suite('buildSymbolIndex', () => {
  const parser = createAxelParser();
  const uri = 'file:///main.axl';

  test('assigns a deterministic declaration ID to a function', () => {
    const index = buildSymbolIndex(parser.parse('void main() {}').rootNode, uri);

    assert.deepStrictEqual(index.declarations, [{
      id: 'file:///main.axl#0:5:main',
      name: 'main',
      kind: 'function',
      uri,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 14 }
      },
      selectionRange: {
        start: { line: 0, character: 5 },
        end: { line: 0, character: 9 }
      },
      detail: 'void main()',
      signature: {
        label: 'void main()',
        parameters: []
      }
    }]);
  });

  test('uses declared type text as variable and parameter detail', () => {
    const index = buildSymbolIndex(parser.parse([
      'class Widget {} item;',
      'int count;',
      'void update(double scale, char code) {}',
      'string label;'
    ].join('\n')).rootNode, uri);

    assert.deepStrictEqual(
      index.declarations.map((declaration) => ({
        name: declaration.name,
        kind: declaration.kind,
        detail: declaration.detail
      })),
      [
        { name: 'item', kind: 'variable', detail: 'Widget item' },
        { name: 'Widget', kind: 'class', detail: 'class' },
        { name: 'count', kind: 'variable', detail: 'int count' },
        { name: 'update', kind: 'function', detail: 'void update(double scale, char code)' },
        { name: 'scale', kind: 'parameter', detail: 'double scale' },
        { name: 'code', kind: 'parameter', detail: 'char code' },
        { name: 'label', kind: 'variable', detail: 'string label' }
      ]
    );
  });

  test('uses signature text as function detail', () => {
    const index = buildSymbolIndex(parser.parse([
      'static string connectionsetting_ResolveTopologyName(string parentCellName, string displayName) {}',
      'int compute(double value) {}',
      'void reset() {}',
      'class Widget {',
      '  static int Create(string name) {}',
      '  void update(int count) {}',
      '};',
      'double Widget::measure(float scale) {}'
    ].join('\n')).rootNode, uri);

    assert.deepStrictEqual(
      index.declarations.filter((declaration) => declaration.kind === 'function').map((declaration) => ({
        name: declaration.name,
        detail: declaration.detail,
        containerName: declaration.containerName
      })),
      [
        {
          name: 'connectionsetting_ResolveTopologyName',
          detail: 'static string connectionsetting_ResolveTopologyName(string parentCellName, string displayName)',
          containerName: undefined
        },
        { name: 'compute', detail: 'int compute(double value)', containerName: undefined },
        { name: 'reset', detail: 'void reset()', containerName: undefined },
        { name: 'Create', detail: 'static int Create(string name)', containerName: 'Widget' },
        { name: 'update', detail: 'void update(int count)', containerName: 'Widget' },
        { name: 'measure', detail: 'double Widget::measure(float scale)', containerName: 'Widget' }
      ]
    );
  });

  test('indexes function prototypes as functions', () => {
    const index = buildSymbolIndex(parser.parse([
      'class string {',
      'public:',
      '  int Length();',
      '  int IsNull();',
      '  string Mid(int cpos, int clen);',
      '};'
    ].join('\n')).rootNode, uri);

    assert.deepStrictEqual(
      index.declarations.filter((declaration) => ['Length', 'IsNull', 'Mid'].includes(declaration.name)).map((declaration) => ({
        name: declaration.name,
        kind: declaration.kind,
        detail: declaration.detail,
        containerName: declaration.containerName
      })),
      [
        { name: 'Length', kind: 'function', detail: 'int Length()', containerName: 'string' },
        { name: 'IsNull', kind: 'function', detail: 'int IsNull()', containerName: 'string' },
        { name: 'Mid', kind: 'function', detail: 'string Mid(int cpos, int clen)', containerName: 'string' }
      ]
    );
  });

  test('indexes spaced operator prototypes as functions', () => {
    const index = buildSymbolIndex(parser.parse([
      'class icoord {',
      'public:',
      '  icoord operator + (ipoint);',
      '};'
    ].join('\n')).rootNode, uri);

    assert.deepStrictEqual(
      index.declarations.filter((declaration) => declaration.name === 'operator +').map((declaration) => ({
        name: declaration.name,
        kind: declaration.kind,
        detail: declaration.detail,
        containerName: declaration.containerName
      })),
      [
        { name: 'operator +', kind: 'function', detail: 'icoord operator + (ipoint)', containerName: 'icoord' }
      ]
    );
  });

  test('indexes each supported declaration kind', () => {
    const index = buildSymbolIndex(parser.parse([
      '#define N 100',
      '#define MAX(a, b) ((a) > (b) ? (a) : (b))',
      'typedef int Count;',
      'int value;',
      'void main() {}',
      'class Widget {};',
      'struct Point {};',
      'union Payload {};',
      'enum Mode { A, B };'
    ].join('\n')).rootNode, uri);

    assert.deepStrictEqual(
      index.declarations.map((declaration) => `${declaration.kind}:${declaration.name}`),
      [
        'macro:N',
        'macro:MAX',
        'typedef:Count',
        'variable:value',
        'function:main',
        'class:Widget',
        'struct:Point',
        'union:Payload',
        'enum:Mode',
        'enumMember:A',
        'enumMember:B'
      ]
    );
  });

  test('indexes anonymous enum members', () => {
    const index = buildSymbolIndex(parser.parse('enum { GC_BTN_OK = 0x01 };').rootNode, uri);

    assert.deepStrictEqual(
      index.declarations.map((declaration) => ({
        name: declaration.name,
        kind: declaration.kind,
        detail: declaration.detail,
        containerName: declaration.containerName
      })),
      [
        { name: 'GC_BTN_OK', kind: 'enumMember', detail: 'enum GC_BTN_OK = 0x01', containerName: undefined }
      ]
    );
  });

  test('recovers class declarations before malformed class bodies', () => {
    const index = buildSymbolIndex(parser.parse([
      '#ifndef HEADER',
      '#define HEADER',
      '#include "../lazc/_axel_string.h"',
      '/*!',
      ' * @class GCControlButton',
      ' */',
      'class GCControlButton',
      '{',
      'public:',
      '  GCControlButton();',
      '  int style;',
      '};',
      '#endif'
    ].join('\n')).rootNode, uri);

    const declaration = index.declarations.find((item) => item.name === 'GCControlButton' && item.kind === 'class');
    assert.ok(declaration);
    assert.strictEqual(declaration.selectionRange.start.line, 6);
  });

  test('uses macro and enum member details', () => {
    const index = buildSymbolIndex(parser.parse([
      '#define N 100',
      '#define MAX(a, b) ((a) > (b) ? (a) : (b))',
      'enum Mode { A, B = 2 };'
    ].join('\n')).rootNode, uri);

    assert.deepStrictEqual(
      index.declarations.map((declaration) => ({
        name: declaration.name,
        kind: declaration.kind,
        detail: declaration.detail,
        containerName: declaration.containerName
      })),
      [
        { name: 'N', kind: 'macro', detail: '#define N 100', containerName: undefined },
        {
          name: 'MAX',
          kind: 'macro',
          detail: '#define MAX(a, b) ((a) > (b) ? (a) : (b))',
          containerName: undefined
        },
        { name: 'Mode', kind: 'enum', detail: 'enum', containerName: undefined },
        { name: 'A', kind: 'enumMember', detail: 'enum Mode::A', containerName: 'Mode' },
        { name: 'B', kind: 'enumMember', detail: 'enum Mode::B = 2', containerName: 'Mode' }
      ]
    );
  });

  test('records declaration documentation from adjacent and trailing comments', () => {
    const index = buildSymbolIndex(parser.parse([
      '// Computes the visible count.',
      'int count;',
      '#define DEBUG_LOG 1 // Enables debug output.'
    ].join('\n')).rootNode, uri);

    assert.deepStrictEqual(
      index.declarations.filter((declaration) => ['count', 'DEBUG_LOG'].includes(declaration.name)).map((declaration) => ({
        name: declaration.name,
        documentation: (declaration as { documentation?: string }).documentation
      })),
      [
        { name: 'count', documentation: 'Computes the visible count.' },
        { name: 'DEBUG_LOG', documentation: 'Enables debug output.' }
      ]
    );
  });

  test('records class base names for inheritance-aware lookup', () => {
    const index = buildSymbolIndex(parser.parse([
      'class Base {};',
      'class Child : public Base {};'
    ].join('\n')).rootNode, uri);

    assert.deepStrictEqual(
      index.declarations.filter((declaration) => declaration.kind === 'class').map((declaration) => ({
        name: declaration.name,
        baseName: declaration.baseName
      })),
      [
        { name: 'Base', baseName: undefined },
        { name: 'Child', baseName: 'Base' }
      ]
    );
  });

  test('excludes macro definitions and parameters from references', () => {
    const index = buildSymbolIndex(parser.parse([
      '#define N 100',
      '#define MAX(a, b) ((a) > (b) ? (a) : (b))',
      'void main() { int value = MAX(N, 2); }'
    ].join('\n')).rootNode, uri);

    assert.deepStrictEqual(
      index.references.filter((reference) => ['N', 'MAX', 'a', 'b'].includes(reference.name)).map((reference) => reference.name),
      ['MAX', 'N']
    );
  });

  test('retains duplicate and nested declarations with their containers', () => {
    const index = buildSymbolIndex(parser.parse([
      'int value;',
      'class Widget {',
      '  int value;',
      '  void update() { int value; }',
      '};'
    ].join('\n')).rootNode, uri);

    const values = index.declarations.filter((declaration) => declaration.name === 'value');

    assert.strictEqual(values.length, 3);
    assert.notStrictEqual(values[0].id, values[1].id);
    assert.notStrictEqual(values[1].id, values[2].id);
    assert.strictEqual(values[0].containerName, undefined);
    assert.strictEqual(values[1].containerName, 'Widget');
    assert.strictEqual(values[2].containerName, 'update');
  });

  test('does not treat inline type declarators as containers', () => {
    const index = buildSymbolIndex(parser.parse([
      'typedef struct S {} Alias;',
      'class Widget {} instance;'
    ].join('\n')).rootNode, uri);

    const declarations = index.declarations.map((declaration) => ({
      name: declaration.name,
      containerName: declaration.containerName
    }));

    assert.deepStrictEqual(declarations, [
      { name: 'Alias', containerName: undefined },
      { name: 'S', containerName: undefined },
      { name: 'instance', containerName: undefined },
      { name: 'Widget', containerName: undefined }
    ]);
  });

  test('uses the name field and excludes identifier parts of qualified declarations', () => {
    const index = buildSymbolIndex(parser.parse('void C::f() {}').rootNode, uri);

    assert.deepStrictEqual(index.declarations.map((declaration) => ({
      id: declaration.id,
      name: declaration.name,
      selectionRange: declaration.selectionRange
    })), [{
      id: 'file:///main.axl#0:8:f',
      name: 'f',
      selectionRange: {
        start: { line: 0, character: 8 },
        end: { line: 0, character: 9 }
      }
    }]);
    assert.ok(!index.references.some((reference) => reference.name === 'C'));
    assert.ok(!index.references.some((reference) => reference.name === 'f'));
  });

  test('indexes named type specifiers as declarations only when they have bodies', () => {
    const index = buildSymbolIndex(parser.parse([
      'class Widget value;',
      'struct Point *p;',
      'class Declared {};'
    ].join('\n')).rootNode, uri);

    assert.deepStrictEqual(
      index.declarations.map((declaration) => `${declaration.kind}:${declaration.name}`),
      ['variable:value', 'variable:p', 'class:Declared']
    );
    assert.ok(index.references.some((reference) => reference.name === 'Widget'));
    assert.ok(index.references.some((reference) => reference.name === 'Point'));
  });

  test('indexes parameter declarations and excludes their names from references', () => {
    const index = buildSymbolIndex(parser.parse([
      'void f(int x) { x = 1; }',
      'enum Mode { A, B };',
      '#define N 100',
      'Widget value;'
    ].join('\n')).rootNode, uri);

    const referenceNames = index.references.map((reference) => reference.name);

    assert.deepStrictEqual(
      index.declarations.filter((declaration) => declaration.name === 'x').map((declaration) => ({
        kind: declaration.kind,
        detail: declaration.detail
      })),
      [{ kind: 'parameter', detail: 'int x' }]
    );
    assert.strictEqual(referenceNames.filter((name) => name === 'x').length, 1);
    assert.ok(referenceNames.includes('Widget'));
    assert.ok(!referenceNames.includes('A'));
    assert.ok(!referenceNames.includes('B'));
    assert.strictEqual(referenceNames.filter((name) => name === 'N').length, 0);
  });

  test('does not create declarations for anonymous types', () => {
    const index = buildSymbolIndex(parser.parse('struct { int member; };').rootNode, uri);

    assert.deepStrictEqual(
      index.declarations.map((declaration) => `${declaration.kind}:${declaration.name}`),
      ['variable:member']
    );
  });

  test('returns declarations recovered from malformed documents', () => {
    const index = buildSymbolIndex(parser.parse('void broken( { int recovered;').rootNode, uri);

    assert.deepStrictEqual(
      index.declarations.map((declaration) => declaration.name),
      ['broken', 'recovered']
    );
  });

  test('returns non-declaration identifiers as unresolved references', () => {
    const index = buildSymbolIndex(parser.parse('void main() { int local; local = 1; }').rootNode, uri);

    assert.deepStrictEqual(index.references.filter((reference) => reference.name === 'local'), [{
      name: 'local',
      uri,
      range: {
        start: { line: 0, character: 25 },
        end: { line: 0, character: 30 }
      }
    }]);
  });

  test('records qualified static calls as member references with receiver type references', () => {
    const index = buildSymbolIndex(parser.parse([
      'class FILE { static int IsDirectory(int path) {} };',
      'void main() { FILE::IsDirectory(1); }'
    ].join('\n')).rootNode, uri);

    assert.deepStrictEqual(index.references.filter((reference) => reference.name === 'IsDirectory'), [{
      name: 'IsDirectory',
      uri,
      range: {
        start: { line: 1, character: 20 },
        end: { line: 1, character: 31 }
      },
      call: true,
      memberAccess: {
        receiverName: 'FILE',
        memberNames: ['IsDirectory']
      }
    }]);
    assert.deepStrictEqual(index.references.filter((reference) => reference.name === 'FILE'), [{
      name: 'FILE',
      uri,
      range: {
        start: { line: 1, character: 14 },
        end: { line: 1, character: 18 }
      },
      typeReference: true
    }]);
  });

  test('adds named GUI parts as variable declarations owned by their GUI container', () => {
    const index = buildSymbolIndex(parser.parse([
      'class MyDialog : public GCDialog {',
      '  GCVBoxLayout {',
      '    GCGroupBox group { GCText input; };',
      '  };',
      '};'
    ].join('\n')).rootNode, uri);

    assert.deepStrictEqual(
      index.declarations.filter((declaration) => ['group', 'input'].includes(declaration.name)).map((declaration) => ({
        name: declaration.name,
        kind: declaration.kind,
        detail: declaration.detail,
        containerName: declaration.containerName,
        typeName: declaration.typeName
      })),
      [
        {
          name: 'group',
          kind: 'variable',
          detail: 'GCGroupBox group',
          containerName: 'MyDialog',
          typeName: 'GCGroupBox'
        },
        {
          name: 'input',
          kind: 'variable',
          detail: 'GCText input',
          containerName: 'GCGroupBox',
          typeName: 'GCText'
        }
      ]
    );
  });
});
