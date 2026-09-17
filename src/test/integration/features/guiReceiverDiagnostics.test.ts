import * as assert from 'assert';
import { DocumentAnalyzer } from '../../../analyzer/documentAnalyzer';
import { collectSemanticDiagnostics } from '../../../analyzer/semanticDiagnostics';
import { collectTypeDiagnostics } from '../../../analyzer/typeChecking/diagnostics';
import { thisReceiverType } from '../../../analyzer/resolution';

suite('GUI receiver diagnostics', () => {
  const declarations = [
    'class GCWidget { int value; void SetValue(int value) {} };',
    'class GCText : public GCWidget {};',
    'class Unrelated { void SetNecessary(int value, int extra) {} };'
  ].join('\n');
  for (const explicit of [false, true]) {
    for (const external of [false, true]) {
      test(`checks missing members with ${explicit ? 'explicit' : 'implicit'} this in ${external ? 'external' : 'inline'} handlers`, () => {
        const prefix = explicit ? 'this->' : '';
        const body = `${prefix}value = 1; ${prefix}SetValue(1); ${prefix}SetNecessary(1);`;
        const text = declarations + '\n' + (external
          ? `class Dialog : public GCDialog { GCText item; };\nvoid Dialog::item::OnCreate() { ${body} }`
          : `class Dialog : public GCDialog { GCText item { OnCreate() { ${body} } }; };`);
        const analysis = new DocumentAnalyzer().analyzeDocument({uri: 'file:///gui.axl', version: 1, text});
        const diagnostics = collectSemanticDiagnostics({analysis});
        assert.strictEqual(diagnostics.length, 1, JSON.stringify(diagnostics));
        assert.strictEqual(diagnostics[0].severity, 'error');
        assert.ok(diagnostics[0].message.includes('SetNecessary'), diagnostics[0].message);
        const reference = analysis.references.find(ref => ref.name === 'SetNecessary')!;
        assert.deepStrictEqual(diagnostics[0].range, reference.range);
        assert.strictEqual(thisReceiverType({analysis, position: reference.range.start, workspaceIndex: {}}), 'GCText');
      });
    }
  }
  test('checks explicit GUI object members outside a handler', () => {
    const analysis = new DocumentAnalyzer().analyzeDocument({uri: 'file:///gui.axl', version: 1,
      text: declarations + '\nvoid main() { GCText item; item.SetValue(1); item.SetNecessary(1); }'});
    const diagnostics = collectSemanticDiagnostics({analysis});
    assert.strictEqual(diagnostics.length, 1, JSON.stringify(diagnostics));
    assert.ok(diagnostics[0].message.includes('SetNecessary'));
  });
  test('uses ordinary assignment and argument type checking for GUI this', () => {
    for (const [prefix, external] of [['', false], ['this->', false], ['', true], ['this->', true]] as const) {
      const body = `${prefix}value = this; ${prefix}SetValue(this);`;
      const analysis = new DocumentAnalyzer().analyzeDocument({uri: 'file:///gui.axl', version: 1,
        text: declarations + '\n' + (external
          ? `class Dialog : public GCDialog { GCText item; }; void Dialog::item::OnCreate() { ${body} }`
          : `class Dialog : public GCDialog { GCText item { OnCreate() { ${body} } }; };`)});
      const diagnostics = collectTypeDiagnostics({analysis});
      assert.deepStrictEqual(diagnostics.map(d => d.code).sort(), ['axel.type.argument_type', 'axel.type.assignment']);
      assert.ok(diagnostics.every(d => d.message.includes('GCText*')), JSON.stringify(diagnostics));
    }
  });
  test('a local class establishes its own this inside a GUI handler', () => {
    const analysis = new DocumentAnalyzer().analyzeDocument({uri: 'file:///gui.axl', version: 1,
      text: 'class GCText {}; class Dialog : public GCDialog { GCText item { OnCreate() { class Inner { int value; void f() { this->value = 1; } }; } }; };'});
    assert.deepStrictEqual(collectSemanticDiagnostics({analysis}), []);
    assert.deepStrictEqual(collectTypeDiagnostics({analysis}), []);
  });
  test('local bindings shadow GUI members in type checking', () => {
    const analysis = new DocumentAnalyzer().analyzeDocument({uri: 'file:///gui.axl', version: 1,
      text: declarations + '\nclass Dialog : public GCDialog { GCText item { OnCreate() { GCText *value = this; value = this; } }; };'});
    assert.deepStrictEqual(collectTypeDiagnostics({analysis}), []);
  });
});
