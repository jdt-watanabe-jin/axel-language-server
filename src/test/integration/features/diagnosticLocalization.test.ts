import * as assert from 'assert';
import { createAxelParser } from '../../../analyzer/axelParser';
import { collectSyntaxDiagnostics } from '../../../analyzer/diagnostics';
import { collectSemanticDiagnostics } from '../../../analyzer/semanticDiagnostics';
import { buildScopeIndex } from '../../../analyzer/scopeIndex';
import { buildSymbolIndex } from '../../../analyzer/symbolIndex';
import { expandMacroInvocationText } from '../../../analyzer/macroExpansion';
import { formatMessage } from '../../../i18n/messages';

suite('diagnostic localization metadata', () => {
  test('preserves structured syntax and macro failures for locale rendering', () => {
    const parser = createAxelParser();
    const diagnostics = collectSyntaxDiagnostics(parser.parse('void main() { @@@; }').rootNode);
    assert.ok(diagnostics.length > 0);
    assert.ok(diagnostics.every((diagnostic) => 'messageDescriptor' in diagnostic));
    assert.strictEqual(formatMessage(diagnostics[0].messageDescriptor!, 'ja'), '構文エラーです。');
    const macroFailure = expandMacroInvocationText('MISSING(1)', { findMacro: () => undefined });
    assert.ok('messageDescriptor' in macroFailure.diagnostics[0]);
    assert.strictEqual(formatMessage(macroFailure.diagnostics[0].messageDescriptor!, 'ja'), "引数1個のマクロ'MISSING'が見つかりません。");
  });

  for (const [declarations, expectedEnglish, expectedJapanese] of [
    ['void target(int value);', '1 argument', '引数1個'],
    ['void target(int value, int other);', '2 arguments', '引数2個'],
    ['void target(int value, int other = 1);', '1 or 2 arguments', '引数1個または2個'],
    ['void target(int value, int other = 1, int third = 2);', '1 to 3 arguments', '引数1～3個'],
    ['void target(int value, ...);', 'at least 1 argument', '引数1個以上'],
    ['void target(int value); void target(int a, int b); void target(int a, int b, int c);',
      '1, 2 or 3 arguments', '引数1、2または3個']
  ]) {
    test(`renders nested argument counts in Japanese: ${expectedEnglish}`, () => {
      const parser = createAxelParser();
      const uri = 'file:///localization.axl';
      const rootNode = parser.parse(`${declarations} void main() { target(); }`).rootNode;
      const symbols = buildSymbolIndex(rootNode, uri);
      const diagnostics = collectSemanticDiagnostics({ analysis: {
        uri, diagnostics: [], declarations: symbols.declarations, references: symbols.references,
        scopes: buildScopeIndex(rootNode, uri, symbols.declarations), includes: [], guiClasses: [], guiMethods: []
      } });
      const diagnostic = diagnostics.find((item) => item.message.includes('expects'));
      assert.ok(diagnostic);
      assert.ok('messageDescriptor' in diagnostic);
      assert.strictEqual(diagnostic.message, `Function 'target' expects ${expectedEnglish}, but got 0.`);
      assert.strictEqual(formatMessage(diagnostic.messageDescriptor!, 'ja'),
        `関数'target'には${expectedJapanese}が必要ですが、0個が指定されています。`);
    });
  }
});
