"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const documentAnalyzer_1 = require("../analyzer/documentAnalyzer");
suite('DocumentAnalyzer', () => {
    test('analyzes diagnostics and symbols for a document', () => {
        const analyzer = new documentAnalyzer_1.DocumentAnalyzer();
        const result = analyzer.analyzeDocument({
            uri: 'file:///main.axl',
            version: 1,
            text: 'void main() {}'
        });
        assert.strictEqual(result.uri, 'file:///main.axl');
        assert.strictEqual(result.version, 1);
        assert.deepStrictEqual(result.diagnostics, []);
        assert.strictEqual(result.symbols[0].name, 'main');
    });
    test('returns cached analysis for the same uri and version', () => {
        const analyzer = new documentAnalyzer_1.DocumentAnalyzer();
        const first = analyzer.analyzeDocument({
            uri: 'file:///main.axl',
            version: 1,
            text: 'void main() {}'
        });
        const second = analyzer.analyzeDocument({
            uri: 'file:///main.axl',
            version: 1,
            text: 'void changed() {}'
        });
        assert.strictEqual(second, first);
        assert.strictEqual(second.symbols[0].name, 'main');
    });
    test('reanalyzes when document version changes', () => {
        const analyzer = new documentAnalyzer_1.DocumentAnalyzer();
        analyzer.analyzeDocument({
            uri: 'file:///main.axl',
            version: 1,
            text: 'void main() {}'
        });
        const second = analyzer.analyzeDocument({
            uri: 'file:///main.axl',
            version: 2,
            text: 'void changed() {}'
        });
        assert.strictEqual(second.symbols[0].name, 'changed');
    });
    test('composes declaration and type-reference analysis', () => {
        const analyzer = new documentAnalyzer_1.DocumentAnalyzer();
        const result = analyzer.analyzeDocument({
            uri: 'file:///main.axl',
            version: 1,
            text: 'Widget value;'
        });
        assert.deepStrictEqual(result.declarations.map((declaration) => `${declaration.kind}:${declaration.name}`), ['variable:value']);
        assert.strictEqual(result.references[0].name, 'Widget');
    });
    test('includes GUI class analysis in document results', () => {
        const analyzer = new documentAnalyzer_1.DocumentAnalyzer();
        const result = analyzer.analyzeDocument({
            uri: 'file:///main.axl',
            version: 1,
            text: 'class MyDialog : public GCDialog { GCText input; };'
        });
        assert.deepStrictEqual(result.guiClasses.map((guiClass) => ({
            name: guiClass.name,
            baseName: guiClass.baseName,
            kind: guiClass.kind,
            parts: guiClass.parts.map((part) => ({
                name: part.name,
                typeName: part.typeName,
                path: part.path
            }))
        })), [{
                name: 'MyDialog',
                baseName: 'GCDialog',
                kind: 'dialog',
                parts: [{
                        name: 'input',
                        typeName: 'GCText',
                        path: ['input']
                    }]
            }]);
    });
    test('uses same-document GUI classes when extracting reusable part instances', () => {
        const analyzer = new documentAnalyzer_1.DocumentAnalyzer();
        const result = analyzer.analyzeDocument({
            uri: 'file:///main.axl',
            version: 1,
            text: [
                'class CustomWidget : public GCWidget {};',
                'class MyDialog : public GCDialog { CustomWidget custom; };'
            ].join('\n')
        });
        const dialog = result.guiClasses.find((guiClass) => guiClass.name === 'MyDialog');
        assert.ok(dialog !== undefined);
        assert.deepStrictEqual(dialog.parts.map((part) => ({
            name: part.name,
            typeName: part.typeName,
            path: part.path
        })), [{
                name: 'custom',
                typeName: 'CustomWidget',
                path: ['custom']
            }]);
    });
    test('uses indirect same-document GUI classes for parts and declarations', () => {
        const analyzer = new documentAnalyzer_1.DocumentAnalyzer();
        const result = analyzer.analyzeDocument({
            uri: 'file:///main.axl',
            version: 1,
            text: [
                'class CustomWidget : public GCWidget {};',
                'class ReusableWidget : public CustomWidget {};',
                'class MyDialog : public GCDialog { ReusableWidget reusable; };'
            ].join('\n')
        });
        const dialog = result.guiClasses.find((guiClass) => guiClass.name === 'MyDialog');
        assert.ok(dialog !== undefined);
        assert.deepStrictEqual(dialog.parts.map((part) => ({
            name: part.name,
            typeName: part.typeName,
            path: part.path
        })), [{
                name: 'reusable',
                typeName: 'ReusableWidget',
                path: ['reusable']
            }]);
        assert.ok(result.declarations.some((declaration) => (declaration.name === 'reusable'
            && declaration.detail === 'ReusableWidget reusable'
            && declaration.containerName === 'MyDialog')));
    });
    test('emits timing logs when logger is provided', () => {
        const entries = [];
        const analyzer = new documentAnalyzer_1.DocumentAnalyzer(undefined, {
            info: (message) => entries.push(message),
            error: () => undefined
        });
        analyzer.analyzeDocument({
            uri: 'file:///main.axl',
            version: 1,
            text: 'int value;'
        });
        assert.ok(entries.some((entry) => (entry.includes('operation=document.analyze')
            && entry.includes('uri=file:///main.axl')
            && /durationMs=\d+/.test(entry))));
    });
});
//# sourceMappingURL=documentAnalyzer.test.js.map