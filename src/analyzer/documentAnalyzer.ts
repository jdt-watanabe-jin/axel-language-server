import { runAnalysisSteps, type AnalysisStep } from '../util/analysisSteps';
import { buildDocumentationBlocks } from './documentation/index';
import { nodeToAnalysisRange } from './syntaxTree';
import { cachedSyntaxNode } from './cachedSyntaxNode';
import { conditionalReparse } from './conditionalReparse';
import { macroReparseSteps } from './macroReparse';
import { collectSyntaxRecovery } from './syntaxRecovery';
import { resolveAmbiguousCalls } from './ambiguousCalls';
import { buildTypeSnapshot } from './typeChecking/syntax';
import type * as Parser from 'tree-sitter';
import { message } from '../i18n/messages';
import { normalizeTargetPlatform } from './targetPlatform';
import { collectSystemMacroSyntax, isSystemMacroName, normalizeInternalFeatures, normalizeTool } from './systemMacros';
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
import { NullLogger, type AnalysisLogger } from '../util/logger';
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
  private readonly syntaxCache = new Map<string, {version:number; roots:Map<string, Parser.SyntaxNode>}>();

  private syntaxRoot(input: AnalyzeDocumentInput, text = input.text): Parser.SyntaxNode {
    let generation = this.syntaxCache.get(input.uri);
    if (!generation || generation.version !== input.version) {
      generation = {version:input.version, roots:new Map()};
      this.syntaxCache.set(input.uri, generation);
    }
    let root = generation.roots.get(text);
    if (!root) {
      root = cachedSyntaxNode(this.parser.parse(text).rootNode);
      generation.roots.set(text,root);
    }
    return root;
  }

  public constructor(parser = createAxelParser(), logger: AnalysisLogger = NullLogger) {
    this.parser = parser;
    this.logger = logger;
  }

  public analyzeDocument(input: AnalyzeDocumentInput, expandMacros = true, dependenciesOnly = false): AnalyzedDocument {
    return runAnalysisSteps(this.analyzeDocumentSteps(input, expandMacros, dependenciesOnly));
  }

  public *analyzeDocumentSteps(input: AnalyzeDocumentInput, expandMacros = true, dependenciesOnly = false): Generator<AnalysisStep, AnalyzedDocument, void> {
    const startedAt = Date.now();
    const analysis = yield* this.computeDocumentSteps(input, expandMacros, dependenciesOnly);
    (this.logger.timing ?? this.logger.info).call(this.logger,
      `[timing] operation=document.analyze uri=${input.uri} version=${input.version} durationMs=${Date.now() - startedAt}`);
    return analysis;
  }

  private *computeDocumentSteps(input: AnalyzeDocumentInput, expandMacros: boolean, dependenciesOnly: boolean): Generator<AnalysisStep, AnalyzedDocument, void> {
    const analysisContextKey = analysisContextKeyFromInput(input) + String(expandMacros) + String(dependenciesOnly);
    const cached = this.cache.get(input.uri);
    if (cached?.version === input.version && cached.analysisContextKey === analysisContextKey) {
      return cached.analysis;
    }

    yield;
    const originalRoot = this.syntaxRoot(input);
    const conditional = originalRoot.hasError
      ? conditionalReparse(input, text => this.parser.parse(text)) : undefined;
    const root = conditional ? this.syntaxRoot(input, conditional.text) : originalRoot;
    yield;
    const systemSyntax = dependenciesOnly ? {references:[],mutations:[],excludedRanges:[]} : collectSystemMacroSyntax(originalRoot);
    yield;
    const guiClasses = buildGuiIndex(root, input.uri, knownGuiClassMapFromInput(input));
    const knownGuiClassNames = new Set([
      ...(input.knownGuiClassNames ?? []),
      ...(input.knownGuiClasses ?? []).map((guiClass) => guiClass.name),
      ...guiClasses.map((guiClass) => guiClass.name)
    ]);
    const { inactiveRanges, uncertainRanges, uncertainNames } = conditional?.evaluation ?? evaluatePreprocessor(root, input.preprocessorSymbols, input.tool, input.targetPlatform, input.internalFeatures);
    yield;
    const macroDefinitions = collectMacroDefinitions(root, input.uri);
    const activeMacroDefinitions = macroDefinitions.filter((macro) => !isSystemMacroName(macro.name)
      && !startsInInactiveRange(macro.selectionRange, [...inactiveRanges, ...uncertainRanges]));
    const visibleMacroDefinitions = [
      ...(input.macroDefinitions ?? []),
      ...activeMacroDefinitions.map((macro) => ({
        ...macro,
        visibilityStart: macro.range.end
      }))
    ].sort(compareMacroVisibility);
    if (dependenciesOnly) {
      const declarations = root.descendantsOfType(['preproc_def','preproc_function_def'])
        .flatMap(node => buildSymbolIndex(node,input.uri).declarations)
        .filter(d => !isSystemMacroName(d.name) && !startsInInactiveRange(d.selectionRange,[...inactiveRanges,...uncertainRanges]));
      let analysis: AnalyzedDocument = {
        uri:input.uri, version:input.version, tool:normalizeTool(input.tool),
        internalFeatures:normalizeInternalFeatures(input.internalFeatures),targetPlatform:normalizeTargetPlatform(input.targetPlatform),
        diagnostics:[], symbols:[], declarations, references:[],
        scopes:[{id:'global',range:nodeToAnalysisRange(root),declarationIds:declarations.map(d=>d.id)}],
        includes:collectIncludes(root, originalRoot).filter(i=>!startsInInactiveRange(i.range,inactiveRanges)),
        scriptExecutions:collectScriptExecutions(root).filter(e=>!startsInInactiveRange(e.selectionRange,inactiveRanges)),
        macroDefinitions:activeMacroDefinitions, macroInvocations:[],
        guiClasses:filterGuiClassesForInactiveRanges(guiClasses,[...inactiveRanges,...uncertainRanges]),
        guiMethods:[],inactiveRanges,uncertainRanges,uncertainNames,
        uncertainMacroDefinitions:macroDefinitions.filter(m=>startsInInactiveRange(m.selectionRange,uncertainRanges)
          && !startsInInactiveRange(m.selectionRange,inactiveRanges))
      };
      if (expandMacros) {
        analysis = yield* macroReparseSteps(root,conditional?.text ?? input.text,analysis,visibleMacroDefinitions,(text,position)=>this.analyzeDocumentSteps({...input,text,
          preprocessorSymbols:input.preprocessorSymbols?.map(symbol=>({...symbol,sourceRange:symbol.sourceRange
            ? {start:position(symbol.sourceRange.start),end:position(symbol.sourceRange.end,true)} : undefined})),
          macroDefinitions:input.macroDefinitions?.map(macro=>({...macro,
            visibilityStart:macro.visibilityStart ? position(macro.visibilityStart) : undefined}))
        },false,true));
      }
      if (conditional) { analysis.inactiveRanges=inactiveRanges; }
      this.cache.set(input.uri,{version:input.version,analysisContextKey,analysis});
      return analysis;
    }
    yield;
    const symbolIndex = buildSymbolIndex(root, input.uri, knownGuiClassNames);
    yield;
    const recoveredCalls = resolveAmbiguousCalls(root,input.uri,symbolIndex.declarations,
      [...inactiveRanges,...uncertainRanges],text=>this.parser.parse(text).rootNode);
    const recoveredStatements = recoveredCalls;
    const recoveredStatementRanges = recoveredStatements.map(statement=>statement.range);
    const syntaxDiagnostics = deferred(() => collectSyntaxDiagnostics(root, {
      uri: input.uri,
      macroDefinitions: visibleMacroDefinitions,
      parseText: (text) => this.parser.parse(text).rootNode
    }));
    symbolIndex.declarations = symbolIndex.declarations.filter(declaration=>!startsInInactiveRange(declaration.selectionRange,recoveredStatementRanges));
    symbolIndex.references = [...symbolIndex.references.filter(reference=>!startsInInactiveRange(reference.range,recoveredStatementRanges)),
      ...recoveredStatements.flatMap(statement=>statement.references)];
    const possibleDeclarations = symbolIndex.declarations.filter(declaration =>
      startsInInactiveRange(declaration.selectionRange, uncertainRanges)
      && !startsInInactiveRange(declaration.selectionRange, inactiveRanges)
      && !(declaration.kind === 'macro' && isSystemMacroName(declaration.name)));
    const scopes = deferred(() => filterScopesForInactiveRanges(buildScopeIndex(root, input.uri, symbolIndex.declarations), inactiveRanges));
    const guiMethods = deferred(() => collectExternalGuiMethods(root));
    yield;
    const includes = collectIncludes(root, originalRoot);
    const macroInvocations = collectMacroInvocations(root, input.uri);
    const finalDiagnostics = deferred(() => [
        ...syntaxDiagnostics().filter((diagnostic) => !intersectsAnyInactiveRange(diagnostic.range, [...inactiveRanges,...recoveredStatementRanges])),
        ...systemSyntax.mutations.filter(ref => !startsInInactiveRange(ref.range, inactiveRanges)).map(ref => ({
          severity: 'warning' as const, source: 'axel' as const, range: ref.range,
          ...message("System-defined macro '{0}' cannot be redefined or undefined.", ref.name)
        }))
      ]);
    // Macro reparsing only needs source provenance here; build final metadata on demand.
    let analysis: AnalyzedDocument = {
      ...(!expandMacros ? {typeSnapshot:buildTypeSnapshot(root,input.uri,recoveredStatements.map(statement=>statement.node))} : {}),
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
      get diagnostics() { return finalDiagnostics(); },
      get symbols() { return filterSymbolsForInactiveRanges(collectDocumentSymbols(root, { guiClasses, guiMethods:guiMethods(), excludedRanges: [...inactiveRanges, ...recoveredStatementRanges] }), [...inactiveRanges,...recoveredStatementRanges]); },
      declarations: symbolIndex.declarations.filter((declaration) => !(declaration.kind === 'macro' && isSystemMacroName(declaration.name))
        && !startsInInactiveRange(declaration.selectionRange, [...inactiveRanges, ...uncertainRanges])),
      references: symbolIndex.references.filter((reference) => !startsInInactiveRange(reference.range, inactiveRanges)),
      macroDefinitions: activeMacroDefinitions,
      macroInvocations: macroInvocations.filter((invocation) => !startsInInactiveRange(invocation.selectionRange, inactiveRanges)),
      get semanticTokenReferences() { return collectPreprocessorSemanticTokenReferences(root, input.uri).filter((reference) => !startsInInactiveRange(reference.range, inactiveRanges)); },
      get semanticTokens() { return collectPreprocessorSemanticTokens(root).filter((token) => !startsInInactiveRange(token.range, inactiveRanges)); },
      get scopes() { return scopes(); },
      includes: includes.filter((include) => !startsInInactiveRange(include.range, inactiveRanges)),
      get scriptExecutions() { return collectScriptExecutions(root).filter((execution) => !startsInInactiveRange(execution.selectionRange, [...inactiveRanges,...recoveredStatementRanges])); },
      guiClasses: filterGuiClassesForInactiveRanges(guiClasses, [...inactiveRanges, ...uncertainRanges]),
      get guiMethods() { return guiMethods().filter((method) => !startsInInactiveRange(method.range, [...inactiveRanges, ...uncertainRanges])); },
      inactiveRanges
    };

    if (expandMacros) {
      analysis = yield* macroReparseSteps(root, conditional?.text ?? input.text, analysis, visibleMacroDefinitions, (text, position) => this.analyzeDocumentSteps({...input, text,
        preprocessorSymbols: input.preprocessorSymbols?.map(symbol => ({...symbol, sourceRange: symbol.sourceRange
          ? {start:position(symbol.sourceRange.start),end:position(symbol.sourceRange.end,true)} : undefined})),
        macroDefinitions: input.macroDefinitions?.map(macro => ({...macro,
          visibilityStart: macro.visibilityStart ? position(macro.visibilityStart) : undefined}))
      }, false));
    }

    yield;
    analysis.syntaxRecovery ??= collectSyntaxRecovery(root, analysis, [...inactiveRanges, ...recoveredStatementRanges]);
    // Copy each field once, yielding between deferred tree passes.
    const materialized: Record<string, unknown> = {};
    for (const key of Object.keys(analysis) as (keyof AnalyzedDocument)[]) {
      materialized[key] = analysis[key];
      yield;
    }
    analysis = materialized as unknown as AnalyzedDocument;
    yield;
    analysis.typeSnapshot ??= buildTypeSnapshot(root,input.uri,recoveredStatements.map(statement=>statement.node));
    if (conditional) {
      analysis.inactiveRanges = inactiveRanges;
      analysis.systemMacroReferences = systemSyntax.references.filter(ref => !startsInInactiveRange(ref.range, inactiveRanges));
    }
    yield;
    analysis.documentationBlocks = buildDocumentationBlocks(originalRoot, input.text, analysis);
    this.cache.set(input.uri, {
      version: input.version,
      analysisContextKey,
      analysis
    });

    return analysis;
  }

  /** Release native syntax views after the workspace has finished this analysis operation. */
  public releaseSyntax(uri: string): void {
    this.syntaxCache.delete(uri);
  }

  public clear(uri?: string): void {
    if (uri === undefined) {
      this.cache.clear();
      this.syntaxCache.clear();
      return;
    }

    this.cache.delete(uri);
    this.syntaxCache.delete(uri);
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

function deferred<T>(create: () => T): () => T {
  let value: T;
  let initialized = false;
  return () => {
    if (!initialized) { value = create(); initialized = true; }
    return value;
  };
}
