import type {
  AnalysisDeclaration,
  AnalysisDeclarationKind,
  AnalysisDiagnostic,
  AnalysisGuiClass,
  AnalysisGuiMethod,
  AnalysisGuiPart,
  AnalysisReference,
  AnalysisScope,
  AnalyzedDocument
} from '../types/analysis';
import { getBuiltinHover } from './builtins';
import { isGuiPartTypeName } from './guiClassKinds';
import {
  allGuiMethods,
  findEnclosingGuiMethodContext,
  findVisibleGuiClass,
  resolveGuiPartPath,
  type GuiResolutionInput
} from './guiResolution';
import {
  acceptedArgumentCounts,
  acceptsArgumentCount,
  declarationsInTypeHierarchy,
  findDeclarationMember,
  findLocalDeclaration,
  isTypeDeclaration,
  receiverTypeName,
  resolveMemberAccessType,
  thisReceiverType,
  visibleDeclarationsByName
} from './resolution';

export interface SemanticDiagnosticsInput {
  analysis: Pick<AnalyzedDocument, 'uri' | 'diagnostics' | 'declarations' | 'references' | 'scopes' | 'includes' | 'guiClasses' | 'guiMethods'>;
  workspaceIndex?: WorkspaceSemanticDiagnosticsIndex;
}

export interface WorkspaceSemanticDiagnosticsIndex {
  findVisibleGuiClasses?(sourceUri: string, name: string): AnalysisGuiClass[];
  findVisibleDeclarations?(sourceUri: string, name: string): AnalysisDeclaration[];
  listVisibleDeclarations?(sourceUri: string): AnalysisDeclaration[];
}

export function collectSemanticDiagnostics(input: SemanticDiagnosticsInput): AnalysisDiagnostic[] {
  const workspaceIndex = input.workspaceIndex === undefined
    ? undefined
    : createCachedWorkspaceIndex(input.analysis.uri, input.workspaceIndex);
  return [
    ...duplicateDeclarationDiagnostics(input.analysis),
    ...unresolvedTypeReferenceDiagnostics(input.analysis, workspaceIndex),
    ...unresolvedIdentifierDiagnostics(input.analysis, workspaceIndex),
    ...callArgumentCountDiagnostics(input.analysis, workspaceIndex),
    ...guiReceiverPathDiagnostics(input.analysis, workspaceIndex),
    ...doModalOnCreateDiagnostics(input.analysis)
  ];
}

function createCachedWorkspaceIndex(
  sourceUri: string,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex
): WorkspaceSemanticDiagnosticsIndex {
  let visibleDeclarations: AnalysisDeclaration[] | undefined;
  const declarationsByName = new Map<string, AnalysisDeclaration[]>();
  const declarationLookupCache = new Map<string, AnalysisDeclaration[]>();
  const guiClassLookupCache = new Map<string, AnalysisGuiClass[]>();

  function listVisibleDeclarations(uri: string): AnalysisDeclaration[] {
    if (uri !== sourceUri) {
      return workspaceIndex.listVisibleDeclarations?.(uri) ?? [];
    }

    visibleDeclarations ??= workspaceIndex.listVisibleDeclarations?.(sourceUri) ?? [];
    return visibleDeclarations;
  }

  return {
    findVisibleGuiClasses: (uri, name) => {
      const key = `${uri}\0${name}`;
      const cached = guiClassLookupCache.get(key);
      if (cached !== undefined) {
        return cached;
      }

      const classes = workspaceIndex.findVisibleGuiClasses?.(uri, name) ?? [];
      guiClassLookupCache.set(key, classes);
      return classes;
    },
    findVisibleDeclarations: (uri, name) => {
      if (uri === sourceUri && workspaceIndex.listVisibleDeclarations !== undefined) {
        const cached = declarationsByName.get(name);
        if (cached !== undefined) {
          return cached;
        }

        const declarations = listVisibleDeclarations(uri).filter((declaration) => declaration.name === name);
        declarationsByName.set(name, declarations);
        return declarations;
      }

      const key = `${uri}\0${name}`;
      const cached = declarationLookupCache.get(key);
      if (cached !== undefined) {
        return cached;
      }

      const declarations = workspaceIndex.findVisibleDeclarations?.(uri, name) ?? [];
      declarationLookupCache.set(key, declarations);
      return declarations;
    },
    listVisibleDeclarations
  };
}

