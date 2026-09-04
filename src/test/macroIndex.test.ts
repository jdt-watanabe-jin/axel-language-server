import * as assert from 'assert';
import { createAxelParser } from '../analyzer/axelParser';
import { collectMacroDefinitions, normalizeMacroReplacementText } from '../analyzer/macroIndex';

suite('macroIndex', () => {
  test('extracts object-like macro replacement text', () => {
    const parser = createAxelParser();
    const tree = parser.parse('#define LIMIT 100 // upper bound\n');

    const macros = collectMacroDefinitions(tree.rootNode, 'file:///main.axl');

    assert.deepStrictEqual(macros.map((macro) => ({
      name: macro.name,
      detail: macro.detail,
      documentation: macro.documentation,
      parameters: macro.parameters,
      replacementText: macro.replacementText
    })), [
      {
        name: 'LIMIT',
        detail: '#define LIMIT 100',
        documentation: 'upper bound',
        parameters: undefined,
        replacementText: '100'
      }
    ]);
  });

  test('extracts function-like macro parameters and replacement text', () => {
    const parser = createAxelParser();
    const tree = parser.parse('#define MAX(a, b) ((a) > (b) ? (a) : (b))\n');

    const macros = collectMacroDefinitions(tree.rootNode, 'file:///main.axl');

    assert.deepStrictEqual(macros.map((macro) => ({
      name: macro.name,
      parameters: macro.parameters,
      replacementText: macro.replacementText
    })), [
      {
        name: 'MAX',
        parameters: [{ label: 'a' }, { label: 'b' }],
        replacementText: '((a) > (b) ? (a) : (b))'
      }
    ]);
  });

  test('normalizes line continuations in replacement text', () => {
    assert.strictEqual(
      normalizeMacroReplacementText('first \\\n  second \\\r\n\tthird'),
      'first\n  second\n\tthird'
    );
  });
});
