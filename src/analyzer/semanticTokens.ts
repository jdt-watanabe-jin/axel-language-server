import { resolveImplicitGuiReference, type GuiReferenceInput } from './guiReferenceResolution';
import { resolveSystemMacro } from './systemMacros';
import type {
  AnalysisDeclaration,
  AnalysisGuiMethod,
  AnalysisRange,
  AnalysisReference,
  AnalysisSemanticToken,
  AnalysisSemanticTokenType,
  AnalyzedDocument
} from '../types/analysis';
import {
  compareDeclarations,
  findLocalDeclaration,
  visibleDeclarationsByName,
  type DeclarationResolutionInput,
  type WorkspaceDeclarationLookup
} from './resolution';
import {
  allGuiMethods,
} from './guiResolution';

export function collectSemanticTokens(
  analysis: AnalyzedDocument,
  workspaceIndex: GuiReferenceInput['workspaceIndex'] = {}
): AnalysisSemanticToken[] {
  const cachedWorkspaceIndex = createCachedWorkspaceDeclarationLookup(workspaceIndex);
  const guiMethods = allGuiMethods(analysis);
  const resolutionCache = createSemanticTokenResolutionCache(analysis, cachedWorkspaceIndex, guiMethods);
  const tokens = [
    ...analysis.declarations.flatMap(tokenFromDeclaration),
    ...analysis.references.flatMap((reference) => tokenFromReference(reference, analysis, cachedWorkspaceIndex, resolutionCache)),
    ...(analysis.navigationReferences ?? []).flatMap((reference) => tokenFromReference(reference, analysis, cachedWorkspaceIndex, resolutionCache)),
    ...(analysis.semanticTokenReferences ?? []).flatMap((reference) => tokenFromReference(reference, analysis, cachedWorkspaceIndex, resolutionCache)),
    ...(analysis.semanticTokens ?? []),
    // Written references survive conditional recovery and macro reparsing.
    ...(analysis.systemMacroReferences ?? []).filter(reference =>
      resolveSystemMacro(reference.name, analysis.uri, reference.range.start,
        analysis.tool, analysis.targetPlatform, analysis.internalFeatures)?.defined)
      .map(reference => ({range:reference.range, tokenType:'macro' as const, modifiers:[]})),
    ...analysis.scriptExecutions.map((execution) => ({
      range: execution.selectionRange,
      tokenType: 'function' as const,
      modifiers: []
    })),
    ...guiMethods.flatMap(tokenFromGuiReceiverPath),
    ...guiMethods.flatMap(tokenFromGuiMethodDeclaration)
  ];

  // Expansion-generated functions/members may map onto the written macro name.
  // Emit only its macro token there, preserving the original source classification.
  const writtenMacros: AnalysisSemanticToken[] = (analysis.expandedMacroReferences ?? [])
    .map(reference => ({ range: reference.range, tokenType: 'macro', modifiers: [] }));
  const macroRangesByLine = new Map<number, AnalysisRange[]>();
  for (const token of writtenMacros) {
    const ranges = macroRangesByLine.get(token.range.start.line) ?? [];
    ranges.push(token.range);
    macroRangesByLine.set(token.range.start.line, ranges);
  }
  const visibleTokens = tokens.filter(isSingleLineToken).filter(token =>
    !(macroRangesByLine.get(token.range.start.line) ?? []).some(range =>
      token.range.start.character < range.end.character && range.start.character < token.range.end.character));
  return dedupeAndSort([...visibleTokens, ...writtenMacros]).filter(isSingleLineToken);
}

