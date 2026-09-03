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
  findDeclarationMember,
  findLocalDeclaration,
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
  const tokens = [
    ...analysis.declarations.flatMap(tokenFromDeclaration),
    ...analysis.references.flatMap((reference) => tokenFromReference(reference, analysis, workspaceIndex)),
    ...(analysis.semanticTokenReferences ?? []).flatMap((reference) => tokenFromReference(reference, analysis, workspaceIndex)),
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
  workspaceIndex: WorkspaceDeclarationLookup
): AnalysisSemanticToken[] {
  if (isGuiMethodSelectionReference(analysis, reference)) {
    return [];
  }

  const tokenType = tokenTypeFromReference(reference, analysis, workspaceIndex);
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
  workspaceIndex: WorkspaceDeclarationLookup
): AnalysisSemanticTokenType | undefined {
  if (reference.memberAccess !== undefined) {
    return reference.call === true ? 'method' : 'property';
  }

  const resolutionInput = { analysis, workspaceIndex, position: reference.range.start };
  if (reference.typeReference === true) {
    const visibleDeclaration = matchingVisibleDeclaration(reference, resolutionInput);
    if (visibleDeclaration !== undefined) {
      return tokenTypeFromReferenceDeclaration(reference, visibleDeclaration);
    }
  }

  const localDeclaration = findLocalDeclaration(analysis, reference.name, reference.range.start);
  if (localDeclaration !== undefined && referenceMatchesDeclarationKind(reference, localDeclaration)) {
    return tokenTypeFromReferenceDeclaration(reference, localDeclaration);
  }

  const implicitGuiMember = findImplicitGuiMemberDeclaration(resolutionInput, reference);
  if (implicitGuiMember !== undefined) {
    return tokenTypeFromReferenceDeclaration(reference, implicitGuiMember);
  }

  const visibleDeclaration = matchingVisibleDeclaration(reference, resolutionInput);
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
  input: DeclarationResolutionInput
): AnalysisDeclaration | undefined {
  return visibleDeclarationsByName(input, reference.name)
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
  reference: AnalysisReference
): AnalysisDeclaration | undefined {
  const context = findEnclosingGuiMethodContext({
    analysis: input.analysis,
    position: reference.range.start
  });
  if (context === undefined) {
    return undefined;
  }

  return findDeclarationMember(input, context.receiverTypeName, reference.name)
    ?? findRecoveredGuiDeclarationMember(input, context.receiverTypeName, reference)
    ?? findDeclarationMember(input, context.rootClassName, reference.name)
    ?? findRecoveredGuiDeclarationMember(input, context.rootClassName, reference);
}

function findRecoveredGuiDeclarationMember(
  input: DeclarationResolutionInput,
  containerName: string,
  reference: AnalysisReference
): AnalysisDeclaration | undefined {
  if (!/^GC[A-Za-z_$][0-9A-Za-z_$]*$/.test(containerName)) {
    return undefined;
  }

  const declaration = visibleDeclarationsByName(input, reference.name)
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
