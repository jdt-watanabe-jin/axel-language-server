import * as assert from 'assert';
import { createAxelParser } from '../../analyzer/axelParser';
import { collectMacroDefinitions } from '../../analyzer/macroIndex';
import { expandMacroInvocationText, type MacroLookup } from '../../analyzer/macroExpansion';
import type { AnalysisMacroDefinition } from '../../types/analysis';

suite('macroExpansion', () => {

  test('expands nested function-like macros', () => {
    const source = '#define define_stringMAP_oneBase(p_class) stringMAP mMapL; \\\npublic: \\\r\nint Add(string key, p_class value) { return 1; }\n'
      + '#define define_stringMAP_one(p_class) define_stringMAP_oneBase(p_class) \\\np_class *Find(string key) { return NULL; }\n';
    const tree = createAxelParser().parse(source);
    const lookup = lookupFrom(collectMacroDefinitions(tree.rootNode, 'file:///macros.h'));

    const result = expandMacroInvocationText('define_stringMAP_one(int)', lookup);

    assert.strictEqual(result.truncated, false);
    assert.deepStrictEqual(result.diagnostics, []);
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

  test('returns diagnostics for nested wrong arity', () => {
    const lookup = lookupFrom([
      macro('ONE', ['value'], 'value'),
      macro('WRAP', ['value'], 'ONE(value, extra)')
    ]);

    const result = expandMacroInvocationText('WRAP(count)', lookup);

    assert.deepStrictEqual(result.diagnostics.map((diagnostic) => diagnostic.message), [
      "Macro 'ONE' expects 1 argument but got 2."
    ]);
  });

  test('ignores comments while matching nested invocation parentheses', () => {
    const lookup = lookupFrom([
      macro('INNER', ['value'], 'value'),
      macro('OUTER', ['value'], 'before INNER(value /* ) */) after')
    ]);

    const result = expandMacroInvocationText('OUTER(count)', lookup);

    assert.strictEqual(result.expandedText, 'before count /* ) */ after');
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
    findMacro: (name) => macros
      .filter((macro) => macro.name === name)
      .at(-1)
  };
}

function range() {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 }
  };
}
