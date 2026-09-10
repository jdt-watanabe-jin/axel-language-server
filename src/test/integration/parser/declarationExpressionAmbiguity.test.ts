import * as assert from 'assert';
import { createAxelParser } from '../../../analyzer/axelParser';
import { buildScopeIndex } from '../../../analyzer/scopeIndex';
import { collectSemanticDiagnostics } from '../../../analyzer/semanticDiagnostics';
import { buildSymbolIndex } from '../../../analyzer/symbolIndex';

suite('Type checking: declaration expression ambiguity', () => {
  function analyze(source: string) {
    const uri = 'file:///ambiguity.axl';
    const root = createAxelParser().parse(source).rootNode;
    assert.strictEqual(root.hasError, false);
    const symbols = buildSymbolIndex(root, uri);
    const diagnostics = collectSemanticDiagnostics({ analysis: {
      uri, ...symbols, scopes: buildScopeIndex(root, uri, symbols.declarations),
      diagnostics: [], includes: [], guiClasses: [], guiMethods: []
    } });
    return { ...symbols, diagnostics };
  }

  test('indexes bare multiplication and bitwise and as references when the left name is a value', () => {
    const result = analyze('void f(){int a=1; int b=2; a*b; a&b;}');
    assert.deepStrictEqual(result.declarations.map(d => d.name), ['f', 'a', 'b']);
    assert.deepStrictEqual(result.references.filter(r => r.name === 'a' || r.name === 'b').map(r => [r.name, r.typeReference ?? false]),
      [['a', false], ['b', false], ['a', false], ['b', false]]);
    assert.deepStrictEqual(result.diagnostics, []);
  });

  test('preserves pointer and reference declarations when the name denotes a type', () => {
    const result = analyze('class A {}; void f(){ A*b; A &r=b; }');
    assert.deepStrictEqual(result.declarations.map(d => d.name), ['A', 'f', 'b', 'r']);
    assert.strictEqual(result.declarations.find(d => d.name === 'b')!.typeName, 'A');
    assert.deepStrictEqual(result.diagnostics, []);
  });

  test('uses the nearest scope and does not see values from another block or later declarations', () => {
    const result = analyze('class A {}; void f(){ {int A=1; int b=2; A*b;} A*c; }');
    assert.deepStrictEqual(result.declarations.map(d => d.name), ['A', 'f', 'A', 'b', 'c']);
    assert.deepStrictEqual(result.diagnostics, []);
    const later = analyze('void f(){ a*b; int a=1; }');
    assert.ok(later.declarations.some(d => d.name === 'b'));
    assert.ok(later.diagnostics.some(d => d.message === "Unknown type 'a'."));
  });

  test('retains missing right operand name diagnostics and parameter values', () => {
    const result = analyze('void f(int a){a*missing;}');
    assert.deepStrictEqual(result.declarations.map(d => d.name), ['f', 'a']);
    assert.deepStrictEqual(result.diagnostics.map(d => d.message), ["Unknown identifier 'missing'."]);
  });
});