function duplicateDeclarationDiagnostics(
  analysis: Pick<AnalyzedDocument, 'declarations' | 'scopes'>
): AnalysisDiagnostic[] {
  const declarations = new Map(analysis.declarations.map((declaration) => [declaration.id, declaration]));
  const diagnostics: AnalysisDiagnostic[] = [];

  for (const scope of analysis.scopes) {
    diagnostics.push(...duplicateDeclarationDiagnosticsForScope(scope, declarations));
  }

  return diagnostics;
}

function duplicateDeclarationDiagnosticsForScope(
  scope: AnalysisScope,
  declarations: ReadonlyMap<string, AnalysisDeclaration>
): AnalysisDiagnostic[] {
  const seen = new Map<string, AnalysisDeclaration>();
  const diagnostics: AnalysisDiagnostic[] = [];

  for (const declarationId of scope.declarationIds) {
    const declaration = declarations.get(declarationId);
    if (declaration === undefined || !isDuplicateCheckedDeclaration(declaration)) {
      continue;
    }

    if (seen.has(declaration.name)) {
      diagnostics.push({
        severity: 'error',
        source: 'axel',
        message: `Duplicate declaration '${declaration.name}'.`,
        range: declaration.selectionRange
      });
      continue;
    }

    seen.set(declaration.name, declaration);
  }

  return diagnostics;
}

function isDuplicateCheckedDeclaration(declaration: AnalysisDeclaration): boolean {
  return declaration.name !== ''
    && declaration.kind !== 'include'
    && declaration.kind !== 'macro'
    && declaration.kind !== 'function'
    && declaration.kind !== 'parameter'
    && !isFunctionPrototypeDeclaration(declaration)
    && !isMacroPrefixedBuiltinCallRecovery(declaration);
}

function isFunctionPrototypeDeclaration(declaration: AnalysisDeclaration): boolean {
  return declaration.kind === 'variable' && declaration.detail.includes('(');
}

function isMacroPrefixedBuiltinCallRecovery(declaration: AnalysisDeclaration): boolean {
  return declaration.kind === 'variable'
    && getBuiltinHover(declaration.name) !== null
    && /^[A-Z_$][0-9A-Z_$]*\s+[0-9A-Za-z_$]+$/.test(declaration.detail);
}

const BUILTIN_TYPE_NAMES = new Set([
  'bool',
  'char',
  'short',
  'int',
  'int64',
  'long',
  'float',
  'double',
  'void',
  'string',
  'natural',
  'ipoint',
  'izone',
  'icoord'
]);

const TYPE_DECLARATION_KINDS = new Set<AnalysisDeclarationKind>([
  'typedef',
  'class',
  'struct',
  'union',
  'enum'
]);

function unresolvedTypeReferenceDiagnostics(
  analysis: Pick<AnalyzedDocument, 'uri' | 'diagnostics' | 'declarations' | 'references'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): AnalysisDiagnostic[] {
  if (hasSyntaxDiagnostics(analysis.diagnostics)) {
    return [];
  }

  return analysis.references
    .filter((reference) => reference.typeReference === true)
    .filter((reference) => !isMacroLikeTypeRecovery(reference.name))
    .filter((reference) => !isKnownTypeReference(reference.name, analysis, workspaceIndex))
    .map((reference) => ({
      severity: 'error',
      source: 'axel',
      message: `Unknown type '${reference.name}'.`,
      range: reference.range
    }));
}

