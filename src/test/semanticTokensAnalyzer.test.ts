import * as assert from 'assert';
import { DocumentAnalyzer } from '../analyzer/documentAnalyzer';
import { collectSemanticTokens } from '../analyzer/semanticTokens';
import type { AnalysisDeclaration } from '../types/analysis';

suite('collectSemanticTokens', () => {
  test('returns sorted declaration and reference tokens with distinct symbol types', () => {
    const text = [
      'int value;',
      'int main() {',
      '  value = 1;',
      '  main();',
      '}'
    ].join('\n');
    const analysis = new DocumentAnalyzer().analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text
    });

    const tokens = collectSemanticTokens(analysis);

    assert.deepStrictEqual(tokens.map((token) => ({
      line: token.range.start.line,
      character: token.range.start.character,
      type: token.tokenType,
      modifiers: token.modifiers
    })), [
      { line: 0, character: 4, type: 'variable', modifiers: ['declaration'] },
      { line: 1, character: 4, type: 'function', modifiers: ['declaration'] },
      { line: 2, character: 2, type: 'variable', modifiers: [] },
      { line: 3, character: 2, type: 'function', modifiers: [] }
    ]);
  });

  test('does not throw for malformed documents', () => {
    const analysis = new DocumentAnalyzer().analyzeDocument({
      uri: 'file:///broken.axl',
      version: 1,
      text: 'int main( { value'
    });

    assert.doesNotThrow(() => collectSemanticTokens(analysis));
  });

  test('tokens implicit GUI receiver properties inside inline event bodies', () => {
    const lines = [
      'class Dialog : public GCDialog {',
      '  GCCheckBox Check1 { OnCreate() { text = "Check1"; } };',
      '};'
    ];
    const analysis = new DocumentAnalyzer().analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: lines.join('\n'),
      knownGuiClassNames: ['GCCheckBox']
    });
    const textCharacter = lines[1].indexOf('text =');

    const tokens = collectSemanticTokens(analysis, {
      listVisibleDeclarations: () => [
        declaration('GCWidget', 'class', 'class GCWidget'),
        declaration('GCCheckBox', 'class', 'class GCCheckBox : public GCWidget', {
          baseName: 'GCWidget'
        }),
        declaration('text', 'field', 'string GCWidget::text', {
          containerName: 'GCWidget',
          typeName: 'string'
        })
      ]
    });

    assert.ok(tokens.some((token) => (
      token.range.start.line === 1
      && token.range.start.character === textCharacter
      && token.tokenType === 'property'
      && token.modifiers.length === 0
    )));
  });

  test('tokens external GUI receiver paths and implicit receiver method calls', () => {
    const lines = [
      'class mydialog : public GCDialog {',
      '  GCGroupBox box { GCCheckBox One; };',
      '};',
      'void mydialog::box.One::OnChanged()',
      '{',
      '  if (IsChecked())',
      '    box.Two.SetChecked(0);',
      '    SetBoxRadio(0);',
      '}'
    ];
    const analysis = new DocumentAnalyzer().analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: lines.join('\n'),
      knownGuiClassNames: ['GCGroupBox', 'GCCheckBox']
    });

    const tokens = collectSemanticTokens(analysis, {
      listVisibleDeclarations: () => [
        declaration('GCCheckBox', 'class', 'class GCCheckBox'),
        declaration('IsChecked', 'variable', 'bool IsChecked()', {
          containerName: 'GCCheckBox',
          typeName: 'bool'
        }),
        declaration('SetChecked', 'variable', 'void SetChecked(int val)', {
          containerName: 'GCCheckBox',
          typeName: 'void'
        })
      ]
    });

    assertToken(tokens, 3, lines[3].indexOf('mydialog'), 'class', []);
    assertToken(tokens, 3, lines[3].indexOf('box'), 'variable', []);
    assertToken(tokens, 3, lines[3].indexOf('One'), 'variable', []);
    assertToken(tokens, 3, lines[3].indexOf('OnChanged'), 'function', ['declaration']);
    assertToken(tokens, 5, lines[5].indexOf('IsChecked'), 'method', []);
    assertToken(tokens, 6, lines[6].indexOf('SetChecked'), 'method', []);
  });

  test('tokens external GUI owner methods receiver class names', () => {
    const lines = [
      'class mydialog : public GCDialog {',
      '};',
      'void mydialog::OnCreate()',
      '{',
      '  text = "Sample Of GroupBox";',
      '}'
    ];
    const analysis = new DocumentAnalyzer().analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: lines.join('\n')
    });

    const tokens = collectSemanticTokens(analysis);

    assertToken(tokens, 2, lines[2].indexOf('mydialog'), 'class', []);
    assertToken(tokens, 2, lines[2].indexOf('OnCreate'), 'function', ['declaration']);
  });

  test('tokens inline GUI event declarations as methods', () => {
    const lines = [
      'class mydialog : public GCDialog {',
      '  GCButtonGroup { OnCreate() { text = "Button Group"; } };',
      '  GCCheckBox Check1 { OnCreate() { text = "Check1"; } };',
      '};'
    ];
    const analysis = new DocumentAnalyzer().analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: lines.join('\n'),
      knownGuiClassNames: ['GCButtonGroup', 'GCCheckBox']
    });

    const tokens = collectSemanticTokens(analysis);

    assertToken(tokens, 1, lines[1].indexOf('OnCreate'), 'method', ['declaration']);
    assertToken(tokens, 2, lines[2].indexOf('OnCreate'), 'method', ['declaration']);
    assertNoToken(tokens, 1, lines[1].indexOf('OnCreate'), 'property');
    assertNoToken(tokens, 2, lines[2].indexOf('OnCreate'), 'property');
    assertNoToken(tokens, 1, lines[1].indexOf('OnCreate'), 'variable');
    assertNoToken(tokens, 2, lines[2].indexOf('OnCreate'), 'variable');
  });

  test('tokens AXEL execution file names as functions', () => {
    const lines = [
      'void main() {',
      '  @test -i `infile`;',
      '}'
    ];
    const analysis = new DocumentAnalyzer().analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: lines.join('\n')
    });

    const tokens = collectSemanticTokens(analysis);

    assertToken(tokens, 1, lines[1].indexOf('test'), 'function', []);
  });

  test('marks semantic tokens in inactive preprocessor branches', () => {
    const lines = [
      '#define ENABLED 1',
      '#if ENABLED',
      'int activeValue;',
      '#else',
      'int inactiveValue;',
      '#endif',
      '#ifdef MISSING',
      'void inactiveFunction() {}',
      '#endif'
    ];
    const analysis = new DocumentAnalyzer().analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: lines.join('\n')
    });

    const tokens = collectSemanticTokens(analysis);

    assertToken(tokens, 2, lines[2].indexOf('activeValue'), 'variable', ['declaration']);
    assertToken(tokens, 4, lines[4].indexOf('inactiveValue'), 'variable', ['declaration', 'inactive']);
    assertToken(tokens, 7, lines[7].indexOf('inactiveFunction'), 'function', ['declaration', 'inactive']);
  });

  test('evaluates undef and elif preprocessor branches for inactive semantic tokens', () => {
    const lines = [
      '#define FIRST',
      '#undef FIRST',
      '#if defined(FIRST)',
      'int inactiveFirst;',
      '#elif !defined(SECOND)',
      'int activeFallback;',
      '#else',
      'int inactiveElse;',
      '#endif'
    ];
    const analysis = new DocumentAnalyzer().analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text: lines.join('\n')
    });

    const tokens = collectSemanticTokens(analysis);

    assertToken(tokens, 3, lines[3].indexOf('inactiveFirst'), 'variable', ['declaration', 'inactive']);
    assertToken(tokens, 5, lines[5].indexOf('activeFallback'), 'variable', ['declaration']);
    assertToken(tokens, 7, lines[7].indexOf('inactiveElse'), 'variable', ['declaration', 'inactive']);
  });
});

