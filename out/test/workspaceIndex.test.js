"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const url_1 = require("url");
const workspaceIndex_1 = require("../analyzer/workspaceIndex");
suite('WorkspaceIndex', () => {
    test('makes declarations from forced include directories visible to lookup', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
        const forcedDir = path.join(tempDir, 'forced');
        fs.mkdirSync(forcedDir);
        fs.writeFileSync(path.join(forcedDir, 'system.h'), 'class SystemClass {};');
        const index = new workspaceIndex_1.WorkspaceIndex({ forcedIncludeRoots: [forcedDir] });
        index.indexForcedIncludes();
        assert.deepStrictEqual(index.findDeclarations('SystemClass').map((declaration) => declaration.name), ['SystemClass']);
    });
    test('replaces declarations when an opened document version changes', () => {
        const index = new workspaceIndex_1.WorkspaceIndex();
        const uri = 'file:///main.axl';
        index.indexOpenDocument({ uri, version: 1, text: 'int oldName;' });
        index.indexOpenDocument({ uri, version: 2, text: 'int newName;' });
        assert.deepStrictEqual(index.findDeclarations('oldName'), []);
        assert.deepStrictEqual(index.findDeclarations('newName').map((declaration) => declaration.name), ['newName']);
    });
    test('foreground analysis does not synchronously index included disk documents', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const headerPath = path.join(tempDir, 'large.h');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        fs.writeFileSync(headerPath, 'int includedValue;');
        const index = new workspaceIndex_1.WorkspaceIndex();
        const analysis = index.analyzeForegroundDocument({
            uri: mainUri,
            version: 1,
            text: '#include "large.h"\nint mainValue;'
        });
        assert.deepStrictEqual(analysis.declarations.map((declaration) => declaration.name), ['mainValue']);
        assert.deepStrictEqual(index.findDeclarations('includedValue'), []);
    });
    test('foreground analysis emits timing logs when logger is provided', () => {
        const entries = [];
        const index = new workspaceIndex_1.WorkspaceIndex({
            logger: {
                info: (message) => entries.push(message),
                error: () => undefined
            }
        });
        index.analyzeForegroundDocument({
            uri: 'file:///main.axl',
            version: 1,
            text: 'int value;'
        });
        assert.ok(entries.some((entry) => (entry.includes('operation=workspace.foreground')
            && entry.includes('uri=file:///main.axl')
            && /durationMs=\d+/.test(entry))));
    });
    test('foreground analysis indexes included disk documents in the background', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const headerPath = path.join(tempDir, 'types.h');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        fs.writeFileSync(headerPath, 'int backgroundValue;');
        const index = new workspaceIndex_1.WorkspaceIndex();
        index.analyzeForegroundDocument({
            uri: mainUri,
            version: 1,
            text: '#include "types.h"\nint mainValue;'
        });
        await index.waitForBackgroundIndexing();
        assert.deepStrictEqual(index.findDeclarations('backgroundValue').map((declaration) => declaration.name), ['backgroundValue']);
    });
    test('terminates include cycles while indexing reachable disk documents', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const headerPath = path.join(tempDir, 'types.h');
        fs.writeFileSync(mainPath, '#include "types.h"\nint mainValue;');
        fs.writeFileSync(headerPath, '#include "main.axl"\nint headerValue;');
        const index = new workspaceIndex_1.WorkspaceIndex();
        index.indexDiskDocument(mainPath);
        assert.deepStrictEqual(index.findDeclarations('headerValue').map((declaration) => declaration.uri), [(0, url_1.pathToFileURL)(headerPath).toString()]);
    });
    test('finds declarations visible through resolved include edges only', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const includedPath = path.join(tempDir, 'included.h');
        const unrelatedPath = path.join(tempDir, 'unrelated.axl');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        fs.writeFileSync(includedPath, 'class SharedName {};');
        const index = new workspaceIndex_1.WorkspaceIndex();
        index.indexOpenDocument({
            uri: (0, url_1.pathToFileURL)(unrelatedPath).toString(),
            version: 1,
            text: 'struct SharedName {};'
        });
        index.indexOpenDocument({
            uri: mainUri,
            version: 1,
            text: '#include "included.h"\nSharedName value;'
        });
        assert.deepStrictEqual(index.findVisibleDeclarations(mainUri, 'SharedName').map((declaration) => declaration.detail), ['class']);
    });
    test('finds declarations from includes resolved by forced include files', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const forcedPath = path.join(tempDir, 'forced.h');
        const dependencyPath = path.join(tempDir, 'dependency.h');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        fs.writeFileSync(forcedPath, '#include "dependency.h"');
        fs.writeFileSync(dependencyPath, 'class ForcedDependency {};');
        const index = new workspaceIndex_1.WorkspaceIndex({ forcedIncludeFiles: [forcedPath] });
        index.indexOpenDocument({ uri: mainUri, version: 1, text: 'ForcedDependency value;' });
        assert.deepStrictEqual(index.findVisibleDeclarations(mainUri, 'ForcedDependency').map((declaration) => declaration.detail), ['class']);
    });
    test('returns duplicate declarations from multiple forced includes deterministically', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
        const forcedDir = path.join(tempDir, 'forced');
        const mainPath = path.join(tempDir, 'main.axl');
        fs.mkdirSync(forcedDir);
        const firstPath = path.join(forcedDir, 'a.h');
        const secondPath = path.join(forcedDir, 'b.h');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        fs.writeFileSync(firstPath, 'class ForcedShared {};');
        fs.writeFileSync(secondPath, 'struct ForcedShared {};');
        const index = new workspaceIndex_1.WorkspaceIndex({ forcedIncludeRoots: [forcedDir] });
        index.indexOpenDocument({ uri: mainUri, version: 1, text: 'ForcedShared value;' });
        assert.deepStrictEqual(index.findVisibleDeclarations(mainUri, 'ForcedShared').map((declaration) => ({
            uri: declaration.uri,
            detail: declaration.detail
        })), [
            { uri: (0, url_1.pathToFileURL)(firstPath).toString(), detail: 'class' },
            { uri: (0, url_1.pathToFileURL)(secondPath).toString(), detail: 'struct' }
        ]);
    });
    test('caches forced include file discovery until configuration changes', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
        const forcedDir = path.join(tempDir, 'forced');
        const mainPath = path.join(tempDir, 'main.axl');
        const mainUri = (0, url_1.pathToFileURL)(mainPath).toString();
        fs.mkdirSync(forcedDir);
        fs.writeFileSync(path.join(forcedDir, 'a.h'), 'class FirstForced {};');
        const index = new workspaceIndex_1.WorkspaceIndex({ forcedIncludeRoots: [forcedDir] });
        index.indexOpenDocument({ uri: mainUri, version: 1, text: 'FirstForced first;' });
        fs.writeFileSync(path.join(forcedDir, 'b.h'), 'class SecondForced {};');
        assert.deepStrictEqual(index.findVisibleDeclarations(mainUri, 'SecondForced'), []);
        index.configure({ forcedIncludeRoots: [forcedDir] });
        assert.deepStrictEqual(index.findVisibleDeclarations(mainUri, 'SecondForced').map((declaration) => declaration.name), ['SecondForced']);
    });
    test('invalidates dependent documents when an included file changes', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-workspace-'));
        const mainPath = path.join(tempDir, 'main.axl');
        const headerPath = path.join(tempDir, 'types.h');
        fs.writeFileSync(mainPath, '#include "types.h"\nint mainValue;');
        fs.writeFileSync(headerPath, 'int headerValue;');
        const index = new workspaceIndex_1.WorkspaceIndex();
        index.indexDiskDocument(mainPath);
        index.invalidateFile(headerPath);
        assert.deepStrictEqual(index.findDeclarations('mainValue'), []);
        assert.deepStrictEqual(index.findDeclarations('headerValue'), []);
    });
});
//# sourceMappingURL=workspaceIndex.test.js.map