function isKnownTypeReference(
  name: string,
  analysis: Pick<AnalyzedDocument, 'uri' | 'declarations'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): boolean {
  if (BUILTIN_TYPE_NAMES.has(name) || isGuiPartTypeName(name)) {
    return true;
  }

  const declarations = [
    ...analysis.declarations.filter((declaration) => declaration.name === name),
    ...(workspaceIndex?.findVisibleDeclarations?.(analysis.uri, name) ?? [])
  ];
  return declarations.some((declaration) => TYPE_DECLARATION_KINDS.has(declaration.kind));
}

function isMacroLikeTypeRecovery(name: string): boolean {
  return /^[A-Z_$][0-9A-Z_$]*$/.test(name);
}

const KNOWN_VALUE_NAMES = new Set([
  'FALSE',
  'NULL',
  'TRUE',
  'nullptr'
]);

function unresolvedIdentifierDiagnostics(
  analysis: Pick<AnalyzedDocument, 'uri' | 'diagnostics' | 'declarations' | 'references' | 'scopes' | 'guiClasses' | 'guiMethods'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): AnalysisDiagnostic[] {
  if (hasSyntaxDiagnostics(analysis.diagnostics)) {
    return [];
  }

  return analysis.references
    .filter((reference) => reference.typeReference !== true)
    .filter((reference) => !isKnownIdentifierReference(reference, analysis, workspaceIndex))
    .map((reference) => ({
      severity: 'error',
      source: 'axel',
      message: `Unknown identifier '${reference.name}'.`,
      range: reference.range
    }));
}

function isKnownIdentifierReference(
  reference: AnalysisReference,
  analysis: Pick<AnalyzedDocument, 'uri' | 'declarations' | 'scopes' | 'guiClasses' | 'guiMethods'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): boolean {
  if (KNOWN_VALUE_NAMES.has(reference.name)
    || BUILTIN_TYPE_NAMES.has(reference.name)
    || isGuiPartTypeName(reference.name)
    || getBuiltinHover(reference.name) !== null
    || isMacroLikeTypeRecovery(reference.name)) {
    return true;
  }

  if (isKnownDirectGuiDialogCall(reference, analysis)) {
    return true;
  }

  if (reference.memberAccess !== undefined) {
    return isKnownMemberReference(reference, analysis, workspaceIndex);
  }

  const input = { analysis, position: reference.range.start, workspaceIndex: workspaceIndex ?? {} };
  if (findLocalDeclaration(analysis, reference.name, reference.range.start) !== undefined) {
    return true;
  }

  if (visibleDeclarationsByName(input, reference.name).length > 0) {
    return true;
  }

  return isKnownImplicitGuiReference(reference, analysis, workspaceIndex);
}

function isKnownMemberReference(
  reference: AnalysisReference,
  analysis: Pick<AnalyzedDocument, 'uri' | 'declarations' | 'scopes' | 'guiClasses' | 'guiMethods'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): boolean {
  const memberAccess = reference.memberAccess;
  if (memberAccess === undefined) {
    return true;
  }

  const input = { analysis, position: reference.range.start, workspaceIndex: workspaceIndex ?? {} };
  const receiverType = memberAccess.receiverName === 'this'
    ? thisReceiverType(input)
    : receiverTypeName(input, memberAccess.receiverName)
      ?? typeDeclarationName(input, memberAccess.receiverName);
  if (receiverType === undefined) {
    return true;
  }

  const parentMembers = memberAccess.memberNames.slice(0, -1);
  const ownerType = parentMembers.length === 0
    ? receiverType
    : resolveMemberAccessType(input, receiverType, parentMembers);
  if (ownerType === undefined || isGuiPartTypeName(ownerType)) {
    return true;
  }

  return findDeclarationMember(input, ownerType, reference.name) !== undefined;
}