function assertToken(
  tokens: ReturnType<typeof collectSemanticTokens>,
  line: number,
  character: number,
  tokenType: ReturnType<typeof collectSemanticTokens>[number]['tokenType'],
  modifiers: readonly string[]
): void {
  assert.ok(tokens.some((token) => (
    token.range.start.line === line
    && token.range.start.character === character
    && token.tokenType === tokenType
    && assert.deepStrictEqual(token.modifiers, modifiers) === undefined
  )));
}

function assertNoToken(
  tokens: ReturnType<typeof collectSemanticTokens>,
  line: number,
  character: number,
  tokenType: ReturnType<typeof collectSemanticTokens>[number]['tokenType']
): void {
  assert.ok(tokens.every((token) => (
    token.range.start.line !== line
    || token.range.start.character !== character
    || token.tokenType !== tokenType
  )));
}

function declaration(
  name: string,
  kind: AnalysisDeclaration['kind'],
  detail: string,
  extras: Partial<Pick<AnalysisDeclaration, 'baseName' | 'containerName' | 'typeName'>> = {}
): AnalysisDeclaration {
  return {
    id: `file:///gui.h#${name}:${kind}:${extras.containerName ?? ''}`,
    name,
    kind,
    uri: 'file:///gui.h',
    detail,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: name.length } },
    selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: name.length } },
    ...extras
  };
}
