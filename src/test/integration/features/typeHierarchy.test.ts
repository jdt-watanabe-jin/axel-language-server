import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';
import { positionFromOffset } from '../../support/source';
import * as target from '../../../analyzer/typeTarget';
import * as graph from '../../../analyzer/typeHierarchy/semantics';

function api() {
  return { target, graph };
}

suite('Type hierarchy semantic resolution', () => {
  const { createWorkspaceIndex, createTempDir } = useWorkspaceFixtures();
  function fixture(text: string) {
    const index = createWorkspaceIndex();
    const uri = pathToFileURL(path.join(createTempDir(), 'main.axl')).toString();
    const analysis = index.indexOpenDocument({ uri, version: 1, text });
    return { index, uri, analysis,
      target: (name: string, last = false) => api().target.resolveTypeTarget({ analysis, workspaceIndex: index,
        position: positionFromOffset(text, last ? text.lastIndexOf(name) : text.indexOf(name)) }),
      graph: () => api().graph.collectTypeHierarchy(index.callHierarchyTypeInput(analysis)) };
  }

  test('resolves types, aliases, variables, parameters and nested pointer/array types', () => {
    const f = fixture('class Base { int x; }; class Derived : Base { int y; };\n'
      + 'typedef Derived Alias; Alias **values[2];\nvoid fn(Derived &arg) { values; arg; }');
    for (const name of ['Derived', 'Alias', 'values', 'arg']) {
      assert.strictEqual(f.target(name)?.classInfo?.name, 'Derived', name);
    }
    assert.strictEqual(f.target('values', true)?.classInfo?.name, 'Derived');
    assert.strictEqual(f.target('arg', true)?.classInfo?.name, 'Derived');
    assert.ok(f.target('Alias')!.aliases.length);
    assert.strictEqual(f.target('values')!.type.kind, 'array');
  });

  test('keeps only direct bases including every written base and typedef base', () => {
    const f = fixture('class A { int x; }; class B { int y; }; typedef A Alias; '
      + 'class C : public Alias, private B { int z; }; class D : C { int q; };');
    const records = f.graph();
    const names = (key: string) => records.find(record => record.key === key)?.name;
    assert.deepStrictEqual(records.find(record => record.name === 'C')?.bases.map(names).sort(), ['A', 'B']);
    assert.deepStrictEqual(records.find(record => record.name === 'D')?.bases.map(names), ['C']);
  });

  test('does not return a class for basic types, functions, function pointers, comments or whitespace', () => {
    const f = fixture('class A { int x; }; A make(); A (*callback)(); int number;\n// A comment\n');
    for (const name of ['make', 'callback', 'number', '// A', '\n']) {
      assert.strictEqual(f.target(name)?.classInfo, undefined, name);
    }
  });

  test('excludes inactive declarations and does not invent unresolved or self bases', () => {
    const f = fixture('#if 0\nclass Hidden { int x; };\n#endif\n'
      + 'class A : Missing { int x; }; class Self : Self { int y; };');
    assert.deepStrictEqual(f.graph().map(record => [record.name, record.bases]), [['A', []], ['Self', []]]);
  });

  test('unifies forward declarations and retains same-named types in different scopes', () => {
    const f = fixture('class A; class A { int x; }; class Outer { class A { int y; }; A member; }; A global;');
    const records = f.graph();
    const as = records.filter(record => record.name === 'A');
    assert.strictEqual(as.length, 2);
    assert.notStrictEqual(as[0].key, as[1].key);
    assert.strictEqual(f.target('member')?.classInfo?.name, 'A');
    assert.strictEqual(f.target('global')?.classInfo?.name, 'A');
    assert.ok(as.every(record => record.selectionRange.start.character !== 6), 'definition preferred over forward declaration');
  });

  test('does not connect duplicate base names from unrelated visible headers', () => {
    const directory = createTempDir();
    fs.writeFileSync(path.join(directory, 'one.h'), 'class Base { int a; };');
    fs.writeFileSync(path.join(directory, 'two.h'), 'class Base { int b; };');
    const index = createWorkspaceIndex();
    const uri = pathToFileURL(path.join(directory, 'main.axl')).toString();
    const text = '#include "one.h"\n#include "two.h"\nclass Child : Base { int c; };';
    const analysis = index.indexOpenDocument({ uri, version: 1, text });
    const records = api().graph.collectTypeHierarchy(index.callHierarchyTypeInput(analysis));
    assert.deepStrictEqual(records.find(record => record.name === 'Child')?.bases, []);
    assert.strictEqual(target.resolveTypeTarget({ analysis, workspaceIndex: index,
      position: positionFromOffset(text, text.lastIndexOf('Base')) }), undefined);
  });

  test('distinguishes local classes in overloads with different argument counts', () => {
    const f = fixture('void fn() { class Local { int x; }; Local a; }\n'
      + 'void fn(int n) { class Local { int y; }; Local b; }');
    const locals = f.graph().filter(record => record.name === 'Local');
    assert.strictEqual(locals.length, 2);
    assert.notStrictEqual(locals[0].key, locals[1].key);
  });

  test('resolves GUI parts and inherited fields without adding containment edges', () => {
    const f = fixture('class GCWidget { int x; }; class GCDialog : GCWidget {};\n'
      + 'class GCCheckBox : GCWidget {}; class Dialog : GCDialog { GCCheckBox check { }; };');
    assert.strictEqual(f.target('check')?.classInfo?.name, 'GCCheckBox');
    const records = f.graph();
    assert.deepStrictEqual(records.find(record => record.name === 'Dialog')?.bases.map(key => records.find(r => r.key === key)?.name), ['GCDialog']);
  });

  test('resolves a field reference from its declaration rather than its receiver class', () => {
    const f = fixture('class Value { int x; }; class Holder { Value field; }; Holder holder;\nvoid main() { holder.field; }');
    assert.strictEqual(f.target('field', true)?.classInfo?.name, 'Value');
  });

  test('supports macro-expanded base types but never starts from a macro name', () => {
    const f = fixture('class Base { int x; };\n#define PARENT Base\nclass Child : PARENT { int y; };\nChild value;');
    const records = f.graph();
    assert.deepStrictEqual(records.find(record => record.name === 'Child')?.bases.map(key => records.find(r => r.key === key)?.name), ['Base']);
    assert.strictEqual(f.target('PARENT'), undefined);
    assert.strictEqual(f.target('value')?.classInfo?.name, 'Child');
  });

  test('preserves finite explicit cycles without self loops and rejects ambiguous duplicate definitions', () => {
    const f = fixture('class A; class B : A { int x; }; class A : B { int y; };\n'
      + 'class Duplicate { int x; }; class Duplicate { int y; }; class Child : Duplicate {};');
    const records = f.graph();
    assert.deepStrictEqual(records.filter(record => ['A', 'B'].includes(record.name)).map(record => record.bases.length), [1, 1]);
    assert.deepStrictEqual(records.find(record => record.name === 'Child')?.bases, []);
    assert.ok(!records.some(record => record.name === 'Duplicate'));
  });

  test('does not turn pointer typedefs in base clauses into inheritance', () => {
    const f = fixture('class Base { int x; }; typedef Base *Pointer; class Child : Pointer { int y; };');
    assert.deepStrictEqual(f.graph().find(record => record.name === 'Child')?.bases, []);
  });
});
