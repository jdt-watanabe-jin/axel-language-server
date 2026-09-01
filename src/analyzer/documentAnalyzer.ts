import type * as Parser from 'tree-sitter';
import type { AnalysisGuiClassKind, AnalyzeDocumentInput, AnalyzedDocument } from '../types/analysis';
import { measureDurationMs, NullLogger, type AnalysisLogger } from '../util/logger';
import { createAxelParser } from './axelParser';
import { collectSyntaxDiagnostics } from './diagnostics';
import { collectDocumentSymbols } from './documentSymbols';
import { buildGuiIndex, collectExternalGuiMethods } from './guiIndex';
import { collectIncludes, collectScriptExecutions } from './includeResolver';
import { buildScopeIndex } from './scopeIndex';
import { buildSymbolIndex } from './symbolIndex';

interface CachedAnalysis {
  version: number;
  guiClassContextKey: string;
  analysis: AnalyzedDocument;
}

export class DocumentAnalyzer {
  private readonly parser: Parser;
  private readonly logger: AnalysisLogger;
  private readonly cache = new Map<string, CachedAnalysis>();

  public constructor(parser = createAxelParser(), logger: AnalysisLogger = NullLogger) {
    this.parser = parser;
    this.logger = logger;
  }

  public analyzeDocument(input: AnalyzeDocumentInput): AnalyzedDocument {
    const guiClassContextKey = guiClassContextKeyFromInput(input);
    const cached = this.cache.get(input.uri);
    if (cached?.version === input.version && cached.guiClassContextKey === guiClassContextKey) {
      return cached.analysis;
    }

    return measureDurationMs(this.logger, 'document.analyze', { uri: input.uri, version: input.version }, () => {
      const tree = this.parser.parse(input.text);
      const guiClasses = buildGuiIndex(tree.rootNode, input.uri, knownGuiClassMapFromInput(input));
      const guiMethods = collectExternalGuiMethods(tree.rootNode);
      const knownGuiClassNames = new Set([
        ...(input.knownGuiClassNames ?? []),
        ...(input.knownGuiClasses ?? []).map((guiClass) => guiClass.name),
        ...guiClasses.map((guiClass) => guiClass.name)
      ]);
      const syntaxDiagnostics = collectSyntaxDiagnostics(tree.rootNode);
      const symbolIndex = buildSymbolIndex(tree.rootNode, input.uri, knownGuiClassNames);
      const scopes = buildScopeIndex(tree.rootNode, input.uri, symbolIndex.declarations);
      const includes = collectIncludes(tree.rootNode);
      const scriptExecutions = collectScriptExecutions(tree.rootNode);
      const analysis: AnalyzedDocument = {
        uri: input.uri,
        version: input.version,
        diagnostics: syntaxDiagnostics,
        symbols: collectDocumentSymbols(tree.rootNode, { guiClasses, guiMethods }),
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

  public clear(uri?: string): void {
    if (uri === undefined) {
      this.cache.clear();
      return;
    }

    this.cache.delete(uri);
  }
}

function guiClassContextKeyFromInput(input: AnalyzeDocumentInput): string {
  return Array.from(knownGuiClassMapFromInput(input))
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .map(([name, kind]) => `${name}:${kind}`)
    .join('\u0000');
}

function knownGuiClassMapFromInput(input: AnalyzeDocumentInput): ReadonlyMap<string, AnalysisGuiClassKind> {
  const classes = new Map<string, AnalysisGuiClassKind>();
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
