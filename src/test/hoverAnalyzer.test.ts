import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { DocumentAnalyzer } from '../analyzer/documentAnalyzer';
import { getHover } from '../analyzer/hover';
import { WorkspaceIndex } from '../analyzer/workspaceIndex';
import type { AnalysisDeclaration, AnalyzedDocument } from '../types/analysis';

suite('getHover', () => {
  test('returns a function declaration hover at its name', () => {
    const analysis = analyze('void main() {}');

    const hover = getHover({
      analysis,
      position: { line: 0, character: 5 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nvoid main()\n```',
      plainText: 'void main()'
    });
  });

  test('returns qualified hover for method and operator declarations', () => {
    const text = [
      'class FILEIter {',
      '  int Next();',
      '  int operator++ ();',
      '};'
    ].join('\n');
    const analysis = analyze(text);

    const nextHover = getHover({
      analysis,
      position: { line: 1, character: 6 },
      workspaceIndex: {}
    });
    const operatorHover = getHover({
      analysis,
      position: { line: 2, character: 6 },
      workspaceIndex: {}
    });

    assert.strictEqual(nextHover?.plainText, 'int FILEIter::Next()');
    assert.strictEqual(operatorHover?.plainText, 'int FILEIter::operator++ ()');
  });

  test('resolves a local reference to its declaration', () => {
    const analysis = analyze('void main() { int local; local = 1; }');

    const hover = getHover({
      analysis,
      position: { line: 0, character: 26 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nint local\n```',
      plainText: 'int local'
    });
  });

  test('does not resolve a reference to a later declaration in the same scope', () => {
    const analysis = analyze('void main() { local = 1; int local; }');

    const hover = getHover({
      analysis,
      position: { line: 0, character: 14 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.strictEqual(hover, null);
  });

  test('resolves a reference to the nearest preceding declaration in a nested scope', () => {
    const analysis = analyze([
      'void main() {',
      '  int value;',
      '  { struct value {}; value instance; }',
      '}'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position: { line: 2, character: 22 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nstruct value\n```',
      plainText: 'struct value'
    });
  });

  test('returns member hover for a static qualified method call', () => {
    const analysis = analyze([
      'class FILE { static int IsDirectory(string path) {} };',
      'void main() { FILE::IsDirectory("x"); }'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position: { line: 1, character: 20 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nstatic int FILE::IsDirectory(string path)\n```',
      plainText: 'static int FILE::IsDirectory(string path)'
    });
  });

  test('returns class hover for a static qualified receiver', () => {
    const analysis = analyze([
      'class myDlg { static void DoModless() {} };',
      'void main() { myDlg::DoModless(); }'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position: { line: 1, character: 16 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nclass myDlg\n```',
      plainText: 'class myDlg'
    });
  });

  test('resolves a static qualified method from a malformed forced include class', () => {
    const fixture = recoveredStaticMemberFixture();

    const hover = getHover({
      analysis: fixture.analysis,
      position: { line: 0, character: 20 },
      workspaceIndex: fixture.workspaceIndex
    });

    assert.strictEqual(hover?.plainText, 'static int FILE::IsDirectory(string fname)');
  });

  test('returns all duplicate declarations from multiple includes in URI order', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-hover-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const firstPath = path.join(tempDir, 'a.h');
    const secondPath = path.join(tempDir, 'b.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(firstPath, 'class SharedName {};');
    fs.writeFileSync(secondPath, 'struct SharedName {};');

    const index = new WorkspaceIndex();
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: '#include "a.h"\n#include "b.h"\nSharedName value;'
    });

    const hover = getHover({
      analysis,
      position: { line: 2, character: 2 },
      workspaceIndex: index
    });

    assert.deepStrictEqual(index.findVisibleDeclarations(mainUri, 'SharedName').map((declaration) => ({
      uri: declaration.uri,
      detail: declaration.detail
    })), [
      { uri: pathToFileURL(firstPath).toString(), detail: 'class' },
      { uri: pathToFileURL(secondPath).toString(), detail: 'struct' }
    ]);
    assert.deepStrictEqual(hover, {
      markdown: '```axel\nclass SharedName\n```',
      plainText: 'class SharedName'
    });
  });

  test('resolves a parameter reference to its declaration', () => {
    const analysis = analyze('void update(int count) { count = 1; }');

    const hover = getHover({
      analysis,
      position: { line: 0, character: 26 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nint count\n```',
      plainText: 'int count'
    });
  });

  test('resolves method calls through dot and arrow receivers', () => {
    const analysis = analyze([
      'class Widget { void method() {} };',
      'void main() { Widget var; Widget *ptr; var.method(); ptr->method(); }'
    ].join('\n'));

    const dotHover = getHover({
      analysis,
      position: { line: 1, character: 44 },
      workspaceIndex: new WorkspaceIndex()
    });
    const arrowHover = getHover({
      analysis,
      position: { line: 1, character: 59 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(dotHover, {
      markdown: '```axel\nvoid Widget::method()\n```',
      plainText: 'void Widget::method()'
    });
    assert.deepStrictEqual(arrowHover, {
      markdown: '```axel\nvoid Widget::method()\n```',
      plainText: 'void Widget::method()'
    });
  });

  test('does not resolve a method call to a global function with the same name', () => {
    const analysis = analyze([
      'int method() {}',
      'class Widget { void method() {} };',
      'void main() { Widget var; var.method(); }'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position: { line: 2, character: 31 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nvoid Widget::method()\n```',
      plainText: 'void Widget::method()'
    });
  });

  test('resolves inherited method calls through the receiver type base class', () => {
    const { analysis, position } = analyzeMarked([
      'class Base { void inherited() {} };',
      'class Child : public Base {};',
      'void main() { Child child; child.|inherited(); }'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nvoid Base::inherited()\n```',
      plainText: 'void Base::inherited()'
    });
  });

  test('resolves inherited properties through a forced-include base class', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-hover-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, [
      'class Base { int inheritedValue; };',
      'class Child : public Base {};'
    ].join('\n'));

    const index = new WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const markedText = 'void main() { Child child; child.|inheritedValue; }';
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

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nint Base::inheritedValue\n```',
      plainText: 'int Base::inheritedValue'
    });
  });

  test('resolves inherited GUI methods when a recovered base header loses member containers', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-hover-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, [
      'class GCComboBox : public GCWidget {};',
      'void SetCaption(string caption);'
    ].join('\n'));

    const index = new WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
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

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nvoid GCWidget::SetCaption(string caption)\n```',
      plainText: 'void GCWidget::SetCaption(string caption)'
    });
  });

  test('resolves a qualified out-of-class method through its receiver type', () => {
    const analysis = analyze([
      'int measure() {}',
      'class Widget {};',
      'double Widget::measure(float scale) {}',
      'void main() { Widget widget; widget.measure(1); }'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position: { line: 3, character: 36 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\ndouble Widget::measure(float scale)\n```',
      plainText: 'double Widget::measure(float scale)'
    });
  });

  test('returns a qualified hover for a method call resolved from an include', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-hover-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'widget.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, 'class Widget { int Now() {} };');

    const index = new WorkspaceIndex();
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: '#include "widget.h"\nvoid main() { Widget widget; widget.Now(); }'
    });

    const hover = getHover({
      analysis,
      position: { line: 1, character: 37 },
      workspaceIndex: index
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nint Widget::Now()\n```',
      plainText: 'int Widget::Now()'
    });
  });

  test('returns a qualified hover for a method prototype resolved from a forced include', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-hover-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, 'class DATE { double LapTime(); };');

    const index = new WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: 'void main() { DATE d_double; d_double.LapTime(); }'
    });

    const hover = getHover({
      analysis,
      position: { line: 0, character: 39 },
      workspaceIndex: index
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\ndouble DATE::LapTime()\n```',
      plainText: 'double DATE::LapTime()'
    });
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
      workspaceIndex: new WorkspaceIndex()
    });
    const buttonHover = getHover({
      analysis,
      position: { line: 3, character: 41 },
      workspaceIndex: new WorkspaceIndex()
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

  test('resolves a declaration from a resolved include', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-hover-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'types.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, 'class IncludedType {};');

    const index = new WorkspaceIndex();
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: '#include "types.h"\nIncludedType value;'
    });

    const hover = getHover({
      analysis,
      position: { line: 1, character: 16 },
      workspaceIndex: index
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nIncludedType value\n```',
      plainText: 'IncludedType value'
    });
  });

  test('returns resolved include file hover at an include path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-hover-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'types.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, 'class IncludedType {};');
    const index = new WorkspaceIndex();
    const markedText = '#include "|types.h"\nIncludedType value;';
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

    assert.deepStrictEqual(hover, {
      markdown: `\`\`\`text\ninclude: ${headerPath}\n\`\`\``,
      plainText: `include: ${headerPath}`
    });
  });

  test('returns resolved AXEL execution file hover at a command file name', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-hover-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const scriptPath = path.join(tempDir, 'test.axl');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(scriptPath, 'void main() {}');
    const index = new WorkspaceIndex();
    const markedText = 'void main() { string infile; |@test -i `infile`; }';
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

    assert.deepStrictEqual(hover, {
      markdown: `\`\`\`text\naxel: ${scriptPath}\n\`\`\``,
      plainText: `axel: ${scriptPath}`
    });
  });

  test('does not resolve a duplicate workspace name outside the include graph', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-hover-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const includedPath = path.join(tempDir, 'included.h');
    const unrelatedPath = path.join(tempDir, 'unrelated.axl');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(includedPath, 'class SharedName {};');

    const index = new WorkspaceIndex();
    index.indexOpenDocument({
      uri: pathToFileURL(unrelatedPath).toString(),
      version: 1,
      text: 'struct SharedName {};'
    });
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: '#include "included.h"\nSharedName value;'
    });

    const hover = getHover({
      analysis,
      position: { line: 1, character: 13 },
      workspaceIndex: index
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nSharedName value\n```',
      plainText: 'SharedName value'
    });
  });

  test('returns documented built-in hover for printf', () => {
    const analysis = analyze('void main() { printf("value=%d", 1); }');

    const hover = getHover({
      analysis,
      position: { line: 0, character: 14 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: [
        '```axel',
        'int printf(string format, ...)',
        '```',
        '',
        'AXEL standard library output function.'
      ].join('\n'),
      plainText: 'int printf(string format, ...)\nAXEL standard library output function.'
    });
  });

  test('resolves enum member references to their declaration', () => {
    const analysis = analyze('enum Mode { A, B = 2 }; void main() { Mode mode; mode = B; }');

    const hover = getHover({
      analysis,
      position: { line: 0, character: 56 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nenum Mode::B = 2\n```',
      plainText: 'enum Mode::B = 2'
    });
  });

  test('resolves macro references to their definition', () => {
    const analysis = analyze('#define N 100\nvoid main() { int value = N; }');

    const hover = getHover({
      analysis,
      position: { line: 1, character: 26 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\n#define N 100\n```',
      plainText: '#define N 100'
    });
  });

  test('resolves function-like macro references to their definition', () => {
    const analysis = analyze('#define MAX(a, b) ((a) > (b) ? (a) : (b))\nvoid main() { int value = MAX(1, 2); }');

    const hover = getHover({
      analysis,
      position: { line: 1, character: 26 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\n#define MAX(a, b) ((a) > (b) ? (a) : (b))\n```',
      plainText: '#define MAX(a, b) ((a) > (b) ? (a) : (b))'
    });
  });

  test('prefers a local declaration over a built-in name', () => {
    const analysis = analyze('void main() { int printf; printf = 1; }');

    const hover = getHover({
      analysis,
      position: { line: 0, character: 26 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nint printf\n```',
      plainText: 'int printf'
    });
  });

  test('uses forced-include class names in variable hover text', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-hover-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, 'class SystemString {};');

    const index = new WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const analysis = index.indexOpenDocument({
      uri: mainUri,
      version: 1,
      text: 'SystemString label; label = SystemString();'
    });

    const hover = getHover({
      analysis,
      position: { line: 0, character: 20 },
      workspaceIndex: index
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nSystemString label\n```',
      plainText: 'SystemString label'
    });
  });

  test('returns GUI class inheritance hover at the class name', () => {
    const { analysis, position } = analyzeMarked('class |MyDialog : public GCDialog {};');

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
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
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nGCText MyDialog::group.input\n```',
      plainText: 'GCText MyDialog::group.input'
    });
  });

  test('prefers a forced-include function declaration over built-in hover data', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-hover-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, 'void printf(int value);');

    const index = new WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const markedText = 'void main() { |printf(1); }';
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

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nvoid printf(int value)\n```',
      plainText: 'void printf(int value)'
    });
  });

  test('prefers a forced-include typedef over same-name type keyword hover fallback', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-hover-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, 'typedef char * string;');

    const index = new WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const markedText = '|string label;';
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

    assert.deepStrictEqual(hover, {
      markdown: '```axel\ntypedef string\n```',
      plainText: 'typedef string'
    });
  });

  test('resolves this arrow member access inside a method body', () => {
    const { analysis, position } = analyzeMarked([
      'class Base { int inheritedValue; };',
      'class Child : public Base {',
      '  int directValue;',
      '  void update() { this->|inheritedValue = directValue; }',
      '};'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nint Base::inheritedValue\n```',
      plainText: 'int Base::inheritedValue'
    });
  });

  test('resolves this arrow methods inside an out-of-class method body', () => {
    const { analysis, position } = analyzeMarked([
      'class Widget {',
      '  void update();',
      '  int value() {}',
      '};',
      'void Widget::update() { this->|value(); }'
    ].join('\n'));

    const hover = getHover({
      analysis,
      position,
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nint Widget::value()\n```',
      plainText: 'int Widget::value()'
    });
  });

  test('returns a GUI class hover at a GUI part type reference from a forced include', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-hover-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, 'class GCComboBox : public GCWidget {};');

    const index = new WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
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

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nclass GCComboBox : public GCWidget\n```',
      plainText: 'class GCComboBox : public GCWidget'
    });
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
      workspaceIndex: new WorkspaceIndex()
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
      workspaceIndex: new WorkspaceIndex()
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
      workspaceIndex: new WorkspaceIndex()
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
      workspaceIndex: new WorkspaceIndex()
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
      workspaceIndex: new WorkspaceIndex()
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
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nvoid GCCheckBox::OnCreate()\n```',
      plainText: 'void GCCheckBox::OnCreate()'
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
      workspaceIndex: new WorkspaceIndex()
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
      workspaceIndex: new WorkspaceIndex()
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
      workspaceIndex: new WorkspaceIndex()
    });

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nGCCheckBox mydialog::box.Two\n```',
      plainText: 'GCCheckBox mydialog::box.Two'
    });
  });

  test('resolves external GUI event receiver segments from an included GUI class', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-hover-'));
    const mainPath = path.join(tempDir, 'main.axl');
    const headerPath = path.join(tempDir, 'dialog.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(headerPath, [
      'class MyDialog : public GCDialog {',
      '  GCGroupBox group { GCPushButton button; };',
      '};'
    ].join('\n'));

    const index = new WorkspaceIndex();
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

    assert.deepStrictEqual(hover, {
      markdown: '```axel\nGCPushButton MyDialog::group.button\n```',
      plainText: 'GCPushButton MyDialog::group.button'
    });
  });

  test('resolves function and variable token hovers in the real groupbox sample', function () {
    this.timeout(10_000);

    const samplePath = path.normalize('D:/projects/sxm/qt5/userhome/axel_sample/groupbox_sample.axl');
    const forcedIncludePath = path.normalize(
      'D:/projects/work/TypeScript/axel-extension/include/_axel_intellisense_def.h'
    );
    if (!fs.existsSync(samplePath) || !fs.existsSync(forcedIncludePath)) {
      this.skip();
    }

    const text = fs.readFileSync(samplePath, 'utf8');
    const index = new WorkspaceIndex({ forcedIncludeFiles: [forcedIncludePath] });
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
    assertHoverText(analysis, index, { line: 5, character: 4 }, 'void GCButtonGroup::OnCreate()');
    assertHoverText(analysis, index, { line: 5, character: 17 }, 'string GCButtonGroup::text');
    assertHoverText(analysis, index, { line: 9, character: 24 }, 'void GCCheckBox::OnCreate()');
    assertHoverText(analysis, index, { line: 9, character: 37 }, 'string GCCheckBox::text');
    assertHoverText(analysis, index, { line: 23, character: 28 }, 'void GCControlButton::OnCreate()');
    assertHoverText(analysis, index, { line: 23, character: 41 }, 'int GCControlButton::style');
    assertHoverText(analysis, index, { line: 42, character: 1 }, 'void mydialog::SetBoxRadio(int pos)');
    assertHoverText(analysis, index, { line: 59, character: 1 }, 'int printf(string format, ...)');
    assertHoverText(analysis, index, positionOf(text, 'dlg.DoModal();', 'DoModal'), 'int GCDialog::DoModal()');
  });

  test('returns null for an unknown identifier', () => {
    const analysis = analyze('void main() { unknown = 1; }');

    const hover = getHover({
      analysis,
      position: { line: 0, character: 14 },
      workspaceIndex: new WorkspaceIndex()
    });

    assert.strictEqual(hover, null);
  });

  test('does not throw for a syntax-error document', () => {
    const analysis = analyze('void broken( { int recovered;');

    assert.doesNotThrow(() => getHover({
      analysis,
      position: { line: 0, character: 5 },
      workspaceIndex: new WorkspaceIndex()
    }));
  });
});

function analyze(text: string) {
  return new DocumentAnalyzer().analyzeDocument({
    uri: 'file:///main.axl',
    version: 1,
    text
  });
}

function analyzeMarked(markedText: string) {
  const markerOffset = markedText.indexOf('|');
  assert.notStrictEqual(markerOffset, -1);
  const text = markedText.replace('|', '');
  return {
    analysis: analyze(text),
    position: positionFromOffset(text, markerOffset)
  };
}

function assertHoverText(
  analysis: ReturnType<typeof analyze>,
  workspaceIndex: WorkspaceIndex,
  position: { line: number; character: number },
  expectedPlainText: string
): void {
  const hover = getHover({ analysis, position, workspaceIndex });
  assert.strictEqual(hover?.plainText, expectedPlainText);
}

function positionFromOffset(text: string, offset: number) {
  const lines = text.slice(0, offset).split('\n');
  return {
    line: lines.length - 1,
    character: lines[lines.length - 1].length
  };
}

function positionOf(text: string, lineText: string, tokenText: string) {
  const lineStart = text.indexOf(lineText);
  assert.notStrictEqual(lineStart, -1);
  const tokenStart = text.indexOf(tokenText, lineStart);
  assert.notStrictEqual(tokenStart, -1);
  return positionFromOffset(text, tokenStart);
}

function recoveredStaticMemberFixture(): {
  analysis: AnalyzedDocument;
  workspaceIndex: {
    findVisibleDeclarations(sourceUri: string, name: string): AnalysisDeclaration[];
    listVisibleDeclarations(sourceUri: string): AnalysisDeclaration[];
  };
} {
  const mainUri = 'file:///main.axl';
  const headerUri = 'file:///file.h';
  const declarations: AnalysisDeclaration[] = [
    {
      id: `${headerUri}#0:6:FILE`,
      name: 'FILE',
      kind: 'class',
      uri: headerUri,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
      detail: 'class'
    },
    {
      id: `${headerUri}#5:13:IsDirectory`,
      name: 'IsDirectory',
      kind: 'function',
      uri: headerUri,
      range: { start: { line: 5, character: 2 }, end: { line: 5, character: 38 } },
      selectionRange: { start: { line: 5, character: 13 }, end: { line: 5, character: 24 } },
      detail: 'static int IsDirectory(string fname)'
    }
  ];

  return {
    analysis: {
      uri: mainUri,
      version: 1,
      diagnostics: [],
      symbols: [],
      declarations: [],
      references: [{
        name: 'IsDirectory',
        uri: mainUri,
        range: { start: { line: 0, character: 20 }, end: { line: 0, character: 31 } },
        call: true,
        memberAccess: {
          receiverName: 'FILE',
          memberNames: ['IsDirectory']
        }
      }],
      scopes: [],
      includes: [],
      scriptExecutions: [],
      guiClasses: [],
      guiMethods: []
    },
    workspaceIndex: {
      findVisibleDeclarations(_sourceUri: string, name: string): AnalysisDeclaration[] {
        return declarations.filter((declaration) => declaration.name === name);
      },
      listVisibleDeclarations(): AnalysisDeclaration[] {
        return declarations;
      }
    }
  };
}
