import * as assert from 'assert';
import { createAxelParser } from '../../../analyzer/axelParser';
import { collectSyntaxDiagnostics } from '../../../analyzer/diagnostics';
import { extractDocumentationComments } from '../../../analyzer/documentation/comments';

suite('Doxygen comments', () => {
  function extract(text: string) {
    const tree = createAxelParser().parse(text);
    return extractDocumentationComments(tree.rootNode, text, 'file:///main.axl');
  }

  for (const [marker, body] of [
    ['/*!', 'bang block'],
    ['/**', 'javadoc block'],
    ['///', 'slash line'],
    ['//!', 'bang line']
  ] as const) {
    test(`extracts the ${marker} leading form`, () => {
      const suffix = marker.startsWith('/*') ? ' */' : '';
      const [comment] = extract(`${marker} ${body}${suffix}\nint value;`);
      assert.strictEqual(comment.placement, 'leading');
      assert.deepStrictEqual(comment.lines.map(line => line.text), [body]);
    });
  }

  test('preserves paragraph and list indentation', () => {
    const text = '/*!\n * @brief Search\n *\n * - first\n *   - nested\n */\nint Find();';
    const tree = createAxelParser().parse(text);
    assert.strictEqual(tree.rootNode.hasError, false);
    const blocks = extractDocumentationComments(tree.rootNode, text, 'file:///main.axl');
    assert.strictEqual(blocks.length, 1);
    assert.ok(blocks[0].lines.some(line => line.text === ''));
    assert.ok(blocks[0].lines.some(line => line.text === '  - nested'));
  });

  test('supports undecorated LF block bodies', () => {
    const [comment] = extract('/*!\n  @brief Search\n\n    - nested\n*/\nint Find();');
    assert.deepStrictEqual(comment.lines.map(line => line.text), [
      '@brief Search', '', '  - nested'
    ]);
  });

  test('supports CRLF and retains line source provenance', () => {
    const [comment] = extract('/**\r\n * @brief 😀 search\r\n */\r\nint Find();');
    assert.deepStrictEqual(comment.lines.map(line => line.text), ['@brief 😀 search']);
    assert.strictEqual(comment.source.raw, '/**\r\n * @brief 😀 search\r\n */');
    assert.deepStrictEqual(comment.source.range, {
      start: { line: 0, character: 0 },
      end: { line: 2, character: 3 }
    });
    assert.strictEqual(comment.lines[0].source.uri, 'file:///main.axl');
    assert.strictEqual(comment.lines[0].source.raw, ' * @brief 😀 search');
    assert.deepStrictEqual(comment.lines[0].source.range, {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 19 }
    });
  });

  test('keeps a prefix-only line as an empty line inside a block', () => {
    const [comment] = extract('/// first\n///\n/// second\nint value;');
    assert.deepStrictEqual(comment.lines.map(line => line.text), ['first', '', 'second']);
  });

  test('splits line comment blocks across an empty source line', () => {
    const comments = extract('/// first\n\n/// second\nint value;');
    assert.deepStrictEqual(comments.map(comment => comment.lines.map(line => line.text)), [
      ['first'], ['second']
    ]);
  });

  test('ignores ordinary comments and comment markers in strings', () => {
    const comments = extract([
      '// ordinary',
      '/* ordinary */',
      'const char *a = "/*! fake */";',
      'const char *b = "/// fake";'
    ].join('\n'));
    assert.deepStrictEqual(comments, []);
  });

  for (const source of [
    'int value; ///< trailing',
    'int value; //!< trailing',
    'int value; /**< trailing */',
    'int value; /*!< trailing */'
  ]) {
    test(`marks ${source.slice(source.indexOf('/'))} as trailing`, () => {
      const [comment] = extract(source);
      assert.strictEqual(comment.placement, 'trailing');
      assert.deepStrictEqual(comment.lines.map(line => line.text), ['trailing']);
    });
  }

  test('does not merge trailing comments attached to consecutive declarations', () => {
    const comments = extract('int first; ///< first\nint second; ///< second');
    assert.deepStrictEqual(comments.map(comment => comment.lines.map(line => line.text)), [
      ['first'], ['second']
    ]);
  });

  test('reports an unclosed block without exposing documentation or following declarations', () => {
    const text = '/** unclosed\n * @brief search\nint Find();';
    const tree = createAxelParser().parse(text);
    assert.deepStrictEqual(collectSyntaxDiagnostics(tree.rootNode).map(item => item.message), ['Missing */.']);
    assert.strictEqual(tree.rootNode.descendantsOfType('function_declarator').length, 0);
    assert.deepStrictEqual(extractDocumentationComments(tree.rootNode, text, 'file:///main.axl'), []);
  });

  test('the AXEL parser accepts representative declaration shapes', () => {
    const declarations = [
      'int Find(const char *name, int (*compare)(int,int));',
      'int InitGetSection(Inifile *inifile, string sec);',
      'int operator+(int left, int right);',
      'void Log(string format, int values...);'
    ];
    for (const declaration of declarations) {
      assert.strictEqual(createAxelParser().parse(declaration).rootNode.hasError, false, declaration);
    }
  });
});