function isKnownDirectGuiDialogCall(
  reference: AnalysisReference,
  analysis: Pick<AnalyzedDocument, 'uri' | 'guiClasses' | 'guiMethods'>
): boolean {
  return reference.call === true
    && (reference.name === 'DoModal' || reference.name === 'DoModless')
    && findEnclosingGuiMethodContext(guiResolutionInput(analysis, undefined, reference.range.start))?.rootClassName !== undefined;
}

function typeDeclarationName(
  input: {
    analysis: Pick<AnalyzedDocument, 'uri' | 'declarations' | 'scopes'>;
    position: AnalysisReference['range']['start'];
    workspaceIndex: WorkspaceSemanticDiagnosticsIndex;
  },
  name: string
): string | undefined {
  const declaration = visibleDeclarationsByName(input, name).find(isTypeDeclaration);
  return declaration?.name;
}

function isKnownImplicitGuiReference(
  reference: AnalysisReference,
  analysis: Pick<AnalyzedDocument, 'uri' | 'declarations' | 'scopes' | 'guiClasses' | 'guiMethods'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): boolean {
  const context = findEnclosingGuiMethodContext(guiResolutionInput(analysis, workspaceIndex, reference.range.start));
  if (context === undefined) {
    return false;
  }

  const input = { analysis, position: reference.range.start, workspaceIndex: workspaceIndex ?? {} };
  return findGuiPartByName(analysis, workspaceIndex, context.rootClassName, reference.name) !== undefined
    || findDeclarationMember(input, context.receiverTypeName, reference.name) !== undefined
    || findDeclarationMember(input, context.rootClassName, reference.name) !== undefined
    || isGuiPartTypeName(context.receiverTypeName);
}

function callArgumentCountDiagnostics(
  analysis: Pick<AnalyzedDocument, 'uri' | 'diagnostics' | 'declarations' | 'references' | 'scopes' | 'guiClasses' | 'guiMethods'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): AnalysisDiagnostic[] {
  if (hasSyntaxDiagnostics(analysis.diagnostics)) {
    return [];
  }

  const diagnostics: AnalysisDiagnostic[] = [];
  for (const reference of analysis.references) {
    if (reference.call !== true || reference.argumentCount === undefined) {
      continue;
    }

    const argumentCount = reference.argumentCount;
    const candidates = callableDeclarationsForReference(reference, analysis, workspaceIndex)
      .filter((declaration) => declaration.signature !== undefined);
    const argumentCounts = candidates.map(acceptedArgumentCounts);
    if (argumentCounts.length === 0 || argumentCounts.some((counts) => acceptsArgumentCount(counts, argumentCount))) {
      continue;
    }

    const expected = expectedArgumentText(argumentCounts);
    diagnostics.push({
      severity: 'error',
      source: 'axel',
      message: `Function '${reference.name}' expects ${expected}, but got ${argumentCount}.`,
      range: reference.range
    });
  }

  return diagnostics;
}

function callableDeclarationsForReference(
  reference: AnalysisReference,
  analysis: Pick<AnalyzedDocument, 'uri' | 'declarations' | 'scopes' | 'guiClasses' | 'guiMethods'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): AnalysisDeclaration[] {
  if (reference.memberAccess !== undefined) {
    return callableMemberDeclarationsForReference(reference, analysis, workspaceIndex);
  }

  const input = { analysis, position: reference.range.start, workspaceIndex: workspaceIndex ?? {} };
  return [
    ...visibleDeclarationsByName(input, reference.name),
    ...implicitGuiCallableDeclarations(reference, analysis, workspaceIndex)
  ];
}

