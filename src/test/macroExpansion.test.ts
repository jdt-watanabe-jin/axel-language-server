import * as assert from 'assert';
import type { AnalysisMacroDefinition } from '../types/analysis';
import { expandMacroInvocationText, type MacroLookup } from '../analyzer/macroExpansion';

suite('macroExpansion', () => {
  test('expands single-level function-like macros', () => {
    const lookup = lookupFrom([
      macro('MAX', ['a', 'b'], '((a) > (b) ? (a) : (b))')
    ]);

    const result = expandMacroInvocationText('MAX(1, 2)', lookup);

    assert.deepStrictEqual({
      expandedText: result.expandedText,
      truncated: result.truncated,
      diagnostics: result.diagnostics
    }, {
      expandedText: '((1) > (2) ? (1) : (2))',
      truncated: false,
      diagnostics: []
    });
  });

  test('expands nested function-like macros', () => {
    const lookup = lookupFrom([
      macro('define_stringMAP_oneBase', ['p_class'], 'stringMAP mMapL; \\\npublic: \\\nint Add(string key, p_class value) { return 1; }'),
      macro('define_stringMAP_one', ['p_class'], 'define_stringMAP_oneBase(p_class) \\\np_class *Find(string key) { return NULL; }')
    ]);

    const result = expandMacroInvocationText('define_stringMAP_one(int)', lookup);

    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.expandedText, [
      'stringMAP mMapL;',
      'public:',
      'int Add(string key, int value) { return 1; }',
      'int *Find(string key) { return NULL; }'
    ].join('\n'));
  });

  test('does not substitute parameters inside strings or comments', () => {
    const lookup = lookupFrom([
      macro('LOG', ['value'], 'printf("value"); /* value */ value')
    ]);

    const result = expandMacroInvocationText('LOG(count)', lookup);

    assert.strictEqual(result.expandedText, 'printf("value"); /* value */ count');
  });

  test('returns diagnostics for wrong arity', () => {
    const lookup = lookupFrom([
      macro('ONE', ['value'], 'value')
    ]);

    const result = expandMacroInvocationText('ONE(a, b)', lookup);

    assert.deepStrictEqual(result.diagnostics.map((diagnostic) => diagnostic.message), [
      "Macro 'ONE' expects 1 argument but got 2."
    ]);
  });

  test('truncates recursive macro expansion', () => {
    const lookup = lookupFrom([
      macro('A', ['x'], 'A(x)')
    ]);

    const result = expandMacroInvocationText('A(value)', lookup, { maxDepth: 3 });

    assert.strictEqual(result.truncated, true);
  });
});

function macro(name: string, parameters: string[], replacementText: string): AnalysisMacroDefinition {
  return {
    name,
    uri: 'file:///macros.h',
    range: range(),
    selectionRange: range(),
    detail: `#define ${name}(${parameters.join(', ')}) ${replacementText}`,
    parameters: parameters.map((label) => ({ label })),
    replacementText
  };
}

function lookupFrom(macros: AnalysisMacroDefinition[]): MacroLookup {
  return {
    findMacro: (name, arity) => macros.find((macro) => (
      macro.name === name && (arity === undefined || macro.parameters?.length === arity)
    ))
  };
}

function range() {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 }
  };
}
