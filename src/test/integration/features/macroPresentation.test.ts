import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { useWorkspaceFixtures } from '../../support/workspace';
import { getHover } from '../../../analyzer/hover';
import { collectSemanticTokens } from '../../../analyzer/semanticTokens';

suite('Included macro presentation', () => {
  const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
  test('shows definition and expansion for a bare macro generating GUI declarations', async () => {
    const root = createTempDir();
    const header = path.join(root, '_bookmark.h');
    fs.writeFileSync(header, '#define LABEL 1\n#define L_BOOKMARK_FILE_LEFT_WIDGET string mBkmkPfx; GCLabel { OnCreate() { text=LABEL; } };');
    const uri = pathToFileURL(path.join(root, 'consumer.axl')).toString();
    const text = '#include "_bookmark.h"\nclass Dialog : public GCDialog {\n L_BOOKMARK_FILE_LEFT_WIDGET\n};';
    const index = createWorkspaceIndex();
    const input = {uri, version:1, text};
    index.indexOpenDocument(input);
    await index.waitForBackgroundIndexing();
    const analysis = index.indexOpenDocument(input);
    const hover = getHover({analysis,workspaceIndex:index,position:{line:2,character:3}});
    assert.ok(hover);
    assert.ok(hover?.plainText.includes('#define L_BOOKMARK_FILE_LEFT_WIDGET'), hover?.plainText);
    assert.ok(hover.plainText.includes('Expansion:\nstring mBkmkPfx;'), hover.plainText);
    assert.ok(hover.plainText.includes('text=1;'), hover.plainText);
    assert.ok(hover.plainText.includes(header), hover.plainText);
  });
  test('shows the object macro under the cursor instead of its enclosing call', () => {
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({uri:'file:///object-argument.axl',version:1,
      text:'#define VALUE 42\n#define PRINT(x) output(x)\nvoid main() { PRINT(VALUE); }'});
    const hover = getHover({analysis,workspaceIndex:index,position:{line:2,character:20}});
    assert.ok(hover);
    assert.ok(hover?.plainText.startsWith('#define VALUE 42'), hover?.plainText);
    assert.ok(hover.plainText.includes('Expansion:\n42'), hover.plainText);
  });
  for (const [name, definition, expression] of [
    ['FN', '#define FN(x) x', 'FN'],
    ['FN', '#define FN(x) x\n#define APPLY(f) f(1)', 'APPLY(FN)'],
    ['VALUE$', '#define VALUE$ 42', 'VALUE$']
  ]) {
    test(`preserves hover for ${expression}`, () => {
      const index = createWorkspaceIndex();
      const text = definition + '\nvoid main() { ' + expression + '; }';
      const analysis = index.indexOpenDocument({uri:'file:///macro-name.axl',version:1,text});
      const hover = getHover({analysis,workspaceIndex:index,position:{line:definition.split('\n').length,character:14+expression.indexOf(name)}});
      assert.ok(hover?.plainText.startsWith('#define '+name), hover?.plainText);
      if (name === 'VALUE$') { assert.ok(hover?.plainText.includes('Expansion:\n42')); }
    });
  }
  function fixture(definition: string) {
    const root = createTempDir();
    const header = path.join(root, '_cdscompack.h');
    fs.writeFileSync(header, definition);
    const uri = pathToFileURL(path.join(root, 'consumer.axl')).toString();
    const text = '#include "_cdscompack.h"\nvoid printf(string value) {}\nvoid main() { CDSPRINT("hello"); }';
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({ uri, version: 1, text });
    return { index, analysis, header, position: { line: 2, character: 14 } };
  }
  test('shows definition, documentation, origin and expansion for an object macro used as a call', () => {
    const { index, analysis, header, position } = fixture('//! Print a message.\n#define CDSPRINT printf');
    const hover = getHover({ analysis, workspaceIndex: index, position });
    assert.ok(hover);
    assert.ok(hover.plainText.includes('#define CDSPRINT printf'), hover.plainText);
    assert.ok(hover.plainText.includes('Print a message.'), hover.plainText);
    assert.ok(hover.plainText.includes(header), hover.plainText);
    assert.ok(hover.plainText.includes('printf("hello")'), hover.plainText);
  });
  test('expands an object alias that resolves to a function macro', () => {
    const { index, analysis, position } = fixture('#define PRINT(x) printf(x)\n#define CDSPRINT PRINT');
    const hover = getHover({ analysis, workspaceIndex: index, position });
    assert.ok(hover?.plainText.includes('printf("hello")'), JSON.stringify(hover));
  });
  for (const definition of ['#define CDSPRINT printf', '#define CDSPRINT(x) printf(x)']) {
    test(`colors only the written macro name as macro: ${definition}`, () => {
      const { index, analysis, position } = fixture(definition);
      for (const lookup of [index, index.semanticTokenWorkspaceIndex(analysis.uri)]) {
        const tokens = collectSemanticTokens(analysis, lookup).filter(token => token.range.start.line === position.line
          && token.range.start.character <= position.character && token.range.end.character > position.character);
        assert.deepStrictEqual(tokens.map(token => token.tokenType), ['macro']);
        assert.strictEqual(tokens[0].range.end.character - tokens[0].range.start.character, 'CDSPRINT'.length);
      }
    });
  }
  test('preserves variable highlighting in written macro arguments', () => {
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({ uri: 'file:///macro-arguments.axl', version: 1,
      text: '#define PRINT(x) printf(x)\nvoid printf(string s) {}\nvoid main() { string text; PRINT(text); }' });
    const tokens = collectSemanticTokens(analysis, index).filter(token => token.range.start.line === 2);
    assert.ok(tokens.some(token => token.tokenType === 'variable' && token.range.start.character === 33
      && token.range.end.character === 37 && token.modifiers.length === 0), JSON.stringify(tokens));
  });
});