function callableMemberDeclarationsForReference(
  reference: AnalysisReference,
  analysis: Pick<AnalyzedDocument, 'uri' | 'declarations' | 'scopes' | 'guiClasses' | 'guiMethods'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): AnalysisDeclaration[] {
  const memberAccess = reference.memberAccess;
  if (memberAccess === undefined) {
    return [];
  }

  const input = { analysis, position: reference.range.start, workspaceIndex: workspaceIndex ?? {} };
  const receiverType = memberAccess.receiverName === 'this'
    ? thisReceiverType(input)
    : receiverTypeName(input, memberAccess.receiverName)
      ?? typeDeclarationName(input, memberAccess.receiverName);
  if (receiverType === undefined) {
    return [];
  }

  const parentMembers = memberAccess.memberNames.slice(0, -1);
  const ownerType = parentMembers.length === 0
    ? receiverType
    : resolveMemberAccessType(input, receiverType, parentMembers);
  return ownerType === undefined
    ? []
    : declarationsInTypeHierarchy(input, ownerType)
      .filter((declaration) => declaration.name === reference.name);
}

function implicitGuiCallableDeclarations(
  reference: AnalysisReference,
  analysis: Pick<AnalyzedDocument, 'uri' | 'declarations' | 'scopes' | 'guiClasses' | 'guiMethods'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): AnalysisDeclaration[] {
  const context = findEnclosingGuiMethodContext(guiResolutionInput(analysis, workspaceIndex, reference.range.start));
  if (context === undefined) {
    return [];
  }

  const input = { analysis, position: reference.range.start, workspaceIndex: workspaceIndex ?? {} };
  return [
    findDeclarationMember(input, context.receiverTypeName, reference.name),
    findDeclarationMember(input, context.rootClassName, reference.name)
  ].filter((declaration): declaration is AnalysisDeclaration => declaration !== undefined);
}

function expectedArgumentText(argumentCounts: ReturnType<typeof acceptedArgumentCounts>[]): string {
  if (argumentCounts.every((counts) => counts.min === counts.max)) {
    return exactArgumentCountText(argumentCounts.map((counts) => counts.min));
  }

  const texts = uniqueStrings(argumentCounts.map(argumentCountText));
  return joinAlternatives(texts);
}

function exactArgumentCountText(counts: number[]): string {
  const uniqueCounts = Array.from(new Set(counts)).sort((left, right) => left - right);
  if (uniqueCounts.length === 1) {
    return `${uniqueCounts[0]} ${argumentWord(uniqueCounts[0])}`;
  }

  return `${joinAlternatives(uniqueCounts.map((count) => count.toString()))} arguments`;
}

function argumentCountText(counts: ReturnType<typeof acceptedArgumentCounts>): string {
  if (counts.max === Number.POSITIVE_INFINITY) {
    return `at least ${counts.min} ${argumentWord(counts.min)}`;
  }

  if (counts.min === counts.max) {
    return `${counts.min} ${argumentWord(counts.min)}`;
  }

  if (counts.max === counts.min + 1) {
    return `${counts.min} or ${counts.max} arguments`;
  }

  return `${counts.min} to ${counts.max} arguments`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function joinAlternatives(values: string[]): string {
  if (values.length <= 1) {
    return values[0] ?? '0 arguments';
  }

  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}

function argumentWord(count: number): string {
  return count === 1 ? 'argument' : 'arguments';
}

function findGuiPartByName(
  analysis: Pick<AnalyzedDocument, 'uri' | 'guiClasses'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined,
  rootClassName: string,
  name: string
): AnalysisGuiPart | undefined {
  const input = guiResolutionInput(analysis, workspaceIndex, { line: 0, character: 0 });
  const rootClass = findVisibleGuiClass(input, rootClassName);
  return rootClass === undefined ? undefined : findPart(rootClass.parts, (part) => part.name === name);
}

function guiReceiverPathDiagnostics(
  analysis: Pick<AnalyzedDocument, 'uri' | 'diagnostics' | 'guiClasses' | 'guiMethods'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): AnalysisDiagnostic[] {
  if (hasSyntaxDiagnostics(analysis.diagnostics)) {
    return [];
  }

  const diagnostics: AnalysisDiagnostic[] = [];

  for (const method of analysis.guiMethods) {
    const diagnostic = guiReceiverPathDiagnostic(analysis, workspaceIndex, method);
    if (diagnostic !== undefined) {
      diagnostics.push(diagnostic);
    }
  }

  return diagnostics;
}

function guiReceiverPathDiagnostic(
  analysis: Pick<AnalyzedDocument, 'uri' | 'guiClasses'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined,
  method: AnalysisGuiMethod
): AnalysisDiagnostic | undefined {
  if (!method.event || method.receiverPath.length < 3 || method.receiverPathSegmentRanges === undefined) {
    return undefined;
  }

  const rootClassName = method.receiverPath[0];
  const input = guiResolutionInput(analysis, workspaceIndex, method.range.start);
  const rootClass = findVisibleGuiClass(input, rootClassName);
  if (rootClass === undefined) {
    return undefined;
  }

  for (let index = 1; index < method.receiverPath.length - 1; index += 1) {
    const path = method.receiverPath.slice(1, index + 1);
    if (resolveGuiPartPath(input, rootClassName, path) === undefined) {
      const segment = method.receiverPath[index];
      return {
        severity: 'error',
        source: 'axel',
        message: `Unknown GUI receiver path segment '${segment}'.`,
        range: method.receiverPathSegmentRanges[index]
      };
    }
  }

  return undefined;
}

function hasSyntaxDiagnostics(diagnostics: readonly AnalysisDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => (
    diagnostic.severity === 'error'
    && (diagnostic.message === 'Syntax error.' || diagnostic.message.startsWith('Missing '))
  ));
}

