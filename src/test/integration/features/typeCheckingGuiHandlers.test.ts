import * as assert from 'assert';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { collectTypeDiagnostics } from '../../../analyzer/typeChecking/diagnostics';

suite('Type checking: GUI handler identity', () => {
  const dialog = `class Dialog : public GCDialog {
    GCGroupBox box { GCRadioButton One; GCRadioButton Two; };
  };`;
  function check(handlers: string) {
    const analysis = new DocumentAnalyzer().analyzeDocument({
      uri: 'file:///gui-handlers.axl', version: 1, text: dialog + handlers
    });
    assert.ok(!analysis.diagnostics.some(d => d.severity === 'error'));
    return collectTypeDiagnostics({analysis});
  }
  test('accepts equal handler names on distinct GUI instances', () => {
    assert.deepStrictEqual(check(`
      void Dialog::box.One::OnChanged() {}
      void Dialog::box.Two::OnChanged() {}
      void Dialog::OnChanged() {}
    `), []);
  });
  test('still rejects duplicate handlers on the same GUI instance', () => {
    const diagnostics = check(`
      void Dialog::box.One::OnChanged() {}
      void Dialog::box.One::OnChanged() {}
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, 'axel.type.definition');
  });
});
