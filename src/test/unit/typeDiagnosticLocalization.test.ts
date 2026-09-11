import * as assert from 'assert';
import { japaneseMessages } from '../../i18n/ja';
import { toLspDiagnostic } from '../../lsp/diagnostics';
import { useWorkspaceFixtures } from '../support/workspace';

suite('Type checking: diagnostic localization', () => {
  const fixtures = useWorkspaceFixtures();
  const templates = [
    "Cannot instantiate class '{0}' without instance data.",
    "Cannot initialize '{0}' with '{1}'.",
    'Array size must be an integer constant expression.',
    'Enumerator value must be an integer constant expression.',
    "Return value of type '{0}' is required.",
    "Cannot return '{0}' from a function returning '{1}'.",
    "Case value '{0}' cannot be compared with '{1}'.",
    'A conversion operator must not declare a return type.',
    'Function prototypes are not supported by this AXEL runtime.',
    "Function '{0}' is already defined.",
    "Class '{0}' is already defined."
  ];
  test('translates every statement and declaration diagnostic template', () => {
    for (const key of templates) {
      assert.ok(Object.hasOwn(japaneseMessages, key), key);
    }
  });
  test('preserves actual diagnostic code, severity, source, ranges and type names across locales', () => {
    const index = fixtures.createWorkspaceIndex();
    const source = 'class Target {}; void f(Target value) {}\nvoid main(){ f(1); }';
    const analysis = index.analyzeDocument({ uri: 'file:///type-i18n.axl', version: 1, text: source });
    const diagnostic = analysis.diagnostics.find(item => item.code === 'axel.type.argument_type');
    assert.ok(diagnostic, JSON.stringify(analysis.diagnostics));
    const en = toLspDiagnostic(diagnostic, 'en');
    const ja = toLspDiagnostic(diagnostic, 'ja-JP');
    assert.notStrictEqual(en.message, ja.message);
    assert.deepStrictEqual({ ...ja, message: en.message }, en);
    assert.ok(ja.message.includes('Target') && ja.message.includes('int'));
    assert.ok(ja.message.includes('引数'), ja.message);
    assert.ok(!ja.message.includes('argument_type'), ja.message);
    assert.deepStrictEqual(en.range, { start: { line: 1, character: 15 }, end: { line: 1, character: 16 } });
  });
});
