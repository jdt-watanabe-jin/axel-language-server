import { resolveAmbiguousCalls } from './ambiguousCalls';
import { recoverMacroCommands } from './macroCommands';
import { buildTypeSnapshot } from './typeChecking/syntax';
import type * as Parser from 'tree-sitter';
import { message } from '../i18n/messages';
import { normalizeTargetPlatform } from './targetPlatform';
import { collectSystemMacroSyntax, isSystemMacroName, normalizeInternalFeatures, normalizeTool, resolveSystemMacro } from './systemMacros';
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
import { collectMacroInvocations } from './macroInvocation';
import { collectMacroDefinitions } from './macroIndex';
import { evaluatePreprocessor } from './preprocessorEvaluation';
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
      const systemSyntax = collectSystemMacroSyntax(tree.rootNode);
      const guiClasses = buildGuiIndex(tree.rootNode, input.uri, knownGuiClassMapFromInput(input));
      const guiMethods = collectExternalGuiMethods(tree.rootNode);
      const knownGuiClassNames = new Set([
        ...(input.knownGuiClassNames ?? []),
        ...(input.knownGuiClasses ?? []).map((guiClass) => guiClass.name),
        ...guiClasses.map((guiClass) => guiClass.name)
      ]);
      const { inactiveRanges, uncertainRanges, uncertainNames } = evaluatePreprocessor(tree.rootNode, input.preprocessorSymbols, input.tool, input.targetPlatform, input.internalFeatures);
      const macroDefinitions = collectMacroDefinitions(tree.rootNode, input.uri);
      const activeMacroDefinitions = macroDefinitions.filter((macro) => !isSystemMacroName(macro.name)
        && !startsInInactiveRange(macro.selectionRange, [...inactiveRanges, ...uncertainRanges]));
      const visibleMacroDefinitions = [
        ...(input.macroDefinitions ?? []),
        ...activeMacroDefinitions.map((macro) => ({
          ...macro,
          visibilityStart: macro.range.end
        }))
      ].sort(compareMacroVisibility);
      const recoveredCommands = recoverMacroCommands(tree.rootNode,input.uri,visibleMacroDefinitions,
        [...inactiveRanges,...uncertainRanges], text=>this.parser.parse(text).rootNode);
      const symbolIndex = buildSymbolIndex(tree.rootNode, input.uri, knownGuiClassNames);
      const recoveredCalls = resolveAmbiguousCalls(tree.rootNode,input.uri,symbolIndex.declarations,
        [...inactiveRanges,...uncertainRanges],text=>this.parser.parse(text).rootNode);
      const recoveredStatements = [...recoveredCommands,...recoveredCalls];
      const recoveredStatementRanges = recoveredStatements.map(statement=>statement.range);
      const syntaxDiagnostics = collectSyntaxDiagnostics(tree.rootNode, {
        uri: input.uri,
        macroDefinitions: visibleMacroDefinitions,
        parseText: (text) => this.parser.parse(text).rootNode
      });
      symbolIndex.declarations = symbolIndex.declarations.filter(declaration=>!startsInInactiveRange(declaration.selectionRange,recoveredStatementRanges));
      symbolIndex.references = [...symbolIndex.references.filter(reference=>!startsInInactiveRange(reference.range,recoveredStatementRanges)),
        ...recoveredStatements.flatMap(statement=>statement.references)];
      const possibleDeclarations = symbolIndex.declarations.filter(declaration =>
        startsInInactiveRange(declaration.selectionRange, uncertainRanges)
        && !startsInInactiveRange(declaration.selectionRange, inactiveRanges)
        && !(declaration.kind === 'macro' && isSystemMacroName(declaration.name)));
      const scopes = buildScopeIndex(tree.rootNode, input.uri, symbolIndex.declarations);
      const includes = collectIncludes(tree.rootNode);
      const scriptExecutions = collectScriptExecutions(tree.rootNode);
      const macroInvocations = collectMacroInvocations(tree.rootNode, input.uri);
      const preprocessorSemanticTokens = collectPreprocessorSemanticTokens(tree.rootNode);
      const preprocessorSemanticTokenReferences = collectPreprocessorSemanticTokenReferences(tree.rootNode, input.uri);
      const analysis: AnalyzedDocument = {
        typeSnapshot: buildTypeSnapshot(tree.rootNode, input.uri, recoveredStatements.map(statement=>statement.node)),
        internalFeatures: normalizeInternalFeatures(input.internalFeatures),
        tool: normalizeTool(input.tool),
        targetPlatform: normalizeTargetPlatform(input.targetPlatform),
        uncertainRanges,
        uncertainDeclarations: possibleDeclarations,
        uncertainMacroDefinitions: macroDefinitions.filter(macro => !isSystemMacroName(macro.name)
          && startsInInactiveRange(macro.selectionRange, uncertainRanges)
          && !startsInInactiveRange(macro.selectionRange, inactiveRanges)),
        uncertainNames: [...new Set([...(input.uncertainNames ?? []), ...uncertainNames, ...possibleDeclarations.map(d => d.name)])],
        systemMacroReferences: systemSyntax.references.filter(ref => !startsInInactiveRange(ref.range, inactiveRanges)),
        completionExcludedRanges: systemSyntax.excludedRanges,
        uri: input.uri,
        version: input.version,
        diagnostics: [
          ...syntaxDiagnostics.filter((diagnostic) => !intersectsAnyInactiveRange(diagnostic.range, [...inactiveRanges,...recoveredStatementRanges])),
          ...systemSyntax.mutations.filter(ref => !startsInInactiveRange(ref.range, inactiveRanges)).map(ref => ({
            severity: 'warning' as const, source: 'axel' as const, range: ref.range,
            ...message("System-defined macro '{0}' cannot be redefined or undefined.", ref.name)
          }))
        ],
        symbols: filterSymbolsForInactiveRanges(collectDocumentSymbols(tree.rootNode, { guiClasses, guiMethods, excludedRanges: [...inactiveRanges, ...recoveredStatementRanges] }), [...inactiveRanges,...recoveredStatementRanges]),
        declarations: symbolIndex.declarations.filter((declaration) => !(declaration.kind === 'macro' && isSystemMacroName(declaration.name))
          && !startsInInactiveRange(declaration.selectionRange, [...inactiveRanges, ...uncertainRanges])),
        references: symbolIndex.references.filter((reference) => !startsInInactiveRange(reference.range, inactiveRanges)),
        macroDefinitions: activeMacroDefinitions,
        macroInvocations: macroInvocations.filter((invocation) => !startsInInactiveRange(invocation.selectionRange, inactiveRanges)),
        semanticTokenReferences: preprocessorSemanticTokenReferences.filter((reference) => !startsInInactiveRange(reference.range, inactiveRanges)),
        semanticTokens: [
          ...preprocessorSemanticTokens.filter((token) => !startsInInactiveRange(token.range, inactiveRanges)),
          ...systemSyntax.references.filter(ref => !startsInInactiveRange(ref.range, inactiveRanges)
            && resolveSystemMacro(ref.name, input.uri, ref.range.start, input.tool, input.targetPlatform, input.internalFeatures)?.defined).map(ref => ({
            range: ref.range, tokenType: 'macro' as const, modifiers: []
          }))
        ],
        scopes: filterScopesForInactiveRanges(scopes, inactiveRanges),
        includes: includes.filter((include) => !startsInInactiveRange(include.range, inactiveRanges)),
        scriptExecutions: scriptExecutions.filter((execution) => !startsInInactiveRange(execution.selectionRange, [...inactiveRanges,...recoveredStatementRanges])),
        guiClasses: filterGuiClassesForInactiveRanges(guiClasses, [...inactiveRanges, ...uncertainRanges]),
        guiMethods: guiMethods.filter((method) => !startsInInactiveRange(method.range, [...inactiveRanges, ...uncertainRanges])),
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
    .map((symbol) => `${symbol.name}=${symbol.value ?? ''}:${symbol.possiblyUndefined ?? false}:${symbol.unknownValue ?? false}:${JSON.stringify(symbol.sourceRange)}`)
    .join('\u0000');
  const macroKey = [...(input.macroDefinitions ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name)
      || left.uri.localeCompare(right.uri)
      || left.selectionRange.start.line - right.selectionRange.start.line
      || left.selectionRange.start.character - right.selectionRange.start.character)
    .map((macro) => {
      const parameters = macro.parameters?.map((parameter) => parameter.label).join(',') ?? '-';
      const visibilityStart = macro.visibilityStart === undefined
        ? '-'
        : `${macro.visibilityStart.line}:${macro.visibilityStart.character}`;
      return `${macro.name}/${parameters}@${visibilityStart}=${macro.replacementText}`;
    })
    .join('\u0000');
  return `${normalizeInternalFeatures(input.internalFeatures)}\u0001${normalizeTool(input.tool)}\u0001${normalizeTargetPlatform(input.targetPlatform)}\u0001${guiClassKey}\u0001${preprocessorKey}\u0001${macroKey}\u0001${(input.uncertainNames ?? []).join('\0')}`;
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

function compareMacroVisibility(
  left: { visibilityStart?: AnalysisPosition },
  right: { visibilityStart?: AnalysisPosition }
): number {
  const fileStart = { line: 0, character: 0 };
  return comparePositions(left.visibilityStart ?? fileStart, right.visibilityStart ?? fileStart);
}
