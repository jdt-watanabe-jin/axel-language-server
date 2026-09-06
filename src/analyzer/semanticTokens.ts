import type {
  AnalysisDeclaration,
  AnalysisGuiMethod,
  AnalysisRange,
  AnalysisReference,
  AnalysisSemanticToken,
  AnalysisSemanticTokenType,
  AnalyzedDocument
} from '../types/analysis';
import { getBuiltinHover } from './builtins';
import {
  compareDeclarations,
  findDeclarationMember as findDeclarationMemberUncached,
  findLocalDeclaration,
  isTypeDeclaration,
  visibleDeclarationsByName,
  type DeclarationResolutionInput,
  type WorkspaceDeclarationLookup
} from './resolution';
import {
  allGuiMethods,
  findEnclosingGuiMethodContext
} from './guiResolution';

export function collectSemanticTokens(
  analysis: AnalyzedDocument,
  workspaceIndex: WorkspaceDeclarationLookup = {}
): AnalysisSemanticToken[] {
  const cachedWorkspaceIndex = createCachedWorkspaceDeclarationLookup(workspaceIndex);
  const resolutionCache = createSemanticTokenResolutionCache(analysis, cachedWorkspaceIndex);
  const tokens = [
    ...analysis.declarations.flatMap(tokenFromDeclaration),
    ...analysis.references.flatMap((reference) => tokenFromReference(reference, analysis, cachedWorkspaceIndex, resolutionCache)),
    ...(analysis.semanticTokenReferences ?? []).flatMap((reference) => tokenFromReference(reference, analysis, cachedWorkspaceIndex, resolutionCache)),
    ...(analysis.semanticTokens ?? []),
    ...analysis.scriptExecutions.map((execution) => ({
      range: execution.selectionRange,
      tokenType: 'function' as const,
      modifiers: []
    })),
    ...guiReceiverPathTokens(analysis),
    ...guiMethodDeclarationTokens(analysis)
  ];

  return dedupeAndSort(tokens).filter(isSingleLineToken);
}

