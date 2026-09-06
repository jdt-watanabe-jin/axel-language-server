import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getHover } from '../../../analyzer/hover';
import { assertExternalHover } from '../../support/hoverAssertions';
import { analyze, analyzeMarked, positionFromOffset } from '../../support/source';
import { useWorkspaceFixtures } from '../../support/workspace';
suite('getHover', () => {
  test('resolves inherited GUI methods when a recovered base header loses member containers', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, [
      'class GCComboBox : public GCWidget {};',
      'void SetCaption(string caption);'
    ].join('\n'));

    const index = createWorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const markedText = 'void main() { GCComboBox combo; combo.|SetCaption("caption"); }';
    const markerOffset = markedText.indexOf('|');
    const text = markedText.replace('|', '');
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text
    });

    const hover = getHover({
      analysis,
      position: positionFromOffset(text, markerOffset),
      workspaceIndex: index
    });

    assertExternalHover(hover, 'void GCWidget::SetCaption(string caption)', forcedPath);
  });

  test('resolves chained widget member access through each field type', () => {
    const analysis = analyze([
      'class Button {};',
      'class Child { Button button; };',
      'class Widget { Child child_wid; };',
      'void main() { Widget wid; wid.child_wid.button; }'
    ].join('\n'));

    const childHover = getHover({
      analysis,
      position: { line: 3, character: 31 },
      workspaceIndex: createWorkspaceIndex()
    });
    const buttonHover = getHover({
      analysis,
      position: { line: 3, character: 41 },
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(childHover, {
      markdown: '```axel\nChild Widget::child_wid\n```',
      plainText: 'Child Widget::child_wid'
    });
    assert.deepStrictEqual(buttonHover, {
      markdown: '```axel\nButton Child::button\n```',
      plainText: 'Button Child::button'
    });
  });

  test('returns GUI class inheritance hover at the class name', () => {
    const { analysis, position } = analyzeMarked('class |MyDialog : public GCDialog {};');

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nclass MyDialog : public GCDialog\n```',
      plainText: 'class MyDialog : public GCDialog'
    });
  });

  test('returns a GUI part owner path hover at a named part declaration', () => {
    const { analysis, position } = analyzeMarked([
      'class MyDialog : public GCDialog {',
      '  GCGroupBox group {',
      '    GCText |input;',
      '  };',
      '};'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nGCText MyDialog::group.input\n```',
      plainText: 'GCText MyDialog::group.input'
    });
  });

  test('returns a GUI class hover at a GUI part type reference from a forced include', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, 'class GCComboBox : public GCWidget {};');

    const index = createWorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const markedText = [
      'class MyDialog : public GCDialog {',
      '  |GCComboBox cmbV1 { OnCreate() {} };',
      '};'
    ].join('\n');
    const markerOffset = markedText.indexOf('|');
    const text = markedText.replace('|', '');
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text
    });

    const hover = getHover({
      analysis,
      position: positionFromOffset(text, markerOffset),
      workspaceIndex: index
    });

    assertExternalHover(hover, 'class GCComboBox : public GCWidget', forcedPath);
  });

  test('resolves member access on a reusable widget GUI part', () => {
    const { analysis, position } = analyzeMarked([
      'class CustomWidget : public GCWidget { GCText input; };',
      'class MyDialog : public GCDialog { CustomWidget custom; };',
      'void main() { MyDialog dialog; dialog.custom.|input; }'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nGCText CustomWidget::input\n```',
      plainText: 'GCText CustomWidget::input'
    });
  });

  test('returns receiver-aware hover for an external GUI event definition', () => {
    const { analysis, position } = analyzeMarked([
      'class MyDialog : public GCDialog {',
      '  GCGroupBox group { GCPushButton button; };',
      '};',
      'void MyDialog::group.button::|OnPush() {}'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nvoid MyDialog::group.button::OnPush()\n```',
      plainText: 'void MyDialog::group.button::OnPush()'
    });
  });

  test('resolves GUI part path hover through dot and scope separators', () => {
    const { analysis, position } = analyzeMarked([
      'class MyDialog : public GCDialog {',
      '  GCGroupBox group { GCText input; };',
      '};',
      'void MyDialog::group.|input::OnChanged() {}'
    ].join('\n'));

    assert.deepStrictEqual(analysis.diagnostics, []);
    const hover = getHover({
      analysis,
      position,
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nGCText MyDialog::group.input\n```',
      plainText: 'GCText MyDialog::group.input'
    });
  });

  test('returns null for an unknown GUI receiver path segment', () => {
    const { analysis, position } = analyzeMarked([
      'class MyDialog : public GCDialog { GCText input; };',
      'void MyDialog::missing::|OnChanged() {}'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: createWorkspaceIndex()
    });

    assert.strictEqual(hover, null);
  });

  test('does not use GUI receiver path hover for same-named identifiers in the event body', () => {
    const { analysis, position } = analyzeMarked([
      'class MyDialog : public GCDialog {',
      '  GCGroupBox group { GCPushButton button; };',
      '};',
      'void MyDialog::group.button::OnPush() {',
      '  int group;',
      '  |group = 1;',
      '}'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nint group\n```',
      plainText: 'int group'
    });
  });

  test('returns a part type qualified hover for an inline GUI event declaration', () => {
    const { analysis, position } = analyzeMarked([
      'class GCCheckBox : public GCWidget { void OnCreate() {} };',
      'class mydialog : public GCDialog {',
      '  GCCheckBox Check1 { |OnCreate() {} };',
      '};'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nvoid GCCheckBox::OnCreate()\n```',
      plainText: 'void GCCheckBox::OnCreate()'
    });
  });

  test('returns the inherited member hover for an inherited inline GUI event declaration', () => {
    const { analysis, position } = analyzeMarked([
      'class GCWidget { void OnCreate() {} };',
      'class GCButtonGroup : public GCWidget {};',
      'class mydialog : public GCDialog {',
      '  GCButtonGroup { |OnCreate() {} };',
      '};'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nvoid GCWidget::OnCreate()\n```',
      plainText: 'void GCWidget::OnCreate()'
    });
  });

  test('resolves implicit inherited GUI properties in an inline GUI event body', () => {
    const { analysis, position } = analyzeMarked([
      'class GCCheckBox : public GCWidget { string text; };',
      'class mydialog : public GCDialog {',
      '  GCCheckBox Check1 { OnCreate() { |text = "Check1"; } };',
      '};'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nstring GCCheckBox::text\n```',
      plainText: 'string GCCheckBox::text'
    });
  });

  test('resolves implicit dialog GUI parts in an external GUI method body', () => {
    const { analysis, position } = analyzeMarked([
      'class mydialog : public GCDialog {',
      '  GCCheckBox One;',
      '  GCGroupBox box { GCCheckBox Two; };',
      '};',
      'void mydialog::OnCreate() {',
      '  |One.SetChecked(1);',
      '}'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nGCCheckBox mydialog::One\n```',
      plainText: 'GCCheckBox mydialog::One'
    });
  });

  test('resolves implicit nested dialog GUI parts in an external GUI method body', () => {
    const { analysis, position } = analyzeMarked([
      'class mydialog : public GCDialog {',
      '  GCGroupBox box { GCCheckBox Two; };',
      '};',
      'void mydialog::OnCreate() {',
      '  box.|Two.SetChecked(1);',
      '}'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: createWorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nGCCheckBox mydialog::box.Two\n```',
      plainText: 'GCCheckBox mydialog::box.Two'
    });
  });

  test('resolves external GUI event receiver segments from an included GUI class', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'dialog.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, [
      'class MyDialog : public GCDialog {',
      '  GCGroupBox group { GCPushButton button; };',
      '};'
    ].join('\n'));

    const index = createWorkspaceIndex();
    const markedText = [
      '#include "dialog.h"',
      'void MyDialog::group.|button::OnPush() {}'
    ].join('\n');
    const markerOffset = markedText.indexOf('|');
    const text = markedText.replace('|', '');
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text
    });

    const hover = getHover({
      analysis,
      position: positionFromOffset(text, markerOffset),
      workspaceIndex: index
    });

    assertExternalHover(hover, 'GCPushButton MyDialog::group.button', headerPath);
  });
});


const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
