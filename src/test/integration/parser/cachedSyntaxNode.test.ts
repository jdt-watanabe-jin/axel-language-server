import * as assert from 'assert';
import type * as Parser from 'tree-sitter';
import { createAxelParser } from '../../../analyzer/axelParser';
import { cachedSyntaxNode } from '../../../analyzer/cachedSyntaxNode';

suite('Parse-local syntax reads', () => {

  test('reuses indexed children only for valid integer indices in an enumerated array', () => {
    const root = createAxelParser().parse('int x; int y;').rootNode;
    const native = root.child.bind(root);
    let reads = 0;
    Object.defineProperty(root, 'child', { configurable: true, value: (i: number) => { reads++; return native(i); } });
    const view = cachedSyntaxNode(root);
    assert.strictEqual(view.child(0)?.id, view.children[0].id);
    const before = reads;
    assert.strictEqual(view.child(1)?.id, view.children[1].id);
    assert.strictEqual(reads, before);
    for (const i of [-1, 0.5, 999]) {
      let expected: Parser.SyntaxNode | null | undefined;
      try { expected = native(i); } catch { assert.throws(() => view.child(i)); continue; }
      assert.strictEqual(view.child(i)?.id, expected?.id);
    }
  });
  for (const text of ['class C { int x; virtual void f(int ...); }; void g(){ C *p; p->x=1; } /* doc */ string s = "";', 'void f(){ f(1,']) {
    for (const namedFirst of [false, true]) {
      test(`preserves native children, fields and recovery (${namedFirst}, ${text})`, () => {
        const root = createAxelParser().parse(text).rootNode;
        const view = cachedSyntaxNode(root);
        function check(native: Parser.SyntaxNode, cached: Parser.SyntaxNode): void {
          assert.strictEqual(cached.type, native.type);
          assert.strictEqual(cached.text, native.text);
          assert.strictEqual(cached.hasError, native.hasError);
          assert.strictEqual(cached.isNamed, native.isNamed);
          assert.strictEqual(cached.childCount, native.childCount);
          if (namedFirst) { assert.deepStrictEqual(cached.namedChildren.map(n => n.id), native.namedChildren.map(n => n.id)); }
          assert.deepStrictEqual(cached.children.map(n => n.id), native.children.map(n => n.id));
          assert.deepStrictEqual(cached.namedChildren.map(n => n.id), native.namedChildren.map(n => n.id));
          assert.deepStrictEqual(cached.startPosition, native.startPosition);
          assert.deepStrictEqual(cached.endPosition, native.endPosition);
          assert.strictEqual(cached.isMissing, native.isMissing);
          assert.strictEqual(cached.parent?.id, native.parent?.id);
          for (let i = 0; i < native.childCount; i++) {
            const field = native.fieldNameForChild(i);
            assert.strictEqual(cached.fieldNameForChild(i), field);
            if (field) { assert.strictEqual(cached.childForFieldName(field)?.id, native.childForFieldName(field)?.id); }
            check(native.child(i)!, cached.child(i)!);
          }
        }
        check(root, view);
        for (const types of ['identifier', ['identifier', 'comment']]) {
          assert.deepStrictEqual(view.descendantsOfType(types).map(n => n.id), root.descendantsOfType(types).map(n => n.id));
        }
      });
    }
  }

  test('reuses child enumerations across passes and preserves empty leaves', () => {
    for (const allFirst of [false, true]) {
      const root = createAxelParser().parse('int value; string empty = "";').rootNode;
      const nodes = [root, root.descendantsOfType('identifier')[0], root.descendantsOfType('string_literal')[0]];
      for (const node of nodes) {
        let reads = 0;
        const children = node.children, named = node.namedChildren;
        Object.defineProperty(node, 'children', { configurable: true, get() { reads++; return children; } });
        Object.defineProperty(node, 'namedChildren', { configurable: true, get() { reads++; return named; } });
        const view = cachedSyntaxNode(node);
        if (allFirst) { void view.children; } else { void view.namedChildren; }
        for (let pass = 0; pass < 3; pass++) {
          assert.deepStrictEqual(view.children.map(child => child.id), children.map(child => child.id));
          assert.deepStrictEqual(view.namedChildren.map(child => child.id), named.map(child => child.id));
        }
        assert.ok(reads <= 2, 'Repeated passes must reuse completed enumerations');
      }
    }
  });
  test('keeps independent method arguments and bounded descendant queries cached', () => {
    const root = createAxelParser().parse('int first;\nstring second;').rootNode;
    const view = cachedSyntaxNode(root);
    for (let pass = 0; pass < 3; pass++) {
      for (let index = 0; index <= root.childCount; index++) {
        assert.strictEqual(view.child(index)?.id, root.child(index)?.id);
        assert.strictEqual(view.namedChild(index)?.id, root.namedChild(index)?.id);
        assert.strictEqual(view.fieldNameForChild(index), root.fieldNameForChild(index));
      }
      for (const name of ['type', 'declarator', 'missing']) {
        assert.strictEqual(view.child(0)!.childForFieldName(name)?.id, root.child(0)!.childForFieldName(name)?.id);
      }
      for (const row of [0, 1]) {
        const start = { row, column: 0 };
        const end = { row, column: 30 };
        assert.deepStrictEqual(view.descendantsOfType('identifier', start, end).map(node => node.text),
          root.descendantsOfType('identifier', start, end).map(node => node.text));
      }
    }
    assert.strictEqual(view.child(0), view.namedChildren[0]);
  });

  test('isolates separately parsed document versions', () => {
    const parser=createAxelParser();
    const before=cachedSyntaxNode(parser.parse('int before;').rootNode);
    const after=cachedSyntaxNode(parser.parse('int after;').rootNode);
    assert.ok(before.namedChildren[0].text.includes('before'));
    assert.ok(after.namedChildren[0].text.includes('after'));
  });
});
