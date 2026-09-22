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
  test('resolves nested GUI parts and retains exact result and missing-member diagnostics', () => {
    const diagnostics=check('int p=dlg.radio.GetOnRadioPosition(); int checked=dlg.radio.btn1.IsChecked(); dlg.radio.btn2.SetChecked(1);\nint*ptr=dlg.radio.btn1.IsChecked();\ndlg.radio.btn1.NoSuchMethod();');
    const line=source.split('\n').length;
    assert.deepStrictEqual(diagnostics.map(d=>[d.range.start.line,d.code]),[[line,'axel.type.initialization'],[line+1,'axel.type.member']]);
  });

});
