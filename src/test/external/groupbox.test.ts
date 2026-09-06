import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getHover } from '../../analyzer/hover';
import { WorkspaceIndex } from '../../analyzer/workspaceIndex';
import { analyze, positionFromOffset } from '../support/source';
import { useWorkspaceFixtures } from '../support/workspace';

suite('getHover', () => {
test('resolves function and variable token hovers in the real groupbox sample', function () {
    this.timeout(10_000);

    const samplePath = path.normalize(process.env.AXEL_TEST_SAMPLE ?? 'D:/projects/sxm/qt5/userhome/axel_sample/groupbox_sample.axl');
    const forcedIncludePath = path.normalize(
      process.env.AXEL_TEST_FORCED_INCLUDE ?? 'D:/projects/work/TypeScript/axel-extension/include/_axel_intellisense_def.h'
    );
    if (!fs.existsSync(samplePath) || !fs.existsSync(forcedIncludePath)) {
      throw new Error('Set AXEL_TEST_SAMPLE and AXEL_TEST_FORCED_INCLUDE to run the external groupbox regression.');
    }

    const text = fs.readFileSync(samplePath, 'utf8');
    const index = createWorkspaceIndex({ forcedIncludeFiles: [forcedIncludePath] });
    const analysis = index.indexOpenDocument({
      uri: pathToFileURL(samplePath).toString(),
      version: 1,
      text
    });

    assert.deepStrictEqual(analysis.diagnostics, []);
    assertHoverText(analysis, index, { line: 0, character: 24 }, 'class GCWidget');
    assertHoverText(analysis, index, { line: 27, character: 15 }, 'void mydialog::OnCreate()');
    assertHoverText(analysis, index, { line: 57, character: 15 }, 'void mydialog::SetBoxRadio(int pos)');
    assertHoverText(analysis, index, positionOf(text, 'void main()', 'main'), 'void main()');
    assertHoverText(analysis, index, positionOf(text, 'mydialog dlg;', 'mydialog'), 'class mydialog : public GCDialog');
    assertHoverText(analysis, index, positionOf(text, 'mydialog dlg;', 'dlg'), 'mydialog dlg');
    assertHoverText(analysis, index, { line: 31, character: 1 }, 'GCRadioButton mydialog::One');
    assertHoverText(analysis, index, { line: 34, character: 5 }, 'GCRadioButton mydialog::box.Two');
    assertHoverText(analysis, index, { line: 34, character: 9 }, 'void GCRadioButton::SetChecked(int val)');
    assertHoverText(analysis, index, { line: 23, character: 18 }, 'GCControlButton mydialog::ctlBtn');
    assertHoverText(analysis, index, { line: 5, character: 4 }, 'void GCWidget::OnCreate()');
    assertHoverText(analysis, index, { line: 5, character: 17 }, 'string GCButtonGroup::text');
    assertHoverText(analysis, index, { line: 9, character: 24 }, 'void GCWidget::OnCreate()');
    assertHoverText(analysis, index, { line: 9, character: 37 }, 'string GCCheckBox::text');
    assertHoverText(analysis, index, { line: 23, character: 28 }, 'void GCControlButton::OnCreate()');
    assertHoverText(analysis, index, { line: 23, character: 41 }, 'int GCControlButton::style');
    assertHoverText(analysis, index, { line: 42, character: 1 }, 'void mydialog::SetBoxRadio(int pos)');
    assertHoverText(analysis, index, { line: 59, character: 1 }, 'int printf(string format, ...)');
    assertHoverText(analysis, index, positionOf(text, 'dlg.DoModal();', 'DoModal'), 'int GCDialog::DoModal()');
  });
});

function assertHoverText(
  analysis: ReturnType<typeof analyze>,
  workspaceIndex: WorkspaceIndex,
  position: { line: number; character: number },
  expectedPlainText: string
): void {
  const hover = getHover({ analysis, position, workspaceIndex });
  assert.strictEqual(hover?.plainText.split('\n')[0], expectedPlainText);
}

function positionOf(text: string, lineText: string, tokenText: string) {
  const lineStart = text.indexOf(lineText);
  assert.notStrictEqual(lineStart, -1);
  const tokenStart = text.indexOf(tokenText, lineStart);
  assert.notStrictEqual(tokenStart, -1);
  return positionFromOffset(text, tokenStart);
}

const { createWorkspaceIndex } = useWorkspaceFixtures();
