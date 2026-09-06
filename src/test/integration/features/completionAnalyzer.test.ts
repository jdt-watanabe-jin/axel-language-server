import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getCompletions } from '../../../analyzer/completion';
import { analyze, marked } from '../../support/source';
import { useWorkspaceFixtures } from '../../support/workspace';

suite('getCompletions', () => {
  test('excludes prototype parameters from expression completions', () => {
    const { text, position } = marked('int time(int *timer);\nvoid main() { ti| }');
    const analysis = analyze(text);
    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['time']);
    assertNoCompletionNames(completions, ['timer']);
  });

  test('only completes parameters and locals in enclosing scopes', () => {
    const { text, position } = marked([
      'void other(int otherParameter) { int otherLocal; }',
      'void main(int currentParameter) {',
      '  int currentLocal;',
      '  { int expiredLocal; }',
      '  |',
      '  int laterLocal;',
      '}'
    ].join('\n'));
    const analysis = analyze(text);
    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['currentParameter', 'currentLocal', 'other']);
    assertNoCompletionNames(completions, ['otherParameter', 'otherLocal', 'expiredLocal', 'laterLocal']);
  });

  test('excludes parameters and locals from included headers', () => {
    const tempDir = createTempDir();
    try {
      fs.writeFileSync(path.join(tempDir, 'time.h'), [
        'int time(int *timer);',
        'int headerGlobal;',
        'void helper(int headerParameter) { int headerLocal; }'
      ].join('\n'));
      const { text, position } = marked('#include "time.h"\nvoid main() { ti| }');
      const index = createWorkspaceIndex();
      const analysis = index.indexOpenDocument({
        uri: pathToFileURL(path.join(tempDir, 'main.axl')).toString(), version: 1, text
      });
      const completions = getCompletions({ analysis, text, position, workspaceIndex: index });

      assertCompletionNames(completions, ['time', 'helper', 'headerGlobal']);
      assertNoCompletionNames(completions, ['timer', 'headerParameter', 'headerLocal']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  for (const outOfClass of [false, true]) {
    test(`preserves implicit inherited members in ${outOfClass ? 'out-of-class' : 'inline'} methods`, () => {
      const { text, position } = marked([
        'class Base { int inheritedValue; void helper(int hiddenParameter); };',
        'class Other { int unrelatedValue; };',
        outOfClass
          ? 'class Child : public Base { int directValue; void run(); };\nvoid Child::run() { inh| }'
          : 'class Child : public Base { int directValue; void run() { inh| } };'
      ].join('\n'));
      const analysis = analyze(text);
      const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

      assertCompletionNames(completions, ['inheritedValue', 'directValue', 'helper']);
      assertNoCompletionNames(completions, ['hiddenParameter', 'unrelatedValue']);
    });
  }

  for (const definition of [
    'class VGPathData { void T(); };',
    'class VGPathData { void T(); }; void VGPathData::T() {}'
  ]) {
    test(`hides unrelated class methods from bare completion: ${definition}`, () => {
      const { text, position } = marked(`${definition}\nvoid main() { t| }`);
      const analysis = analyze(text);
      const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });
      assertNoCompletionNames(completions, ['T']);
    });
  }

  for (const body of [
    'void main() { VGPathData path; path.t| }',
    'class Derived : public VGPathData { void run() { t| } };'
  ]) {
    test(`preserves class method completion in its receiver context: ${body}`, () => {
      const { text, position } = marked(`class VGPathData { void T(); };\n${body}`);
      const analysis = analyze(text);
      const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });
      assertCompletionNames(completions, ['T']);
      assert.strictEqual(completions.find((item) => item.name === 'T')?.detail, 'void VGPathData::T()');
    });
  }

  test('hides class method prototypes from included headers in ordinary functions', () => {
    const tempDir = createTempDir();
    try {
      fs.writeFileSync(path.join(tempDir, 'path.h'), 'class VGPathData { void T(); };');
      const { text, position } = marked('#include "path.h"\nvoid main() { t| }');
      const index = createWorkspaceIndex();
      const analysis = index.indexOpenDocument({
        uri: pathToFileURL(path.join(tempDir, 'main.axl')).toString(), version: 1, text
      });
      const completions = getCompletions({ analysis, text, position, workspaceIndex: index });
      assertNoCompletionNames(completions, ['T']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  for (const source of [
    'class X { X(int arg) { int local; ar| } };',
    'class X {}; void X(int arg) { int local; ar| }'
  ]) {
    test(`keeps lexical locals when a function shares a class name: ${source}`, () => {
      const { text, position } = marked(source);
      const analysis = analyze(text);
      const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });
      assertCompletionNames(completions, ['arg', 'local']);
    });
  }

  test('completes builtin types while starting a declaration in a function body', () => {
    const { text, position } = marked('void main() { i| }');
    const analysis = analyze(text);
    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });
    assertCompletionNames(completions, ['int', 'int64']);
  });

  test('completes visible class names containing GC in a function body', () => {
    const { text, position } = marked([
      'class GCCustom {};',
      'class MyGCWidget {};',
      'void main() { GC| }'
    ].join('\n'));
    const analysis = analyze(text);
    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });
    assertCompletionNames(completions, ['GCDialog', 'GCCustom', 'MyGCWidget']);
    assert.strictEqual(completions.find((item) => item.name === 'MyGCWidget')?.kind, 'class');
  });

  test('completes included types while starting a declaration in a function body', () => {
    const tempDir = createTempDir();
    try {
      fs.writeFileSync(path.join(tempDir, 'types.h'), 'class GCIncluded {}; typedef int Index;');
      const { text, position } = marked('#include "types.h"\nvoid main() { GC| }');
      const index = createWorkspaceIndex();
      const analysis = index.indexOpenDocument({
        uri: pathToFileURL(path.join(tempDir, 'main.axl')).toString(), version: 1, text
      });
      const completions = getCompletions({ analysis, text, position, workspaceIndex: index });
      assertCompletionNames(completions, ['GCIncluded', 'Index']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('returns declaration keywords at top level', () => {
    const { text, position } = marked('|');
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['class', 'typedef', '#include']);
  });

  test('inserts preprocessor keyword text after an already typed hash', () => {
    const { text, position } = marked('#|');
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });
    const include = completions.find((completion) => completion.name === '#include');

    assert.strictEqual(include?.insertText, 'include');
  });

  test('returns type names while typing a global declaration', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, 'typedef char * string;\nclass ForcedString : public GCWidget {};');
    const { text, position } = marked('class LocalString {};\nstr|');
    const index = createWorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });

    const completions = getCompletions({ analysis, text, position, workspaceIndex: index });

    assertCompletionNames(completions, ['string', 'struct', 'LocalString', 'ForcedString']);
    assert.strictEqual(completions.filter((completion) => completion.name === 'string').length, 1);
    assert.strictEqual(completions.find((completion) => completion.name === 'string')?.kind, 'typedef');
  });

  test('returns visible symbols, enum members, macros, and built-ins in expression context', () => {
    const { text, position } = marked([
      '#define LIMIT 10',
      'enum Mode { Idle, Busy };',
      'void helper() {}',
      'void main() { int local; | }'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, [
      'local',
      'helper',
      'Idle',
      'LIMIT',
      'printf',
      'abs',
      'floor',
      'sin',
      'srand',
      'time',
      'putchar',
      'puts',
      'sprintf',
      'fopen',
      'sleep',
      'msleep'
    ]);
  });

  test('returns prefix-matching built-ins while typing an expression identifier', () => {
    const { text, position } = marked('void main() { pr| }');
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['printf']);
  });

  test('returns type names in object declaration type context', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, 'class ForcedWidget : public GCWidget {};');
    const { text, position } = marked('class LocalType {}; void main() { | value; }');
    const index = createWorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });

    const completions = getCompletions({ analysis, text, position, workspaceIndex: index });

    assertCompletionNames(completions, ['LocalType', 'ForcedWidget', 'int', 'int64', 'string']);
  });

  test('returns GUI base classes after an inheritance access specifier', () => {
    const tempDir = createTempDir();
    const mainPath = path.join(tempDir, 'main.axl');
    const forcedPath = path.join(tempDir, 'forced.h');
    const mainUri = pathToFileURL(mainPath).toString();
    fs.writeFileSync(forcedPath, 'class CustomWidget : public GCWidget {};');
    const { text, position } = marked('class MyDialog : public | {};');
    const index = createWorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
    const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });

    const completions = getCompletions({ analysis, text, position, workspaceIndex: index });

    assertCompletionNames(completions, ['GCDialog', 'GCWidget', 'CustomWidget']);
  });

  test('returns include path candidates without keyword noise', () => {
    const tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, 'widget.h'), 'class Widget {};');
    fs.writeFileSync(path.join(tempDir, 'dialog.axl'), 'class Dialog {};');
    fs.writeFileSync(path.join(tempDir, 'notes.txt'), 'ignored');
    const mainPath = path.join(tempDir, 'main.axl');
    const mainUri = pathToFileURL(mainPath).toString();
    const { text, position } = marked('#include "|');
    const index = createWorkspaceIndex({ includeRoots: [tempDir] });
    const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });

    const completions = getCompletions({ analysis, text, position, workspaceIndex: index });

    assertCompletionNames(completions, ['widget.h', 'dialog.axl']);
    assertNoCompletionNames(completions, ['class', 'if']);
  });

  test('returns path-intellisense include candidates for the current path segment', () => {
    const tempDir = createTempDir();
    const uiDir = path.join(tempDir, 'ui');
    fs.mkdirSync(uiDir);
    fs.mkdirSync(path.join(uiDir, 'parts'));
    fs.writeFileSync(path.join(uiDir, 'button.h'), 'class Button {};');
    fs.writeFileSync(path.join(uiDir, 'dialog.axl'), 'class Dialog {};');
    fs.writeFileSync(path.join(uiDir, 'notes.txt'), 'ignored');
    const mainPath = path.join(tempDir, 'main.axl');
    const mainUri = pathToFileURL(mainPath).toString();
    const { text, position } = marked('#include "ui/|');
    const index = createWorkspaceIndex({ includeRoots: [tempDir] });
    const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });

    const completions = getCompletions({ analysis, text, position, workspaceIndex: index });

    assert.deepStrictEqual(completions.map((completion) => completion.name), ['button.h', 'dialog.axl', 'parts']);
    assert.deepStrictEqual(completions.map((completion) => completion.insertText), ['button.h', 'dialog.axl', 'parts']);
    assert.deepStrictEqual(completions.map((completion) => completion.filterText), ['ui/button.h', 'ui/dialog.axl', 'ui/parts/']);
  });

  test('returns AXEL execution file candidates after at sign', () => {
    const tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, 'script.axl'), 'void main() {}');
    fs.writeFileSync(path.join(tempDir, 'types.h'), 'class Ignored {};');
    const mainPath = path.join(tempDir, 'main.axl');
    const mainUri = pathToFileURL(mainPath).toString();
    const { text, position } = marked('void main() { @| }');
    const index = createWorkspaceIndex({ includeRoots: [tempDir] });
    const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });

    const completions = getCompletions({ analysis, text, position, workspaceIndex: index });

    assertCompletionNames(completions, ['script.axl']);
    assertNoCompletionNames(completions, ['types.h', 'class', 'if']);
  });

  test('returns local path candidates for angle includes when include roots are not configured', () => {
    const tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, 'system.h'), 'class SystemHeader {};');
    fs.writeFileSync(path.join(tempDir, 'local.axl'), 'class LocalSource {};');
    fs.writeFileSync(path.join(tempDir, 'notes.txt'), 'ignored');
    const mainPath = path.join(tempDir, 'main.axl');
    const mainUri = pathToFileURL(mainPath).toString();
    const { text, position } = marked('#include <|');
    const index = createWorkspaceIndex();
    const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });

    const completions = getCompletions({ analysis, text, position, workspaceIndex: index });

    assertCompletionNames(completions, ['system.h', 'local.axl']);
    assertNoCompletionNames(completions, ['notes.txt']);
  });

  test('returns inherited member completions for member access', () => {
    const { text, position } = marked([
      'class Base { int inheritedValue; void inheritedMethod() {} };',
      'class Child : public Base { int directValue; };',
      'void main() { Child child; child.| }'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['directValue', 'inheritedValue', 'inheritedMethod']);
  });

  test('returns class members for this arrow access inside a method body', () => {
    const { text, position } = marked([
      'void unrelatedGlobal() {}',
      'class Base { int inheritedValue; void inheritedMethod() {} };',
      'class Other { int otherValue; void otherMethod() {} };',
      'class Child : public Base {',
      '  int directValue;',
      '  void directMethod() { this->| }',
      '};'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['directValue', 'directMethod', 'inheritedValue', 'inheritedMethod']);
    assertNoCompletionNames(completions, ['unrelatedGlobal', 'otherValue', 'otherMethod', 'printf', 'return']);
  });

  test('keeps this arrow prefix completion scoped to class members', () => {
    const { text, position } = marked([
      'void directGlobal() {}',
      'class Child {',
      '  int directValue;',
      '  void directMethod() { int directLocal; this->d| }',
      '};'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['directValue', 'directMethod']);
    assertNoCompletionNames(completions, ['directGlobal', 'directLocal', 'printf', 'return']);
  });

  test('returns class members for this arrow access inside an out-of-class method body', () => {
    const { text, position } = marked([
      'void unrelatedGlobal() {}',
      'class Other { int otherValue; };',
      'class Widget {',
      '  int value;',
      '  void update();',
      '};',
      'void Widget::update() { this->| }'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['value', 'update']);
    assertNoCompletionNames(completions, ['unrelatedGlobal', 'otherValue', 'printf', 'return']);
  });

  test('keeps out-of-class this arrow prefix completion scoped to class members', () => {
    const { text, position } = marked([
      'void valueGlobal() {}',
      'class Widget {',
      '  int value;',
      '  void update();',
      '};',
      'void Widget::update() { int valueLocal; this->v| }'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['value']);
    assertNoCompletionNames(completions, ['valueGlobal', 'valueLocal', 'printf', 'return']);
  });

  test('returns GUI parts and owner methods after a dialog receiver path', () => {
    const { text, position } = marked([
      'class MyDialog : public GCDialog {',
      '  void Save() {}',
      '  GCGroupBox group { GCPushButton button; };',
      '  GCLabel { GCText anonymousChild; };',
      '};',
      'void MyDialog::|'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['group', 'Save', 'anonymousChild', 'OnOK']);
  });

  test('returns static class members after a qualified receiver', () => {
    const { text, position } = marked([
      'class FILE {',
      '  static int IsDirectory(string path) {}',
      '  static int Exists(string path) {}',
      '};',
      'void main() { FILE::| }'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['IsDirectory', 'Exists']);
    assertNoCompletionNames(completions, ['printf']);
  });

  test('returns child GUI parts and events after nested GUI receiver paths', () => {
    const { text, position } = marked([
      'class MyDialog : public GCDialog {',
      '  GCGroupBox group { GCPushButton button; };',
      '};',
      'void MyDialog::group.|'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['button', 'OnCreate']);
  });

  test('returns GUI events after a complete GUI part receiver', () => {
    const { text, position } = marked([
      'class MyDialog : public GCDialog {',
      '  GCPushButton button;',
      '};',
      'void MyDialog::button::|'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['OnCreate', 'OnPush']);
  });

  test('does not expose unrelated global functions as GUI control methods', () => {
    const { text, position } = marked([
      'void Save() {}',
      'class MyDialog : public GCDialog {',
      '  GCPushButton button;',
      '};',
      'void MyDialog::button::|'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertNoCompletionNames(completions, ['Save']);
  });

  test('returns GUI parts on dialog variable member access', () => {
    const { text, position } = marked([
      'class MyDialog : public GCDialog {',
      '  GCGroupBox group { GCPushButton button; };',
      '};',
      'void main() { MyDialog dialog; dialog.| }'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['group', 'button']);
  });

  test('returns documented GUI events for list view receivers', () => {
    const { text, position } = marked([
      'class MyDialog : public GCDialog {',
      '  GCListView list;',
      '};',
      'void MyDialog::list::|'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, [
      'OnReturnPressed',
      'OnSelectionChanged',
      'OnPressed',
      'OnSpacePressed',
      'OnCollapsed',
      'OnExpanded',
      'OnRightButtonPressed'
    ]);
  });

  test('returns documented GUI events for table receivers', () => {
    const { text, position } = marked([
      'class MyDialog : public GCDialog {',
      '  GCTableView table;',
      '};',
      'void MyDialog::table::|'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['OnCurrentChanged', 'OnValueChanged']);
    assertNoCompletionNames(completions, ['OnReleased']);
  });

  test('returns documented GUI events for slider receivers', () => {
    const { text, position } = marked([
      'class MyDialog : public GCDialog {',
      '  GCSlider slider;',
      '};',
      'void MyDialog::slider::|'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['OnChanged', 'OnPressed', 'OnReleased']);
  });

  test('returns implicit GUI receiver members without hiding local declarations', () => {
    const { text, position } = marked([
      'class MyDialog : public GCDialog {',
      '  void SetBoxRadio(int pos) {}',
      '  GCGroupBox box { GCCheckBox One; };',
      '};',
      'void MyDialog::box.One::OnChanged() {',
      '  int box;',
      '  |',
      '}'
    ].join('\n'));
    const analysis = analyze(text);

    const completions = getCompletions({ analysis, text, position, workspaceIndex: createWorkspaceIndex() });

    assertCompletionNames(completions, ['box', 'SetBoxRadio', 'One']);
  });

  test('returns a safe list for malformed input', () => {
    const { text, position } = marked('void broken( { |');
    const analysis = analyze(text);

    assert.doesNotThrow(() => getCompletions({
      analysis,
      text,
      position,
      workspaceIndex: createWorkspaceIndex()
    }));
  });
});

function assertCompletionNames(
  completions: readonly { name: string }[],
  expectedNames: readonly string[]
): void {
  const names = completions.map((completion) => completion.name);
  for (const expectedName of expectedNames) {
    assert.ok(names.includes(expectedName), `Expected completion ${expectedName} in ${names.join(', ')}`);
  }
}

function assertNoCompletionNames(
  completions: readonly { name: string }[],
  unexpectedNames: readonly string[]
): void {
  const names = completions.map((completion) => completion.name);
  for (const unexpectedName of unexpectedNames) {
    assert.ok(!names.includes(unexpectedName), `Did not expect completion ${unexpectedName} in ${names.join(', ')}`);
  }
}

const { createTempDir, createWorkspaceIndex } = useWorkspaceFixtures();
