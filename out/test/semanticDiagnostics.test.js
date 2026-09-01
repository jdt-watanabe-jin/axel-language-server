"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const url_1 = require("url");
const axelParser_1 = require("../analyzer/axelParser");
const guiIndex_1 = require("../analyzer/guiIndex");
const scopeIndex_1 = require("../analyzer/scopeIndex");
const semanticDiagnostics_1 = require("../analyzer/semanticDiagnostics");
const symbolIndex_1 = require("../analyzer/symbolIndex");
const includeResolver_1 = require("../analyzer/includeResolver");
const workspaceIndex_1 = require("../analyzer/workspaceIndex");
suite('collectSemanticDiagnostics', () => {
    const parser = (0, axelParser_1.createAxelParser)();
    const uri = 'file:///main.axl';
    test('reports duplicate declarations in the same scope', () => {
        const rootNode = parser.parse('void main() { int value; int value; }').rootNode;
        const symbols = (0, symbolIndex_1.buildSymbolIndex)(rootNode, uri);
        const diagnostics = (0, semanticDiagnostics_1.collectSemanticDiagnostics)({
            analysis: {
                uri,
                diagnostics: [],
                declarations: symbols.declarations,
                references: symbols.references,
                scopes: (0, scopeIndex_1.buildScopeIndex)(rootNode, uri, symbols.declarations),
                includes: [],
                guiClasses: [],
                guiMethods: []
            }
        });
        assert.deepStrictEqual(diagnostics.map((diagnostic) => diagnostic.message), [
            "Duplicate declaration 'value'."
        ]);
        assert.deepStrictEqual(diagnostics[0].range, symbols.declarations[2].selectionRange);
    });
    test('does not report declarations with the same name in nested scopes', () => {
        const rootNode = parser.parse('void main() { int value; { int value; } }').rootNode;
        const symbols = (0, symbolIndex_1.buildSymbolIndex)(rootNode, uri);
        const diagnostics = (0, semanticDiagnostics_1.collectSemanticDiagnostics)({
            analysis: {
                uri,
                diagnostics: [],
                declarations: symbols.declarations,
                references: symbols.references,
                scopes: (0, scopeIndex_1.buildScopeIndex)(rootNode, uri, symbols.declarations),
                includes: [],
                guiClasses: [],
                guiMethods: []
            }
        });
        assert.deepStrictEqual(diagnostics, []);
    });
    test('does not report duplicate function prototypes as variable duplicates', () => {
        const rootNode = parser.parse([
            'int printf(string format);',
            'int printf(string format, int value);'
        ].join('\n')).rootNode;
        const symbols = (0, symbolIndex_1.buildSymbolIndex)(rootNode, uri);
        const diagnostics = (0, semanticDiagnostics_1.collectSemanticDiagnostics)({
            analysis: {
                uri,
                diagnostics: [],
                declarations: symbols.declarations,
                references: symbols.references,
                scopes: (0, scopeIndex_1.buildScopeIndex)(rootNode, uri, symbols.declarations),
                includes: [],
                guiClasses: [],
                guiMethods: []
            }
        });
        assert.deepStrictEqual(diagnostics, []);
    });
    test('does not report prototype parameter names as duplicate declarations', () => {
        const rootNode = parser.parse([
            'int first(int value);',
            'int second(int value);'
        ].join('\n')).rootNode;
        const symbols = (0, symbolIndex_1.buildSymbolIndex)(rootNode, uri);
        const diagnostics = (0, semanticDiagnostics_1.collectSemanticDiagnostics)({
            analysis: {
                uri,
                diagnostics: [],
                declarations: symbols.declarations,
                references: symbols.references,
                scopes: (0, scopeIndex_1.buildScopeIndex)(rootNode, uri, symbols.declarations),
                includes: [],
                guiClasses: [],
                guiMethods: []
            }
        });
        assert.deepStrictEqual(diagnostics, []);
    });
    test('does not report macro-prefixed builtin calls as duplicate declarations', () => {
        const rootNode = parser.parse([
            'void main() {',
            '  M_DEBUG printf("first");',
            '  M_DEBUG printf("second");',
            '}'
        ].join('\n')).rootNode;
        const symbols = (0, symbolIndex_1.buildSymbolIndex)(rootNode, uri);
        const diagnostics = (0, semanticDiagnostics_1.collectSemanticDiagnostics)({
            analysis: {
                uri,
                diagnostics: [],
                declarations: symbols.declarations,
                references: symbols.references,
                scopes: (0, scopeIndex_1.buildScopeIndex)(rootNode, uri, symbols.declarations),
                includes: [],
                guiClasses: [],
                guiMethods: []
            }
        });
        assert.deepStrictEqual(diagnostics, []);
    });
    test('reports unresolved GUI receiver path when the root GUI class is known', () => {
        const rootNode = parser.parse([
            'class MyDialog : public GCDialog {',
            '  GCGroupBox group { GCText input; };',
            '};',
            'void MyDialog::group.missing::OnChanged() {}'
        ].join('\n')).rootNode;
        const symbols = (0, symbolIndex_1.buildSymbolIndex)(rootNode, uri);
        const diagnostics = (0, semanticDiagnostics_1.collectSemanticDiagnostics)({
            analysis: {
                uri,
                diagnostics: [],
                declarations: symbols.declarations,
                references: symbols.references,
                scopes: (0, scopeIndex_1.buildScopeIndex)(rootNode, uri, symbols.declarations),
                includes: [],
                guiClasses: (0, guiIndex_1.buildGuiIndex)(rootNode, uri),
                guiMethods: (0, guiIndex_1.collectExternalGuiMethods)(rootNode)
            }
        });
        assert.deepStrictEqual(diagnostics.map((diagnostic) => diagnostic.message), [
            "Unknown GUI receiver path segment 'missing'."
        ]);
    });
    test('does not report unresolved GUI receiver path when the root GUI class is unknown', () => {
        const rootNode = parser.parse('void UnknownDialog::missing::OnChanged() {}').rootNode;
        const symbols = (0, symbolIndex_1.buildSymbolIndex)(rootNode, uri);
        const diagnostics = (0, semanticDiagnostics_1.collectSemanticDiagnostics)({
            analysis: {
                uri,
                diagnostics: [],
                declarations: symbols.declarations,
                references: symbols.references,
                scopes: (0, scopeIndex_1.buildScopeIndex)(rootNode, uri, symbols.declarations),
                includes: [],
                guiClasses: (0, guiIndex_1.buildGuiIndex)(rootNode, uri),
                guiMethods: (0, guiIndex_1.collectExternalGuiMethods)(rootNode)
            }
        });
        assert.deepStrictEqual(diagnostics, []);
    });
    test('reports unresolved GUI receiver paths using included GUI classes', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-diagnostics-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const headerPath = path.join(tempDir, 'dialog.h');
        const uri = (0, url_1.pathToFileURL)(mainPath).toString();
        fs.writeFileSync(headerPath, [
            'class MyDialog : public GCDialog {',
            '  GCGroupBox group { GCText input; };',
            '};'
        ].join('\n'));
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: [
                '#include "dialog.h"',
                'void MyDialog::group.missing::OnChanged() {}'
            ].join('\n')
        });
        assert.deepStrictEqual(analysis.diagnostics.map((diagnostic) => diagnostic.message), [
            "Unknown GUI receiver path segment 'missing'."
        ]);
    });
    test('does not report GUI receiver paths when the included root GUI class is ambiguous', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-diagnostics-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const firstHeaderPath = path.join(tempDir, 'a.h');
        const secondHeaderPath = path.join(tempDir, 'b.h');
        const uri = (0, url_1.pathToFileURL)(mainPath).toString();
        fs.writeFileSync(firstHeaderPath, 'class MyDialog : public GCDialog { GCText first; };');
        fs.writeFileSync(secondHeaderPath, 'class MyDialog : public GCDialog { GCText second; };');
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: [
                '#include "a.h"',
                '#include "b.h"',
                'void MyDialog::missing::OnChanged() {}'
            ].join('\n')
        });
        assert.deepStrictEqual(analysis.diagnostics, []);
    });
    test('suppresses GUI receiver path diagnostics when syntax recovery is unstable', () => {
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: [
                'class MyDialog : public GCDialog { GCText input; };',
                'void MyDialog::missing::OnChanged() { x = ; }'
            ].join('\n')
        });
        assert.ok(analysis.diagnostics.some((diagnostic) => diagnostic.message.startsWith('Syntax error')));
        assert.ok(!analysis.diagnostics.some((diagnostic) => diagnostic.message.startsWith('Unknown GUI receiver')));
    });
    test('reports DoModal calls inside OnCreate for a known dialog class as warnings', () => {
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: [
                'class MyDialog : public GCDialog {',
                '  void OnCreate() {',
                '    DoModal();',
                '  }',
                '};'
            ].join('\n')
        });
        assert.deepStrictEqual(analysis.diagnostics.map((diagnostic) => ({
            severity: diagnostic.severity,
            message: diagnostic.message,
            range: diagnostic.range
        })), [{
                severity: 'warning',
                message: 'DoModal should not be called inside a GCDialog OnCreate handler.',
                range: {
                    start: { line: 2, character: 4 },
                    end: { line: 2, character: 11 }
                }
            }]);
    });
    test('reports DoModal calls inside an external OnCreate for a known dialog class as warnings', () => {
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: [
                'class MyDialog : public GCDialog {};',
                'void MyDialog::OnCreate() {',
                '  DoModal();',
                '}'
            ].join('\n')
        });
        assert.deepStrictEqual(analysis.diagnostics.map((diagnostic) => ({
            severity: diagnostic.severity,
            message: diagnostic.message,
            range: diagnostic.range
        })), [{
                severity: 'warning',
                message: 'DoModal should not be called inside a GCDialog OnCreate handler.',
                range: {
                    start: { line: 2, character: 2 },
                    end: { line: 2, character: 9 }
                }
            }]);
    });
    test('does not report DoModal calls outside OnCreate', () => {
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: [
                'class MyDialog : public GCDialog {',
                '  void open() {',
                '    DoModal();',
                '  }',
                '};'
            ].join('\n')
        });
        assert.deepStrictEqual(analysis.diagnostics, []);
    });
    test('does not report non-call DoModal references inside OnCreate', () => {
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: [
                'class MyDialog : public GCDialog {',
                '  void OnCreate() {',
                '    int DoModal;',
                '    DoModal = 1;',
                '  }',
                '};'
            ].join('\n')
        });
        assert.deepStrictEqual(analysis.diagnostics, []);
    });
});
suite('WorkspaceIndex semantic diagnostics', () => {
    test('reports unresolved type references', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-diagnostics-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const uri = (0, url_1.pathToFileURL)(mainPath).toString();
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: 'MissingType value;'
        });
        assert.deepStrictEqual(analysis.diagnostics.map((diagnostic) => diagnostic.message), [
            "Unknown type 'MissingType'."
        ]);
        assert.deepStrictEqual(analysis.diagnostics[0].range, {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 11 }
        });
    });
    test('does not report type references resolved from includes', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-diagnostics-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const headerPath = path.join(tempDir, 'types.h');
        const uri = (0, url_1.pathToFileURL)(mainPath).toString();
        fs.writeFileSync(headerPath, 'class IncludedType {};');
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: '#include "types.h"\nIncludedType value;'
        });
        assert.deepStrictEqual(analysis.diagnostics, []);
    });
    test('does not report built-in type references', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-diagnostics-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const uri = (0, url_1.pathToFileURL)(mainPath).toString();
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: [
                'bool flag;',
                'natural length;',
                'ipoint origin;',
                'class MyDialog : public GCDialog { GCText input; };'
            ].join('\n')
        });
        assert.deepStrictEqual(analysis.diagnostics, []);
    });
    test('reports unresolved expression identifiers', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-diagnostics-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const uri = (0, url_1.pathToFileURL)(mainPath).toString();
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: 'void main() { unknown = 1; }'
        });
        assert.deepStrictEqual(analysis.diagnostics.map((diagnostic) => diagnostic.message), [
            "Unknown identifier 'unknown'."
        ]);
        assert.deepStrictEqual(analysis.diagnostics[0].range, {
            start: { line: 0, character: 14 },
            end: { line: 0, character: 21 }
        });
    });
    test('does not report known macro and enum member identifiers', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-diagnostics-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const uri = (0, url_1.pathToFileURL)(mainPath).toString();
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: [
                '#define DEBUG 1',
                'enum Mode { ModeRunning };',
                'void main() {',
                '  DEBUG;',
                '  ModeRunning;',
                '}'
            ].join('\n')
        });
        assert.deepStrictEqual(analysis.diagnostics, []);
    });
    test('does not report local and free function identifiers', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-diagnostics-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const uri = (0, url_1.pathToFileURL)(mainPath).toString();
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: [
                'void helper() {}',
                'void main() {',
                '  int local;',
                '  local = 1;',
                '  helper();',
                '}'
            ].join('\n')
        });
        assert.deepStrictEqual(analysis.diagnostics, []);
    });
    test('does not report include-visible and forced-include identifiers', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-diagnostics-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const headerPath = path.join(tempDir, 'symbols.h');
        const forcedPath = path.join(tempDir, 'forced.h');
        const uri = (0, url_1.pathToFileURL)(mainPath).toString();
        fs.writeFileSync(headerPath, 'int includedValue;');
        fs.writeFileSync(forcedPath, 'void forcedHelper() {}');
        const index = new workspaceIndex_1.WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: [
                '#include "symbols.h"',
                'void main() {',
                '  includedValue = 1;',
                '  forcedHelper();',
                '}'
            ].join('\n')
        });
        assert.deepStrictEqual(analysis.diagnostics, []);
    });
    test('does not report inherited and this member identifiers', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-diagnostics-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const uri = (0, url_1.pathToFileURL)(mainPath).toString();
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: [
                'class Base { int inherited; };',
                'class Child : public Base {',
                '  int own;',
                '  void update() {',
                '    this->own = 1;',
                '    this->inherited = 2;',
                '  }',
                '};'
            ].join('\n')
        });
        assert.deepStrictEqual(analysis.diagnostics, []);
    });
    test('does not report implicit GUI event body identifiers', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-diagnostics-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const uri = (0, url_1.pathToFileURL)(mainPath).toString();
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: [
                'class GCWidget { string text; };',
                'class MyDialog : public GCDialog {',
                '  GCText input;',
                '};',
                'void MyDialog::input::OnCreate() {',
                '  text = "ready";',
                '}'
            ].join('\n')
        });
        assert.deepStrictEqual(analysis.diagnostics, []);
    });
    test('reports unresolved includes at the include path range', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-diagnostics-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const uri = (0, url_1.pathToFileURL)(mainPath).toString();
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: '#include "missing.h"\nint value;'
        });
        assert.deepStrictEqual(analysis.diagnostics.map((diagnostic) => diagnostic.message), [
            "Include file not found: 'missing.h'."
        ]);
        assert.deepStrictEqual(analysis.diagnostics[0].range, (0, includeResolver_1.collectIncludes)((0, axelParser_1.createAxelParser)().parse('#include "missing.h"\nint value;').rootNode)[0].range);
    });
    test('reports unresolved AXEL execution files at the command file range', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-diagnostics-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const uri = (0, url_1.pathToFileURL)(mainPath).toString();
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: 'void main() { string infile; @missing -i `infile`; }'
        });
        assert.deepStrictEqual(analysis.diagnostics.map((diagnostic) => diagnostic.message), [
            "AXEL execution file not found: 'missing'."
        ]);
        assert.deepStrictEqual(analysis.diagnostics[0].range, {
            start: { line: 0, character: 29 },
            end: { line: 0, character: 37 }
        });
    });
    test('limits diagnostics deterministically by maxNumberOfProblems', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-diagnostics-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const uri = (0, url_1.pathToFileURL)(mainPath).toString();
        const index = new workspaceIndex_1.WorkspaceIndex({ maxNumberOfProblems: 1 });
        const analysis = index.indexOpenDocument({
            uri,
            version: 1,
            text: '#include "missing.h"\nvoid main() { int value; int value; }'
        });
        assert.deepStrictEqual(analysis.diagnostics.map((diagnostic) => diagnostic.message), [
            "Include file not found: 'missing.h'."
        ]);
    });
});
//# sourceMappingURL=semanticDiagnostics.test.js.map