function createCachedWorkspaceDeclarationLookup(
  workspaceIndex: GuiReferenceInput['workspaceIndex']
): GuiReferenceInput['workspaceIndex'] {
  const visibleDeclarationsByUri = new Map<string, AnalysisDeclaration[]>();
  const visibleDocumentsByUri = new Map<string, AnalyzedDocument[]>();
  const declarationsByUriAndName = new Map<string, Map<string, AnalysisDeclaration[]>>();
  const lookupCache = new Map<string, AnalysisDeclaration[]>();

  function listVisibleDeclarations(uri: string): AnalysisDeclaration[] {
    const cached = visibleDeclarationsByUri.get(uri);
    if (cached !== undefined) {
      return cached;
    }

    const declarations = workspaceIndex.listVisibleDeclarations?.(uri) ?? [];
    visibleDeclarationsByUri.set(uri, declarations);
    return declarations;
  }

  function declarationsByName(uri: string): Map<string, AnalysisDeclaration[]> {
    const cached = declarationsByUriAndName.get(uri);
    if (cached !== undefined) {
      return cached;
    }

    const declarations = createDeclarationsByName([], listVisibleDeclarations(uri));
    declarationsByUriAndName.set(uri, declarations);
    return declarations;
  }

  return {
    findGuiClass: workspaceIndex.findGuiClass?.bind(workspaceIndex),
    listVisibleDocuments: uri => {
      let documents = visibleDocumentsByUri.get(uri);
      if (documents === undefined) {
        documents = workspaceIndex.listVisibleDocuments?.(uri) ?? [];
        visibleDocumentsByUri.set(uri, documents);
      }
      return documents;
    },
    findVisibleDeclarations: (uri, name) => {
      if (workspaceIndex.listVisibleDeclarations !== undefined) {
        return declarationsByName(uri).get(name) ?? [];
      }

      const key = `${uri}\0${name}`;
      const cached = lookupCache.get(key);
      if (cached !== undefined) {
        return cached;
      }

      const declarations = workspaceIndex.findVisibleDeclarations?.(uri, name) ?? [];
      lookupCache.set(key, declarations);
      return declarations;
    },
    ...(workspaceIndex.listVisibleDeclarations === undefined
      ? {}
      : { listVisibleDeclarations })
  };
}

function tokenFromDeclaration(declaration: AnalysisDeclaration): AnalysisSemanticToken[] {
  const tokenType = tokenTypeFromDeclaration(declaration);
  if (tokenType === undefined) {
    return [];
  }

  return [{
    range: declaration.selectionRange,
    tokenType,
    modifiers: ['declaration']
  }];
}

function tokenFromReference(
  reference: AnalysisReference,
  analysis: AnalyzedDocument,
  workspaceIndex: WorkspaceDeclarationLookup,
  resolutionCache: SemanticTokenResolutionCache
): AnalysisSemanticToken[] {
  if (resolutionCache.isGuiMethodSelectionReference(reference)) {
    return [];
  }

  const tokenType = tokenTypeFromReference(reference, analysis, workspaceIndex, resolutionCache);
  if (tokenType === undefined) {
    return [];
  }

  return [{
    range: reference.range,
    tokenType,
    modifiers: []
  }];
}

function tokenTypeFromDeclaration(declaration: AnalysisDeclaration): AnalysisSemanticTokenType | undefined {
  if (isOperatorName(declaration.name)) {
    return 'operator';
  }

  switch (declaration.kind) {
    case 'class':
      return 'class';
    case 'enum':
      return 'enum';
    case 'enumMember':
      return 'enumMember';
    case 'field':
      return 'property';
    case 'function':
      return 'function';
    case 'macro':
      return 'macro';
    case 'method':
      return 'method';
    case 'parameter':
      return 'parameter';
    case 'struct':
    case 'union':
      return 'struct';
    case 'typedef':
      return 'type';
    case 'variable':
      return 'variable';
    case 'include':
      return undefined;
  }
}

