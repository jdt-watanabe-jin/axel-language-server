"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const url_1 = require("url");
const completion_1 = require("../analyzer/completion");
const documentAnalyzer_1 = require("../analyzer/documentAnalyzer");
const workspaceIndex_1 = require("../analyzer/workspaceIndex");
suite('getCompletions', () => {
    test('returns declaration keywords at top level', () => {
        const { text, position } = marked('|');
        const analysis = analyze(text);
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
        assertCompletionNames(completions, ['class', 'typedef', '#include']);
    });
    test('inserts preprocessor keyword text after an already typed hash', () => {
        const { text, position } = marked('#|');
        const analysis = analyze(text);
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
        const include = completions.find((completion) => completion.name === '#include');
        assert.strictEqual(include?.insertText, 'include');
    });
    test('returns type names while typing a global declaration', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-completion-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const forcedPath = path.join(tempDir, 'forced.h');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        fs.writeFileSync(forcedPath, 'typedef char * string;\nclass ForcedString : public GCWidget {};');
        const { text, position } = marked('class LocalString {};\nstr|');
        const index = new workspaceIndex_1.WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
        const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: index });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
        assertCompletionNames(completions, ['printf']);
    });
    test('returns type names in object declaration type context', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-completion-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const forcedPath = path.join(tempDir, 'forced.h');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        fs.writeFileSync(forcedPath, 'class ForcedWidget : public GCWidget {};');
        const { text, position } = marked('class LocalType {}; void main() { | value; }');
        const index = new workspaceIndex_1.WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
        const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: index });
        assertCompletionNames(completions, ['LocalType', 'ForcedWidget', 'int', 'string']);
    });
    test('returns GUI base classes after an inheritance access specifier', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-completion-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const forcedPath = path.join(tempDir, 'forced.h');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        fs.writeFileSync(forcedPath, 'class CustomWidget : public GCWidget {};');
        const { text, position } = marked('class MyDialog : public | {};');
        const index = new workspaceIndex_1.WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
        const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: index });
        assertCompletionNames(completions, ['GCDialog', 'GCWidget', 'CustomWidget']);
    });
    test('returns include path candidates without keyword noise', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-completion-'));
        fs.writeFileSync(path.join(tempDir, 'widget.h'), 'class Widget {};');
        fs.writeFileSync(path.join(tempDir, 'dialog.axl'), 'class Dialog {};');
        fs.writeFileSync(path.join(tempDir, 'notes.txt'), 'ignored');
        const mainPath = path.join(tempDir, 'main.axl');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        const { text, position } = marked('#include "|');
        const index = new workspaceIndex_1.WorkspaceIndex({ includeRoots: [tempDir] });
        const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: index });
        assertCompletionNames(completions, ['widget.h', 'dialog.axl']);
        assertNoCompletionNames(completions, ['class', 'if']);
    });
    test('returns path-intellisense include candidates for the current path segment', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-completion-'));
        const uiDir = path.join(tempDir, 'ui');
        fs.mkdirSync(uiDir);
        fs.mkdirSync(path.join(uiDir, 'parts'));
        fs.writeFileSync(path.join(uiDir, 'button.h'), 'class Button {};');
        fs.writeFileSync(path.join(uiDir, 'dialog.axl'), 'class Dialog {};');
        fs.writeFileSync(path.join(uiDir, 'notes.txt'), 'ignored');
        const mainPath = path.join(tempDir, 'main.axl');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        const { text, position } = marked('#include "ui/|');
        const index = new workspaceIndex_1.WorkspaceIndex({ includeRoots: [tempDir] });
        const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: index });
        assert.deepStrictEqual(completions.map((completion) => completion.name), ['button.h', 'dialog.axl', 'parts']);
        assert.deepStrictEqual(completions.map((completion) => completion.insertText), ['button.h', 'dialog.axl', 'parts']);
        assert.deepStrictEqual(completions.map((completion) => completion.filterText), ['ui/button.h', 'ui/dialog.axl', 'ui/parts/']);
    });
    test('returns AXEL execution file candidates after at sign', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-completion-'));
        fs.writeFileSync(path.join(tempDir, 'script.axl'), 'void main() {}');
        fs.writeFileSync(path.join(tempDir, 'types.h'), 'class Ignored {};');
        const mainPath = path.join(tempDir, 'main.axl');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        const { text, position } = marked('void main() { @| }');
        const index = new workspaceIndex_1.WorkspaceIndex({ includeRoots: [tempDir] });
        const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: index });
        assertCompletionNames(completions, ['script.axl']);
        assertNoCompletionNames(completions, ['types.h', 'class', 'if']);
    });
    test('returns local path candidates for angle includes when include roots are not configured', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-completion-'));
        fs.writeFileSync(path.join(tempDir, 'system.h'), 'class SystemHeader {};');
        fs.writeFileSync(path.join(tempDir, 'local.axl'), 'class LocalSource {};');
        fs.writeFileSync(path.join(tempDir, 'notes.txt'), 'ignored');
        const mainPath = path.join(tempDir, 'main.axl');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        const { text, position } = marked('#include <|');
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: index });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
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
        const completions = (0, completion_1.getCompletions)({ analysis, text, position, workspaceIndex: new workspaceIndex_1.WorkspaceIndex() });
        assertCompletionNames(completions, ['box', 'SetBoxRadio', 'One']);
    });
    test('returns a safe list for malformed input', () => {
        const { text, position } = marked('void broken( { |');
        const analysis = analyze(text);
        assert.doesNotThrow(() => (0, completion_1.getCompletions)({
            analysis,
            text,
            position,
            workspaceIndex: new workspaceIndex_1.WorkspaceIndex()
        }));
    });
});
function analyze(text) {
    return new documentAnalyzer_1.DocumentAnalyzer().analyzeDocument({
        uri: 'file:///main.axl',
        version: 1,
        text
    });
}
function marked(markedText) {
    const markerOffset = markedText.indexOf('|');
    assert.notStrictEqual(markerOffset, -1);
    const text = markedText.replace('|', '');
    return {
        text,
        position: positionFromOffset(text, markerOffset)
    };
}
function positionFromOffset(text, offset) {
    const lines = text.slice(0, offset).split('\n');
    return {
        line: lines.length - 1,
        character: lines[lines.length - 1].length
    };
}
function assertCompletionNames(completions, expectedNames) {
    const names = completions.map((completion) => completion.name);
    for (const expectedName of expectedNames) {
        assert.ok(names.includes(expectedName), `Expected completion ${expectedName} in ${names.join(', ')}`);
    }
}
function assertNoCompletionNames(completions, unexpectedNames) {
    const names = completions.map((completion) => completion.name);
    for (const unexpectedName of unexpectedNames) {
        assert.ok(!names.includes(unexpectedName), `Did not expect completion ${unexpectedName} in ${names.join(', ')}`);
    }
}
//# sourceMappingURL=completionAnalyzer.test.js.map