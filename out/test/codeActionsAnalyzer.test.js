"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const url_1 = require("url");
const codeActions_1 = require("../analyzer/codeActions");
const workspaceIndex_1 = require("../analyzer/workspaceIndex");
suite('code action analyzer', () => {
    test('returns include quick fix for one unambiguous unknown type candidate', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-code-action-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const headerPath = path.join(tempDir, 'types.h');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        fs.writeFileSync(headerPath, 'class Widget {};');
        const index = new workspaceIndex_1.WorkspaceIndex();
        index.indexDiskDocument(headerPath);
        const analysis = index.indexOpenDocument({
            uri: mainUri,
            version: 1,
            text: 'Widget widget;'
        });
        const actions = (0, codeActions_1.getCodeActions)({
            analysis,
            diagnostics: analysis.diagnostics,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
            workspaceIndex: index
        });
        assert.deepStrictEqual(actions, [{
                title: 'Add include "types.h"',
                kind: 'quickfix',
                diagnostics: [analysis.diagnostics[0]],
                edit: {
                    changes: {
                        [mainUri]: [{
                                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                                newText: '#include "types.h"\n'
                            }]
                    }
                }
            }]);
    });
    test('returns no include quick fix for ambiguous candidates', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-code-action-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const firstPath = path.join(tempDir, 'first.h');
        const secondPath = path.join(tempDir, 'second.h');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        fs.writeFileSync(firstPath, 'class Widget {};');
        fs.writeFileSync(secondPath, 'class Widget {};');
        const index = new workspaceIndex_1.WorkspaceIndex();
        index.indexDiskDocument(firstPath);
        index.indexDiskDocument(secondPath);
        const analysis = index.indexOpenDocument({
            uri: mainUri,
            version: 1,
            text: 'Widget widget;'
        });
        const actions = (0, codeActions_1.getCodeActions)({
            analysis,
            diagnostics: analysis.diagnostics,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
            workspaceIndex: index
        });
        assert.deepStrictEqual(actions, []);
    });
});
//# sourceMappingURL=codeActionsAnalyzer.test.js.map