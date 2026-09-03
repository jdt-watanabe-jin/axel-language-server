import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getSignatureHelp } from '../analyzer/signatureHelp';
import { DocumentAnalyzer } from '../analyzer/documentAnalyzer';
import { WorkspaceIndex } from '../analyzer/workspaceIndex';

suite('getSignatureHelp', () => {
  test('returns the first parameter for an empty call argument list', () => {
    const { analysis, text, position } = analyzeMarked('void foo(int count, string name) {} void main() { foo(|); }');

    const help = getSignatureHelp({
      analysis,
      text,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(help, {
      signatures: [{
        label: 'void foo(int count, string name)',
        parameters: [
          { label: 'int count' },
          { label: 'string name' }
        ]
      }],
      activeSignature: 0,
      activeParameter: 0
    });
  });

  test('returns the second active parameter after a comma', () => {
    const { analysis, text, position } = analyzeMarked('void foo(int count, string name) {} void main() { foo(1, |); }');

    const help = getSignatureHelp({
      analysis,
      text,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.strictEqual(help?.activeParameter, 1);
  });

  test('returns the second active parameter immediately after a comma trigger', () => {
    const { analysis, text, position } = analyzeMarked('void foo(int count, string name) {} void main() { foo(1,|); }');

    const help = getSignatureHelp({
      analysis,
      text,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.strictEqual(help?.activeParameter, 1);
  });

  test('chooses the innermost nested call', () => {
    const { analysis, text, position } = analyzeMarked([
      'int outer(int value) {}',
      'int inner(int left, int right) {}',
      'void main() { outer(inner(1, |)); }'
    ].join('\n'));

    const help = getSignatureHelp({
      analysis,
      text,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.strictEqual(help?.signatures[0].label, 'int inner(int left, int right)');
    assert.strictEqual(help?.activeParameter, 1);
  });

  test('returns null for an unknown callee', () => {
    const { analysis, text, position } = analyzeMarked('void main() { missing(|); }');

    const help = getSignatureHelp({
      analysis,
      text,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.strictEqual(help, null);
  });

  test('returns a signature for a zero-parameter function', () => {
    const { analysis, text, position } = analyzeMarked('void ping() {} void main() { ping(|); }');

    const help = getSignatureHelp({
      analysis,
      text,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(help, {
      signatures: [{
        label: 'void ping()',
        parameters: []
      }],
      activeSignature: 0,
      activeParameter: 0
    });
  });

  test('resolves inherited member call signatures', () => {
    const { analysis, text, position } = analyzeMarked([
      'class Base { void inherited(int value) {} };',
      'class Child : public Base {};',
      'void main() { Child child; child.inherited(|); }'
    ].join('\n'));

    const help = getSignatureHelp({
      analysis,
      text,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.strictEqual(help?.signatures[0].label, 'void inherited(int value)');
    assert.deepStrictEqual(help?.signatures[0].parameters, [{ label: 'int value' }]);
  });

  test('resolves this arrow member call signatures', () => {
    const { analysis, text, position } = analyzeMarked([
      'class Widget {',
      '  void update(int value) {}',
      '  void run() { this->update(|); }',
      '};'
    ].join('\n'));

    const help = getSignatureHelp({
      analysis,
      text,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.strictEqual(help?.signatures[0].label, 'void update(int value)');
  });

  test('resolves the overloaded call signature matching the active argument count', () => {
    const { analysis, text, position } = analyzeMarked([
      'class Version {',
      '  static Version makeVersion(int major) {}',
      '  static Version makeVersion(int major, int minor, int patch, int prerelease = 0, int number = 0) {}',
      '};',
      'void main() { Version::makeVersion(1, 2, 3|); }'
    ].join('\n'));

    const help = getSignatureHelp({
      analysis,
      text,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.strictEqual(
      help?.signatures[0].label,
      'static Version makeVersion(int major, int minor, int patch, int prerelease = 0, int number = 0)'
    );
    assert.strictEqual(help?.activeParameter, 2);
  });

  test('resolves forced-include function signatures', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-signature-help-'));
    const forcedPath = path.join(tempDir, 'forced.h');
    fs.writeFileSync(forcedPath, 'int printf(string format, ...);');
    const markedText = 'void main() { printf("value=%d", |); }';
    const markerOffset = markedText.indexOf('|');
    const text = markedText.replace('|', '');
    const index = new WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const analysis = index.indexOpenDocument({
      uri: pathToFileURL(path.join(tempDir, 'main.axl')).toString(),
      version: 1,
      text
    });

    const help = getSignatureHelp({
      analysis,
      text,
      position: positionFromOffset(text, markerOffset),
      workspaceIndex: index
    });

    assert.deepStrictEqual(help, {
      signatures: [{
        label: 'int printf(string format, ...)',
        parameters: [
          { label: 'string format' },
          { label: '...' }
        ]
      }],
      activeSignature: 0,
      activeParameter: 1
    });
  });

  test('resolves function-like macro signatures', () => {
    const { analysis, text, position } = analyzeMarked('#define MAX(left, right) ((left) > (right) ? (left) : (right))\nvoid main() { MAX(1, |); }');

    const help = getSignatureHelp({
      analysis,
      text,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(help, {
      signatures: [{
        label: '#define MAX(left, right)',
        parameters: [
          { label: 'left' },
          { label: 'right' }
        ]
      }],
      activeSignature: 0,
      activeParameter: 1
    });
  });

  test('resolves dialog-owner method signatures inside GUI part event bodies', () => {
    const { analysis, text, position } = analyzeMarked([
      'class MyDialog : public GCDialog {',
      '  void SetBoxRadio(int index) {}',
      '  GCGroupBox box { GCRadioButton Two { void OnChanged() { SetBoxRadio(|); } }; };',
      '};'
    ].join('\n'));

    const help = getSignatureHelp({
      analysis,
      text,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.strictEqual(help?.signatures[0].label, 'void SetBoxRadio(int index)');
  });

  test('resolves GUI part member call signatures inside GUI event bodies', () => {
    const { analysis, text, position } = analyzeMarked([
      'class GCRadioButton { void SetChecked(int checked) {} };',
      'class MyDialog : public GCDialog {',
      '  GCGroupBox box { GCRadioButton Two { void OnChanged() { box.Two.SetChecked(|); } }; };',
      '};'
    ].join('\n'));

    const help = getSignatureHelp({
      analysis,
      text,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.strictEqual(help?.signatures[0].label, 'void SetChecked(int checked)');
  });
});

function analyzeMarked(markedText: string) {
  const markerOffset = markedText.indexOf('|');
  assert.notStrictEqual(markerOffset, -1);
  const text = markedText.replace('|', '');
  return {
    analysis: new DocumentAnalyzer().analyzeDocument({
      uri: 'file:///main.axl',
      version: 1,
      text
    }),
    text,
    position: positionFromOffset(text, markerOffset)
  };
}

function positionFromOffset(text: string, offset: number) {
  const lines = text.slice(0, offset).split('\n');
  return {
    line: lines.length - 1,
    character: lines[lines.length - 1].length
  };
}