function createCachedWorkspaceDeclarationLookup(
  workspaceIndex: WorkspaceDeclarationLookup
): WorkspaceDeclarationLookup {
  const visibleDeclarationsByUri = new Map<string, AnalysisDeclaration[]>();
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
  if (isGuiMethodSelectionReference(analysis, reference)) {
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

  const implicitGuiMember = findImplicitGuiMemberDeclaration(resolutionInput, reference, resolutionCache);
  if (implicitGuiMember !== undefined) {
    return tokenTypeFromReferenceDeclaration(reference, implicitGuiMember);
  }

  const visibleDeclaration = matchingVisibleDeclaration(reference, resolutionInput, resolutionCache);
  if (visibleDeclaration !== undefined) {
    return tokenTypeFromReferenceDeclaration(reference, visibleDeclaration);
  }

  if (reference.call === true && getBuiltinHover(reference.name) !== null) {
    return 'function';
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

function findImplicitGuiMemberDeclaration(
  input: DeclarationResolutionInput & { analysis: AnalyzedDocument },
  reference: AnalysisReference,
  resolutionCache: SemanticTokenResolutionCache
): AnalysisDeclaration | undefined {
  const context = findEnclosingGuiMethodContext({
    analysis: input.analysis,
    position: reference.range.start
  });
  if (context === undefined) {
    return undefined;
  }

  return resolutionCache.findDeclarationMember(input, context.receiverTypeName, reference.name)
    ?? findRecoveredGuiDeclarationMember(input, context.receiverTypeName, reference, resolutionCache)
    ?? resolutionCache.findDeclarationMember(input, context.rootClassName, reference.name)
    ?? findRecoveredGuiDeclarationMember(input, context.rootClassName, reference, resolutionCache);
}

function findRecoveredGuiDeclarationMember(
  input: DeclarationResolutionInput,
  containerName: string,
  reference: AnalysisReference,
  resolutionCache: SemanticTokenResolutionCache
): AnalysisDeclaration | undefined {
  if (!/^GC[A-Za-z_$][0-9A-Za-z_$]*$/.test(containerName)) {
    return undefined;
  }

  const declaration = resolutionCache.visibleDeclarationsByName(input, reference.name)
    .filter((item) => item.containerName === undefined && isRecoveredGuiMember(item, reference.name))
    .sort(compareDeclarations)[0];
  if (declaration === undefined) {
    return undefined;
  }

  return {
    ...declaration,
    containerName,
    kind: reference.call === true ? 'method' : 'field'
  };
}

function isRecoveredGuiMember(declaration: AnalysisDeclaration, memberName: string): boolean {
  return declaration.detail.includes(`${memberName}(`) || declaration.detail.endsWith(memberName);
}

interface SemanticTokenResolutionCache {
  visibleDeclarationsByName(input: DeclarationResolutionInput, name: string): AnalysisDeclaration[];
  findDeclarationMember(
    input: DeclarationResolutionInput,
    containerName: string,
    memberName: string
  ): AnalysisDeclaration | undefined;
}

function createSemanticTokenResolutionCache(
  analysis: AnalyzedDocument,
  workspaceIndex: WorkspaceDeclarationLookup
): SemanticTokenResolutionCache {
  let visibleDeclarations: AnalysisDeclaration[] | undefined;
  let visibleDeclarationIndex: Map<string, AnalysisDeclaration[]> | undefined;
  let allVisibleDeclarations: AnalysisDeclaration[] | undefined;
  const typeHierarchyDeclarationsByContainerName = new Map<string, Map<string, AnalysisDeclaration[]>>();
  const declarationsByName = new Map<string, AnalysisDeclaration[]>();

  function listVisibleDeclarations(): AnalysisDeclaration[] | undefined {
    visibleDeclarations ??= workspaceIndex.listVisibleDeclarations?.(analysis.uri);
    return visibleDeclarations;
  }

  return {
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
    },
    findDeclarationMember: (input, containerName, memberName) => {
      if (input.analysis.uri !== analysis.uri) {
        return findDeclarationMemberUncached(input, containerName, memberName);
      }

      let declarationsByMemberName = typeHierarchyDeclarationsByContainerName.get(containerName);
      if (declarationsByMemberName === undefined) {
        declarationsByMemberName = createTypeHierarchyDeclarationsByName(
          visibleDeclarationsForInput(input),
          containerName
        );
        typeHierarchyDeclarationsByContainerName.set(containerName, declarationsByMemberName);
      }

      return declarationsByMemberName.get(memberName)?.[0];
    }
  };

  function visibleDeclarationsForInput(input: DeclarationResolutionInput): AnalysisDeclaration[] {
    if (input.analysis.uri !== analysis.uri) {
      return [
        ...input.analysis.declarations,
        ...(input.workspaceIndex.listVisibleDeclarations?.(input.analysis.uri) ?? [])
      ].sort(compareDeclarations);
    }

    allVisibleDeclarations ??= Array.from(new Map([
      ...analysis.declarations,
      ...(listVisibleDeclarations() ?? [])
    ].map((declaration) => [declaration.id, declaration])).values())
      .sort(compareDeclarations);
    return allVisibleDeclarations;
  }
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

function createTypeHierarchyDeclarationsByName(
  visibleDeclarations: readonly AnalysisDeclaration[],
  typeName: string
): Map<string, AnalysisDeclaration[]> {
  const declarations: AnalysisDeclaration[] = [];
  const visited = new Set<string>();

  function visit(currentTypeName: string): void {
    if (visited.has(currentTypeName)) {
      return;
    }

    visited.add(currentTypeName);
    declarations.push(...visibleDeclarations.filter((declaration) => declaration.containerName === currentTypeName));
    declarations.push(...recoveredStaticMemberDeclarations(visibleDeclarations, currentTypeName));

    const baseName = visibleDeclarations
      .find((declaration) => isTypeDeclaration(declaration) && declaration.name === currentTypeName)
      ?.baseName;
    if (baseName !== undefined) {
      visit(baseName);
    }
  }

  visit(typeName);
  return createDeclarationsByName([], declarations);
}

function recoveredStaticMemberDeclarations(
  declarations: readonly AnalysisDeclaration[],
  containerName: string
): AnalysisDeclaration[] {
  return declarations
    .filter((declaration) => declaration.containerName === undefined)
    .filter((declaration) => declaration.detail.startsWith('static '))
    .filter((declaration) => recoveredStaticMemberOwner(declarations, declaration)?.name === containerName)
    .map((declaration) => ({ ...declaration, containerName }));
}

function recoveredStaticMemberOwner(
  declarations: readonly AnalysisDeclaration[],
  member: AnalysisDeclaration
): AnalysisDeclaration | undefined {
  return declarations
    .filter(isTypeDeclaration)
    .filter((declaration) => declaration.uri === member.uri)
    .filter((declaration) => positionBefore(declaration.selectionRange.start, member.selectionRange.start))
    .sort((left, right) => comparePositions(right.selectionRange.start, left.selectionRange.start))[0];
}

function positionBefore(
  left: AnalysisDeclaration['selectionRange']['start'],
  right: AnalysisDeclaration['selectionRange']['start']
): boolean {
  return left.line < right.line || (left.line === right.line && left.character < right.character);
}

function comparePositions(
  left: AnalysisDeclaration['selectionRange']['start'],
  right: AnalysisDeclaration['selectionRange']['start']
): number {
  return left.line - right.line || left.character - right.character;
}

function isGuiMethodSelectionReference(
  analysis: Pick<AnalyzedDocument, 'guiClasses' | 'guiMethods'>,
  reference: AnalysisReference
): boolean {
  return allGuiMethods(analysis).some((method) => (
    method.name === reference.name
    && method.selectionRange !== undefined
    && sameRange(method.selectionRange, reference.range)
  ));
}

function guiReceiverPathTokens(analysis: Pick<AnalyzedDocument, 'guiClasses' | 'guiMethods'>): AnalysisSemanticToken[] {
  return allGuiMethods(analysis)
    .flatMap(tokenFromGuiReceiverPath);
}

function guiMethodDeclarationTokens(
  analysis: Pick<AnalyzedDocument, 'guiClasses' | 'guiMethods'>
): AnalysisSemanticToken[] {
  return allGuiMethods(analysis)
    .flatMap(tokenFromGuiMethodDeclaration);
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
