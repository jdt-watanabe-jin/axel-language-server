import * as assert from 'assert';
import { WorkspaceIndex } from '../../../analyzer/workspaceIndex';

suite('Type checking: GUI part member access', () => {
  const source = `class GCDialog {int data;};
    class GCButtonGroup {int data; int GetOnRadioPosition(){return 1;}};
    class GCRadioButton {int data; int IsChecked(){return 1;} void SetChecked(int value){}};
    class Dialog : public GCDialog {
      GCVBoxLayout {
        GCButtonGroup radio { GCRadioButton btn1; GCRadioButton btn2; };
      };
    };`;
  function check(body: string) {
    return new WorkspaceIndex().analyzeDocument({uri:'file:///radio.axl',version:1,
      text:source + ` void main(){Dialog dlg; ${body}}`}).diagnostics.filter(d=>d.code?.startsWith('axel.type.'));
  }
  test('resolves named parts through anonymous layout containers', () => {
    assert.deepStrictEqual(check('int p=dlg.radio.GetOnRadioPosition();'), []);
  });
  test('resolves child parts using their instance path', () => {
    assert.deepStrictEqual(check('int checked=dlg.radio.btn1.IsChecked(); dlg.radio.btn2.SetChecked(1);'), []);
  });
  test('retains the builtin method result type for surrounding checks', () => {
    assert.ok(check('int*p=dlg.radio.btn1.IsChecked();').some(d=>d.code==='axel.type.initialization'));
  });
  test('still diagnoses missing methods on known GUI part types', () => {
    assert.ok(check('dlg.radio.btn1.NoSuchMethod();').some(d=>d.code==='axel.type.member'));
  });
});