function tokenTypeFromReference(
  reference: AnalysisReference,
  analysis: AnalyzedDocument,
  workspaceIndex: WorkspaceDeclarationLookup,
  resolutionCache: SemanticTokenResolutionCache
): AnalysisSemanticTokenType | undefined {
  if (reference.memberAccess !== undefined) {
    return reference.call === true ? 'method' : 'property';
  }

  const resolutionInput = { analysis, workspaceIndex, position: reference.range.start };
  if (reference.typeReference === true) {
    const visibleDeclaration = matchingVisibleDeclaration(reference, resolutionInput, resolutionCache);
    if (visibleDeclaration !== undefined) {
      return tokenTypeFromReferenceDeclaration(reference, visibleDeclaration);
    }
  }

  const localDeclaration = findLocalDeclaration(analysis, reference.name, reference.range.start);
  if (localDeclaration !== undefined && referenceMatchesDeclarationKind(reference, localDeclaration)) {
    return tokenTypeFromReferenceDeclaration(reference, localDeclaration);
  }

  const implicitGuiMember = resolveImplicitGuiReference(resolutionInput, reference)?.declaration;
  if (implicitGuiMember !== undefined) {
    return tokenTypeFromReferenceDeclaration(reference, implicitGuiMember);
  }

  const visibleDeclaration = matchingVisibleDeclaration(reference, resolutionInput, resolutionCache);
  if (visibleDeclaration !== undefined) {
    return tokenTypeFromReferenceDeclaration(reference, visibleDeclaration);
  }

  return undefined;
}

function matchingVisibleDeclaration(
  reference: AnalysisReference,
  input: DeclarationResolutionInput,
  resolutionCache: SemanticTokenResolutionCache
): AnalysisDeclaration | undefined {
  return resolutionCache.visibleDeclarationsByName(input, reference.name)
    .find((declaration) => referenceMatchesDeclarationKind(reference, declaration));
}

function referenceMatchesDeclarationKind(reference: AnalysisReference, declaration: AnalysisDeclaration): boolean {
  if (reference.call === true) {
    return declaration.kind === 'function'
      || declaration.kind === 'method'
      || declaration.kind === 'macro'
      || isFunctionLikeVariableDeclaration(reference, declaration);
  }

  if (reference.typeReference === true) {
    return ['class', 'struct', 'union', 'enum', 'typedef'].includes(declaration.kind);
  }

  return true;
}

function tokenTypeFromReferenceDeclaration(
  reference: AnalysisReference,
  declaration: AnalysisDeclaration
): AnalysisSemanticTokenType | undefined {
  if (isFunctionLikeVariableDeclaration(reference, declaration)) {
    return declaration.containerName === undefined ? 'function' : 'method';
  }

  return tokenTypeFromDeclaration(declaration);
}

function isFunctionLikeVariableDeclaration(
  reference: AnalysisReference,
  declaration: AnalysisDeclaration
): boolean {
  return reference.call === true
    && declaration.kind === 'variable'
    && declaration.detail.includes(`${declaration.name}(`);
}

function isOperatorName(name: string): boolean {
  return name.startsWith('operator');
}

interface SemanticTokenResolutionCache {
  isGuiMethodSelectionReference(reference: AnalysisReference): boolean;
  visibleDeclarationsByName(input: DeclarationResolutionInput, name: string): AnalysisDeclaration[];

}

function createSemanticTokenResolutionCache(
  analysis: AnalyzedDocument,
  workspaceIndex: WorkspaceDeclarationLookup,
  guiMethods: AnalysisGuiMethod[]
): SemanticTokenResolutionCache {
  let visibleDeclarations: AnalysisDeclaration[] | undefined;
  let visibleDeclarationIndex: Map<string, AnalysisDeclaration[]> | undefined;
  const declarationsByName = new Map<string, AnalysisDeclaration[]>();

  function listVisibleDeclarations(): AnalysisDeclaration[] | undefined {
    visibleDeclarations ??= workspaceIndex.listVisibleDeclarations?.(analysis.uri);
    return visibleDeclarations;
  }

  const methodSelections = new Map<string, AnalysisRange[]>();
  for (const method of guiMethods) {
    if (!method.selectionRange) { continue; }
    const ranges = methodSelections.get(method.name) ?? [];
    ranges.push(method.selectionRange);
    methodSelections.set(method.name, ranges);
  }

  return {
    isGuiMethodSelectionReference: reference => (methodSelections.get(reference.name) ?? [])
      .some(range => sameRange(range, reference.range)),
    visibleDeclarationsByName: (input, name) => {
      if (input.analysis.uri !== analysis.uri) {
        return visibleDeclarationsByName(input, name);
      }

      const cached = declarationsByName.get(name);
      if (cached !== undefined) {
        return cached;
      }

      const listed = listVisibleDeclarations();
      if (listed !== undefined && visibleDeclarationIndex === undefined) {
        visibleDeclarationIndex = createDeclarationsByName(analysis.declarations, listed);
      }
      const declarations = visibleDeclarationIndex === undefined
        ? visibleDeclarationsByName(input, name)
        : visibleDeclarationIndex.get(name) ?? [];
      declarationsByName.set(name, declarations);
      return declarations;
    }
  };
}