function findPart(
  parts: AnalysisGuiPart[],
  predicate: (part: AnalysisGuiPart) => boolean
): AnalysisGuiPart | undefined {
  for (const part of parts) {
    if (predicate(part)) {
      return part;
    }

    const child = findPart(part.parts, predicate);
    if (child !== undefined) {
      return child;
    }
  }

  return undefined;
}

function doModalOnCreateDiagnostics(
  analysis: Pick<AnalyzedDocument, 'references' | 'guiClasses' | 'guiMethods'>
): AnalysisDiagnostic[] {
  const dialogClassNames = new Set(
    analysis.guiClasses
      .filter((guiClass) => guiClass.kind === 'dialog')
      .map((guiClass) => guiClass.name)
  );
  const onCreateMethods = allGuiMethods(analysis)
    .filter((method) => method.name === 'OnCreate' && dialogClassNames.has(method.receiverPath[0]));

  return analysis.references
    .filter((reference) => reference.name === 'DoModal' && reference.call === true)
    .filter((reference) => onCreateMethods.some((method) => containsRange(method.range, reference.range)))
    .map((reference) => ({
      severity: 'warning',
      source: 'axel',
      message: 'DoModal should not be called inside a GCDialog OnCreate handler.',
      range: reference.range
    }));
}

function containsRange(container: AnalysisGuiMethod['range'], range: AnalysisReference['range']): boolean {
  return positionBeforeOrEqual(container.start, range.start) && positionBeforeOrEqual(range.end, container.end);
}

function positionBeforeOrEqual(
  left: AnalysisReference['range']['start'],
  right: AnalysisReference['range']['start']
): boolean {
  return left.line < right.line || (left.line === right.line && left.character <= right.character);
}

function guiResolutionInput(
  analysis: Pick<AnalyzedDocument, 'uri' | 'guiClasses'> & Partial<Pick<AnalyzedDocument, 'guiMethods'>>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined,
  position: AnalysisReference['range']['start']
): GuiResolutionInput {
  return {
    analysis: {
      ...analysis,
      guiMethods: analysis.guiMethods ?? []
    },
    position,
    workspaceIndex: {
      findGuiClass: (sourceUri, name) => {
        const visibleClasses = workspaceIndex?.findVisibleGuiClasses?.(sourceUri, name);
        if (visibleClasses !== undefined) {
          return visibleClasses.length === 1 ? visibleClasses[0] : undefined;
        }

        return analysis.guiClasses.find((guiClass) => guiClass.name === name);
      }
    }
  };
}
