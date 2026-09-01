"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const url_1 = require("url");
const semanticTokens_1 = require("../analyzer/semanticTokens");
const workspaceIndex_1 = require("../analyzer/workspaceIndex");
suite('performance benchmark', () => {
    test('foreground open and cached semantic tokens avoid eager include indexing', async () => {
        const fixture = createBenchmarkFixture(120);
        const index = new workspaceIndex_1.WorkspaceIndex();
        const open = measure(() => index.analyzeForegroundDocument({
            uri: fixture.mainUri,
            version: 1,
            text: fixture.mainText
        }));
        const tokens = measure(() => (0, semanticTokens_1.collectSemanticTokens)(open.value));
        const cachedOpen = measure(() => index.analyzeForegroundDocument({
            uri: fixture.mainUri,
            version: 1,
            text: fixture.mainText
        }));
        assert.strictEqual(cachedOpen.value, open.value);
        assert.deepStrictEqual(index.findDeclarations('Included119'), []);
        assert.ok(open.durationMs < 250, `foreground open took ${open.durationMs.toFixed(1)}ms`);
        assert.ok(cachedOpen.durationMs < 25, `cached foreground open took ${cachedOpen.durationMs.toFixed(1)}ms`);
        assert.ok(tokens.durationMs < 100, `semantic token collection took ${tokens.durationMs.toFixed(1)}ms`);
        await index.waitForBackgroundIndexing();
        assert.deepStrictEqual(index.findDeclarations('Included119').map((declaration) => declaration.name), ['Included119']);
        if (process.env.AXEL_LS_BENCHMARK === '1') {
            console.log([
                `foregroundOpenMs=${open.durationMs.toFixed(1)}`,
                `cachedOpenMs=${cachedOpen.durationMs.toFixed(1)}`,
                `semanticTokensMs=${tokens.durationMs.toFixed(1)}`
            ].join(' '));
        }
    });
});
function measure(work) {
    const startedAt = performance.now();
    const value = work();
    return {
        value,
        durationMs: performance.now() - startedAt
    };
}
function createBenchmarkFixture(includeCount) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-benchmark-'));
    const includes = [];
    for (let index = 0; index < includeCount; index += 1) {
        const fileName = `included${index}.h`;
        fs.writeFileSync(path.join(tempDir, fileName), [
            `class Included${index} {};`,
            `int includedValue${index};`
        ].join('\n'));
        includes.push(`#include "${fileName}"`);
    }
    const mainPath = path.join(tempDir, 'main.axl');
    const mainText = [
        ...includes,
        'class MainClass {};',
        'int mainValue;',
        'void main() {',
        '  mainValue = 1;',
        '}'
    ].join('\n');
    fs.writeFileSync(mainPath, mainText);
    return {
        mainUri: (0, url_1.pathToFileURL)(mainPath).toString(),
        mainText
    };
}
//# sourceMappingURL=performanceBenchmark.test.js.map