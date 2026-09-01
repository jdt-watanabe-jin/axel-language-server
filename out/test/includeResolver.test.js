"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const includeResolver_1 = require("../analyzer/includeResolver");
suite('resolveInclude', () => {
    test('resolves quoted includes from the including file directory before APP_AXELPATH roots', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-include-'));
        const sourceDir = path.join(tempDir, 'src');
        const includeRoot = path.join(tempDir, 'include');
        fs.mkdirSync(sourceDir);
        fs.mkdirSync(includeRoot);
        fs.writeFileSync(path.join(sourceDir, 'types.h'), 'int localType;');
        fs.writeFileSync(path.join(includeRoot, 'types.h'), 'int pathType;');
        const result = (0, includeResolver_1.resolveInclude)({
            includingFilePath: path.join(sourceDir, 'main.axl'),
            includeText: '"types.h"',
            includeRoots: [includeRoot]
        });
        assert.strictEqual(result.status, 'resolved');
        assert.strictEqual(result.filePath, path.join(sourceDir, 'types.h'));
    });
    test('resolves angle includes from APP_AXELPATH roots without using the including file directory', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-include-'));
        const sourceDir = path.join(tempDir, 'src');
        const includeRoot = path.join(tempDir, 'include');
        fs.mkdirSync(sourceDir);
        fs.mkdirSync(includeRoot);
        fs.writeFileSync(path.join(sourceDir, 'types.h'), 'int localType;');
        fs.writeFileSync(path.join(includeRoot, 'types.h'), 'int pathType;');
        const result = (0, includeResolver_1.resolveInclude)({
            includingFilePath: path.join(sourceDir, 'main.axl'),
            includeText: '<types.h>',
            includeRoots: [includeRoot]
        });
        assert.strictEqual(result.status, 'resolved');
        assert.strictEqual(result.filePath, path.join(includeRoot, 'types.h'));
    });
    test('returns an unresolved result for missing includes without throwing', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-include-'));
        const result = (0, includeResolver_1.resolveInclude)({
            includingFilePath: path.join(tempDir, 'main.axl'),
            includeText: '"missing.h"',
            includeRoots: []
        });
        assert.deepStrictEqual(result, {
            status: 'unresolved',
            reason: 'not-found',
            includePath: 'missing.h',
            candidates: [path.join(tempDir, 'missing.h')]
        });
    });
});
//# sourceMappingURL=includeResolver.test.js.map