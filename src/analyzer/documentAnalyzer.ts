import type * as Parser from 'tree-sitter';
import type {
  AnalysisDiagnostic,
  AnalysisGuiClass,
  AnalysisGuiClassKind,
  AnalysisGuiMethod,
  AnalysisGuiPart,
  AnalysisPosition,
  AnalysisRange,
  AnalysisScope,
  AnalysisSymbol,
  AnalyzeDocumentInput,
  AnalyzedDocument
} from '../types/analysis';
import { measureDurationMs, NullLogger, type AnalysisLogger } from '../util/logger';
import { createAxelParser } from './axelParser';
import { collectSyntaxDiagnostics } from './diagnostics';
import { collectDocumentSymbols } from './documentSymbols';
import { buildGuiIndex, collectExternalGuiMethods } from './guiIndex';
import { collectIncludes, collectScriptExecutions } from './includeResolver';
import { collectInactivePreprocessorRanges } from './preprocessorEvaluation';
import {
  collectPreprocessorSemanticTokenReferences,
  collectPreprocessorSemanticTokens
} from './preprocessorSemanticTokens';
import { buildScopeIndex } from './scopeIndex';
import { buildSymbolIndex } from './symbolIndex';

interface CachedAnalysis {
  version: number;
  analysisContextKey: string;
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
    const analysisContextKey = analysisContextKeyFromInput(input);
    const cached = this.cache.get(input.uri);
    if (cached?.version === input.version && cached.analysisContextKey === analysisContextKey) {
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
      const inactiveRanges = collectInactivePreprocessorRanges(tree.rootNode, input.preprocessorSymbols);
      const syntaxDiagnostics = collectSyntaxDiagnostics(tree.rootNode);
      const symbolIndex = buildSymbolIndex(tree.rootNode, input.uri, knownGuiClassNames);
      const scopes = buildScopeIndex(tree.rootNode, input.uri, symbolIndex.declarations);
      const includes = collectIncludes(tree.rootNode);
      const scriptExecutions = collectScriptExecutions(tree.rootNode);
      const preprocessorSemanticTokens = collectPreprocessorSemanticTokens(tree.rootNode);
      const preprocessorSemanticTokenReferences = collectPreprocessorSemanticTokenReferences(tree.rootNode, input.uri);
      const analysis: AnalyzedDocument = {
        uri: input.uri,
        version: input.version,
        diagnostics: syntaxDiagnostics.filter((diagnostic) => !intersectsAnyInactiveRange(diagnostic.range, inactiveRanges)),
        symbols: filterSymbolsForInactiveRanges(collectDocumentSymbols(tree.rootNode, { guiClasses, guiMethods }), inactiveRanges),
        declarations: symbolIndex.declarations.filter((declaration) => !startsInInactiveRange(declaration.selectionRange, inactiveRanges)),
        references: symbolIndex.references.filter((reference) => !startsInInactiveRange(reference.range, inactiveRanges)),
        semanticTokenReferences: preprocessorSemanticTokenReferences.filter((reference) => !startsInInactiveRange(reference.range, inactiveRanges)),
        semanticTokens: preprocessorSemanticTokens.filter((token) => !startsInInactiveRange(token.range, inactiveRanges)),
        scopes: filterScopesForInactiveRanges(scopes, inactiveRanges),
        includes: includes.filter((include) => !startsInInactiveRange(include.range, inactiveRanges)),
        scriptExecutions: scriptExecutions.filter((execution) => !startsInInactiveRange(execution.selectionRange, inactiveRanges)),
        guiClasses: filterGuiClassesForInactiveRanges(guiClasses, inactiveRanges),
        guiMethods: guiMethods.filter((method) => !startsInInactiveRange(method.range, inactiveRanges)),
        inactiveRanges
      };

      this.cache.set(input.uri, {
        version: input.version,
        analysisContextKey,
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

function analysisContextKeyFromInput(input: AnalyzeDocumentInput): string {
  const guiClassKey = Array.from(knownGuiClassMapFromInput(input))
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .map(([name, kind]) => `${name}:${kind}`)
    .join('\u0000');
  const preprocessorKey = [...(input.preprocessorSymbols ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((symbol) => `${symbol.name}=${symbol.value ?? ''}`)
    .join('\u0000');
  return `${guiClassKey}\u0001${preprocessorKey}`;
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

function filterSymbolsForInactiveRanges(
  symbols: readonly AnalysisSymbol[],
  inactiveRanges: readonly AnalysisRange[]
): AnalysisSymbol[] {
  return symbols.flatMap((symbol) => {
    if (startsInInactiveRange(symbol.selectionRange, inactiveRanges)) {
      return [];
    }

    const children = symbol.children === undefined
      ? undefined
      : filterSymbolsForInactiveRanges(symbol.children, inactiveRanges);
    return [{
      ...symbol,
      ...(children === undefined ? {} : { children })
    }];
  });
}

function filterScopesForInactiveRanges(
  scopes: readonly AnalysisScope[],
  inactiveRanges: readonly AnalysisRange[]
): AnalysisScope[] {
  return scopes.filter((scope) => (
    scope.id === 'global' || !startsInInactiveRange(scope.range, inactiveRanges)
  ));
}

function filterGuiClassesForInactiveRanges(
  guiClasses: readonly AnalysisGuiClass[],
  inactiveRanges: readonly AnalysisRange[]
): AnalysisGuiClass[] {
  return guiClasses
    .filter((guiClass) => !startsInInactiveRange(guiClass.range, inactiveRanges))
    .map((guiClass) => ({
      ...guiClass,
      parts: filterGuiPartsForInactiveRanges(guiClass.parts, inactiveRanges),
      methods: guiClass.methods.filter((method) => !startsInInactiveRange(method.range, inactiveRanges))
    }));
}

function filterGuiPartsForInactiveRanges(
  parts: readonly AnalysisGuiPart[],
  inactiveRanges: readonly AnalysisRange[]
): AnalysisGuiPart[] {
  return parts
    .filter((part) => !startsInInactiveRange(part.selectionRange ?? part.range, inactiveRanges))
    .map((part) => ({
      ...part,
      parts: filterGuiPartsForInactiveRanges(part.parts, inactiveRanges),
      methods: filterGuiMethodsForInactiveRanges(part.methods, inactiveRanges)
    }));
}

function filterGuiMethodsForInactiveRanges(
  methods: readonly AnalysisGuiMethod[],
  inactiveRanges: readonly AnalysisRange[]
): AnalysisGuiMethod[] {
  return methods.filter((method) => !startsInInactiveRange(method.selectionRange ?? method.range, inactiveRanges));
}

function startsInInactiveRange(range: AnalysisRange, inactiveRanges: readonly AnalysisRange[]): boolean {
  return inactiveRanges.some((inactiveRange) => containsPosition(inactiveRange, range.start));
}

function intersectsAnyInactiveRange(range: AnalysisDiagnostic['range'], inactiveRanges: readonly AnalysisRange[]): boolean {
  return inactiveRanges.some((inactiveRange) => rangesIntersect(inactiveRange, range));
}

function rangesIntersect(left: AnalysisRange, right: AnalysisRange): boolean {
  return comparePositions(left.start, right.end) < 0 && comparePositions(right.start, left.end) < 0;
}

function containsPosition(range: AnalysisRange, position: AnalysisPosition): boolean {
  return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) < 0;
}

function comparePositions(left: AnalysisPosition, right: AnalysisPosition): number {
  return left.line - right.line || left.character - right.character;
}