function createDeclarationsByName(
  localDeclarations: readonly AnalysisDeclaration[],
  visibleDeclarations: readonly AnalysisDeclaration[]
): Map<string, AnalysisDeclaration[]> {
  const declarationsById = new Map([
    ...localDeclarations,
    ...visibleDeclarations
  ].map((declaration) => [declaration.id, declaration]));
  const declarationsByName = new Map<string, AnalysisDeclaration[]>();
  for (const declaration of declarationsById.values()) {
    const declarations = declarationsByName.get(declaration.name) ?? [];
    declarations.push(declaration);
    declarationsByName.set(declaration.name, declarations);
  }

  for (const declarations of declarationsByName.values()) {
    declarations.sort(compareDeclarations);
  }
  return declarationsByName;
}

function tokenFromGuiMethodDeclaration(method: AnalysisGuiMethod): AnalysisSemanticToken[] {
  if (method.selectionRange === undefined || method.receiverPathSegmentRanges !== undefined) {
    return [];
  }

  return [{
    range: method.selectionRange,
    tokenType: 'method',
    modifiers: ['declaration']
  }];
}

function tokenFromGuiReceiverPath(method: AnalysisGuiMethod): AnalysisSemanticToken[] {
  const ranges = method.receiverPathSegmentRanges;
  if (ranges === undefined || ranges.length !== method.receiverPath.length || ranges.length < 2) {
    return [];
  }

  return ranges.map((range, index) => ({
    range,
    tokenType: guiReceiverPathSegmentTokenType(index, ranges.length),
    modifiers: index === ranges.length - 1 ? ['declaration'] : []
  }));
}

function guiReceiverPathSegmentTokenType(
  index: number,
  segmentCount: number
): AnalysisSemanticTokenType {
  if (index === 0) {
    return 'class';
  }

  return index === segmentCount - 1 ? 'function' : 'variable';
}

function sameRange(left: AnalysisRange, right: AnalysisRange): boolean {
  return left.start.line === right.start.line
    && left.start.character === right.start.character
    && left.end.line === right.end.line
    && left.end.character === right.end.character;
}

function dedupeAndSort(tokens: AnalysisSemanticToken[]): AnalysisSemanticToken[] {
  const seen = new Set<string>();
  return [...tokens]
    .sort(compareTokens)
    .filter((token) => {
      const key = tokenKey(token);
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}

function compareTokens(left: AnalysisSemanticToken, right: AnalysisSemanticToken): number {
  return left.range.start.line - right.range.start.line
    || left.range.start.character - right.range.start.character
    || tokenLength(left) - tokenLength(right)
    || left.tokenType.localeCompare(right.tokenType);
}

function isSingleLineToken(token: AnalysisSemanticToken): boolean {
  return token.range.start.line === token.range.end.line && tokenLength(token) > 0;
}

function tokenLength(token: AnalysisSemanticToken): number {
  return token.range.end.character - token.range.start.character;
}

function tokenKey(token: AnalysisSemanticToken): string {
  return [
    token.range.start.line,
    token.range.start.character,
    token.range.end.line,
    token.range.end.character,
    token.tokenType
  ].join(':');
}
