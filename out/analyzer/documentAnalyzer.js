"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentAnalyzer = void 0;
const logger_1 = require("../util/logger");
const axelParser_1 = require("./axelParser");
const diagnostics_1 = require("./diagnostics");
const documentSymbols_1 = require("./documentSymbols");
const guiIndex_1 = require("./guiIndex");
const includeResolver_1 = require("./includeResolver");
const scopeIndex_1 = require("./scopeIndex");
const symbolIndex_1 = require("./symbolIndex");
class DocumentAnalyzer {
    parser;
    logger;
    cache = new Map();
    constructor(parser = (0, axelParser_1.createAxelParser)(), logger = logger_1.NullLogger) {
        this.parser = parser;
        this.logger = logger;
    }
    analyzeDocument(input) {
        const guiClassContextKey = guiClassContextKeyFromInput(input);
        const cached = this.cache.get(input.uri);
        if (cached?.version === input.version && cached.guiClassContextKey === guiClassContextKey) {
            return cached.analysis;
        }
        return (0, logger_1.measureDurationMs)(this.logger, 'document.analyze', { uri: input.uri, version: input.version }, () => {
            const tree = this.parser.parse(input.text);
            const guiClasses = (0, guiIndex_1.buildGuiIndex)(tree.rootNode, input.uri, knownGuiClassMapFromInput(input));
            const guiMethods = (0, guiIndex_1.collectExternalGuiMethods)(tree.rootNode);
            const knownGuiClassNames = new Set([
                ...(input.knownGuiClassNames ?? []),
                ...(input.knownGuiClasses ?? []).map((guiClass) => guiClass.name),
                ...guiClasses.map((guiClass) => guiClass.name)
            ]);
            const syntaxDiagnostics = (0, diagnostics_1.collectSyntaxDiagnostics)(tree.rootNode);
            const symbolIndex = (0, symbolIndex_1.buildSymbolIndex)(tree.rootNode, input.uri, knownGuiClassNames);
            const scopes = (0, scopeIndex_1.buildScopeIndex)(tree.rootNode, input.uri, symbolIndex.declarations);
            const includes = (0, includeResolver_1.collectIncludes)(tree.rootNode);
            const scriptExecutions = (0, includeResolver_1.collectScriptExecutions)(tree.rootNode);
            const analysis = {
                uri: input.uri,
                version: input.version,
                diagnostics: syntaxDiagnostics,
                symbols: (0, documentSymbols_1.collectDocumentSymbols)(tree.rootNode, { guiClasses, guiMethods }),
                declarations: symbolIndex.declarations,
                references: symbolIndex.references,
                scopes,
                includes,
                scriptExecutions,
                guiClasses,
                guiMethods
            };
            this.cache.set(input.uri, {
                version: input.version,
                guiClassContextKey,
                analysis
            });
            return analysis;
        });
    }
    clear(uri) {
        if (uri === undefined) {
            this.cache.clear();
            return;
        }
        this.cache.delete(uri);
    }
}
exports.DocumentAnalyzer = DocumentAnalyzer;
function guiClassContextKeyFromInput(input) {
    return Array.from(knownGuiClassMapFromInput(input))
        .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
        .map(([name, kind]) => `${name}:${kind}`)
        .join('\u0000');
}
function knownGuiClassMapFromInput(input) {
    const classes = new Map();
    for (const name of input.knownGuiClassNames ?? []) {
        classes.set(name, 'guiPart');
    }
    for (const guiClass of input.knownGuiClasses ?? []) {
        if (!classes.has(guiClass.name)) {
            classes.set(guiClass.name, guiClass.kind);
        }
    }
    return classes;
}
//# sourceMappingURL=documentAnalyzer.js.map