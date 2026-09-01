"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const url_1 = require("url");
const rename_1 = require("../analyzer/rename");
const documentAnalyzer_1 = require("../analyzer/documentAnalyzer");
const workspaceIndex_1 = require("../analyzer/workspaceIndex");
suite('rename analyzer', () => {
    test('prepare rename succeeds on a local variable reference', () => {
        const { analysis, position } = analyzeMarked('void main() { int local; |local = 1; }');
        assert.deepStrictEqual((0, rename_1.prepareRename)({
            analysis,
            position,
            workspaceIndex: new workspaceIndex_1.WorkspaceIndex()
        }), {
            start: { line: 0, character: 25 },
            end: { line: 0, character: 30 }
        });
    });
    test('prepare rename rejects built-in symbols', () => {
        const { analysis, position } = analyzeMarked('void main() { |printf("x"); }');
        assert.strictEqual((0, rename_1.prepareRename)({
            analysis,
            position,
            workspaceIndex: new workspaceIndex_1.WorkspaceIndex()
        }), null);
    });
    test('rename updates all references in the current file', () => {
        const { analysis, position } = analyzeMarked('void main() { int local; |local = local + 1; }');
        const result = (0, rename_1.getRenameEdits)({
            analysis,
            position,
            newName: 'renamed',
            workspaceIndex: new workspaceIndex_1.WorkspaceIndex()
        });
        assert.deepStrictEqual(result, {
            changes: {
                'file:///main.axl': [
                    edit(0, 18, 23, 'renamed'),
                    edit(0, 25, 30, 'renamed'),
                    edit(0, 33, 38, 'renamed')
                ]
            }
        });
    });
    test('rename updates references across included files', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-rename-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const headerPath = path.join(tempDir, 'shared.h');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        const headerUri = (0, url_1.pathToFileURL)(headerPath).toString();
        fs.writeFileSync(headerPath, 'class Shared {};');
        const markedText = '#include "shared.h"\n|Shared first;';
        const markerOffset = markedText.indexOf('|');
        const text = markedText.replace('|', '');
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.indexOpenDocument({ uri: mainUri, version: 1, text });
        const result = (0, rename_1.getRenameEdits)({
            analysis,
            position: positionFromOffset(text, markerOffset),
            newName: 'Renamed',
            workspaceIndex: index
        });
        assert.deepStrictEqual(result, {
            changes: {
                [mainUri]: [edit(1, 0, 6, 'Renamed')],
                [headerUri]: [edit(0, 6, 12, 'Renamed')]
            }
        });
    });
    test('rename does not update shadowed unrelated names', () => {
        const { analysis, position } = analyzeMarked([
            'void main() {',
            '  int value;',
            '  value = 1;',
            '  { int value; |value = 2; }',
            '}'
        ].join('\n'));
        const result = (0, rename_1.getRenameEdits)({
            analysis,
            position,
            newName: 'inner',
            workspaceIndex: new workspaceIndex_1.WorkspaceIndex()
        });
        assert.deepStrictEqual(result, {
            changes: {
                'file:///main.axl': [
                    edit(3, 8, 13, 'inner'),
                    edit(3, 15, 20, 'inner')
                ]
            }
        });
    });
});
function analyze(text) {
    return new documentAnalyzer_1.DocumentAnalyzer().analyzeDocument({
        uri: 'file:///main.axl',
        version: 1,
        text
    });
}
function analyzeMarked(markedText) {
    const markerOffset = markedText.indexOf('|');
    assert.notStrictEqual(markerOffset, -1);
    const text = markedText.replace('|', '');
    return {
        analysis: analyze(text),
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
function edit(line, start, end, newText) {
    return {
        range: {
            start: { line, character: start },
            end: { line, character: end }
        },
        newText
    };
}
//# sourceMappingURL=renameAnalyzer.test.js.map