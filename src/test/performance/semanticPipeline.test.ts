import * as assert from 'assert';
import { mock } from 'node:test';
import { DocumentAnalyzer } from '../../analyzer/documentAnalyzer';
import { createAxelParser } from '../../analyzer/axelParser';
import { buildTypeSnapshot, type TypeNode } from '../../analyzer/typeChecking/syntax';
import * as highlight from '../../analyzer/documentHighlightMacros';
import * as documentation from '../../analyzer/documentation/index';

suite('Semantic pipeline materialization', () => {
  test('builds source presentation once across macro reparsing and preserves direct analysis', () => {
    const highlights = mock.method(highlight, 'collectHighlightMacrosSteps');
    const documents = mock.method(documentation, 'buildDocumentationBlocks');
    try {
      const analyzer = new DocumentAnalyzer();
      const input = {uri: 'file:///macro.axl', version: 1, text: '#define TYPE int\n/// A value.\nTYPE value;'};
      const result = analyzer.analyzeDocument(input);
      assert.ok(result.expandedSource);
      assert.ok(result.highlightMacros?.length);
      assert.ok(result.documentationBlocks?.length);
      assert.strictEqual(highlights.mock.callCount(), 1);
      assert.strictEqual(documents.mock.callCount(), 1);
      const plain = analyzer.analyzeDocument({...input, text: '#define TYPE int\n/// A value.\nint value;'}, false);
      assert.ok(plain.highlightMacros?.length);
      assert.ok(plain.documentationBlocks?.length);
      assert.strictEqual(highlights.mock.callCount(), 2);
      assert.strictEqual(documents.mock.callCount(), 2);
    } finally { highlights.mock.restore(); documents.mock.restore(); }
  });

  for (const source of [
    'class C { public: int x; virtual void f(string ...); }; void g(){ C *p; p->x += 1; }',
    'void f(){ call(1, // comment\n2,',
    '#if FOO\nint a;\n#else\nstring b;\n#endif',
    'enum E { A, B=2 }; int a[2]; void f(){a[0]=(1+2)*3;}',
    '// \u65e5\u672c\ud83d\ude00\r\nstring s="\u65e5\u672c\ud83d\ude00";'
  ]) {
    test('preserves native fields, children and ranges: ' + source.slice(0, 25), () => {
      const root = createAxelParser().parse(source).rootNode;
      const result = buildTypeSnapshot(root, 'file:///native.axl');
      function check(node: typeof root, snapshot: TypeNode): void {
        assert.strictEqual(snapshot.kind, node.type);
        assert.strictEqual(snapshot.text, node.text);
        assert.strictEqual(snapshot.start, node.startIndex);
        assert.strictEqual(snapshot.end, node.endIndex);
        assert.deepStrictEqual(snapshot.range, {start:{line:node.startPosition.row,character:node.startPosition.column},
          end:{line:node.endPosition.row,character:node.endPosition.column}});
        assert.strictEqual(!!snapshot.missing, node.isMissing);
        assert.strictEqual(snapshot.children.length, node.namedChildren.length);
        node.namedChildren.forEach((child, i) => check(child, snapshot.children[i]));
        const fields = new Map<string, typeof root[]>();
        node.children.forEach((child, i) => { const name = node.fieldNameForChild(i); if(name) { const items = fields.get(name) ?? []; items.push(child); fields.set(name, items); } });
        assert.deepStrictEqual(Object.keys(snapshot.fields), [...fields.keys()]);
        for (const [name, children] of fields) {
          assert.strictEqual(snapshot.fields[name].length, children.length);
          children.forEach((child, i) => {
            check(child, snapshot.fields[name][i]);
            if (child.isNamed) { assert.strictEqual(snapshot.fields[name][i], snapshot.children[node.namedChildren.findIndex(c => c.id === child.id)]); }
          });
        }
      }
      check(root, result.root);
    });
  }
});
