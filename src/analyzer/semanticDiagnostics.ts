import { message, type MessageDescriptor } from '../i18n/messages';
import { containsSourcePosition, isSystemMacroName, resolveSystemMacro } from './systemMacros';
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
  isVisibleAt,
  receiverTypeName,
  resolveMemberAccessType,
  thisReceiverType,
  visibleDeclarationsByName
} from './resolution';

export interface SemanticDiagnosticsInput {
  analysis: Pick<AnalyzedDocument, 'uri' | 'diagnostics' | 'declarations' | 'references' | 'scopes' | 'includes' | 'guiClasses' | 'guiMethods' | 'tool' | 'uncertainNames' | 'uncertainRanges' | 'uncertainDeclarations'>;
  workspaceIndex?: WorkspaceSemanticDiagnosticsIndex;
}

export interface WorkspaceSemanticDiagnosticsIndex {
  findVisibleGuiClasses?(sourceUri: string, name: string): AnalysisGuiClass[];
  findVisibleDeclarations?(sourceUri: string, name: string): AnalysisDeclaration[];
  listVisibleDeclarations?(sourceUri: string): AnalysisDeclaration[];
}

export function collectSemanticDiagnostics(input: SemanticDiagnosticsInput): AnalysisDiagnostic[] {
  // Potential declarations cannot prove a duplicate, missing name or signature.
  // Keep unrelated references so an unknown branch does not disable diagnostics.
  const uncertainNames = new Set(input.analysis.uncertainNames ?? []);
  const originalAnalysis = input.analysis;
  const mightBeVisible = (name: string, reference: AnalysisReference): boolean => {
    const candidates = (originalAnalysis.uncertainDeclarations ?? []).filter(d => d.name === name);
    if (candidates.length === 0) { return uncertainNames.has(name); }
    return candidates.some(declaration => originalAnalysis.scopes.some(scope =>
      scope.declarationIds.includes(declaration.id) && containsSourcePosition(scope.range, reference.range.start)
      && isVisibleAt(declaration, reference.range.start, originalAnalysis.uri)));
  };
  if (uncertainNames.size > 0) {
    input = { ...input, analysis: { ...input.analysis,
      references: input.analysis.references.filter(ref => !mightBeVisible(ref.name, ref)
        && !mightBeVisible(ref.memberAccess?.receiverName ?? '', ref))
    } };
  }
  const workspaceIndex = input.workspaceIndex === undefined
    ? undefined
    : createCachedWorkspaceIndex(input.analysis.uri, input.workspaceIndex);
  return [
    ...duplicateDeclarationDiagnostics(input.analysis, workspaceIndex),
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
  analysis: Pick<AnalyzedDocument, 'uri' | 'declarations' | 'scopes'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): AnalysisDiagnostic[] {
  // Unexpanded macro-prefixed calls may be parsed as object declarations.
  // Preserve recovery using visible source functions instead of reserved names.
  const functionNames = new Set(analysis.declarations
    .filter(declaration => declaration.kind === 'function')
    .map(declaration => declaration.name));
  const macroNames = new Set(analysis.declarations
    .filter(declaration => declaration.kind === 'macro')
    .map(declaration => declaration.name));
  const declarations = new Map(analysis.declarations
    .filter(declaration => !isMacroPrefixedCallRecovery(declaration, functionNames, macroNames, analysis.uri, workspaceIndex))
    .map((declaration) => [declaration.id, declaration]));
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
        ...message("Duplicate declaration '{0}'.", declaration.name),
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
    && !isFunctionPrototypeDeclaration(declaration);
}

function isFunctionPrototypeDeclaration(declaration: AnalysisDeclaration): boolean {
  return declaration.kind === 'variable' && declaration.detail.includes('(');
}

function isMacroPrefixedCallRecovery(
  declaration: AnalysisDeclaration,
  localFunctionNames: ReadonlySet<string>,
  localMacroNames: ReadonlySet<string>,
  sourceUri: string,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): boolean {
  return declaration.kind === 'variable'
    && declaration.typeName !== undefined
    && declaration.detail === `${declaration.typeName} ${declaration.name}`
    && (localMacroNames.has(declaration.typeName)
      || (workspaceIndex?.findVisibleDeclarations?.(sourceUri, declaration.typeName) ?? [])
        .some(candidate => candidate.kind === 'macro'))
    && (localFunctionNames.has(declaration.name)
      || (workspaceIndex?.findVisibleDeclarations?.(sourceUri, declaration.name) ?? [])
        .some(candidate => candidate.kind === 'function'));
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
      ...message("Unknown type '{0}'.", reference.name),
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
  analysis: Pick<AnalyzedDocument, 'uri' | 'diagnostics' | 'declarations' | 'references' | 'scopes' | 'guiClasses' | 'guiMethods' | 'tool'>,
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
      ...message("Unknown identifier '{0}'.", reference.name),
      range: reference.range
    }));
}

function isKnownIdentifierReference(
  reference: AnalysisReference,
  analysis: Pick<AnalyzedDocument, 'uri' | 'declarations' | 'scopes' | 'guiClasses' | 'guiMethods' | 'tool'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): boolean {
  if (isSystemMacroName(reference.name) && reference.memberAccess === undefined) {
    return resolveSystemMacro(reference.name, analysis.uri, reference.range.start, analysis.tool)?.defined === true;
  }
  if (KNOWN_VALUE_NAMES.has(reference.name)
    || BUILTIN_TYPE_NAMES.has(reference.name)
    || isGuiPartTypeName(reference.name)
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

    const expected = expectedArgumentDescriptor(argumentCounts);
    diagnostics.push({
      severity: 'error',
      source: 'axel',
      ...message("Function '{0}' expects {1}, but got {2}.", reference.name, expected, argumentCount),
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

function expectedArgumentDescriptor(argumentCounts: ReturnType<typeof acceptedArgumentCounts>[]): MessageDescriptor {
  if (argumentCounts.every((counts) => counts.min === counts.max)) {
    return exactArgumentCountDescriptor(argumentCounts.map((counts) => counts.min));
  }

  const descriptors = Array.from(new Map(argumentCounts.map((counts) => {
    const descriptor = argumentCountDescriptor(counts);
    return [JSON.stringify(descriptor), descriptor];
  })).values());
  return joinAlternatives(descriptors);
}

function exactArgumentCountDescriptor(counts: number[]): MessageDescriptor {
  const uniqueCounts = Array.from(new Set(counts)).sort((left, right) => left - right);
  if (uniqueCounts.length === 1) {
    return argumentCountDescriptor({ min: uniqueCounts[0], max: uniqueCounts[0] });
  }

  return { key: '{0} arguments', args: [joinAlternatives(uniqueCounts)] };
}

function argumentCountDescriptor(counts: ReturnType<typeof acceptedArgumentCounts>): MessageDescriptor {
  if (counts.max === Number.POSITIVE_INFINITY) {
    return { key: counts.min === 1 ? 'at least {0} argument' : 'at least {0} arguments', args: [counts.min] };
  }

  if (counts.min === counts.max) {
    return { key: counts.min === 1 ? '{0} argument' : '{0} arguments', args: [counts.min] };
  }

  if (counts.max === counts.min + 1) {
    return { key: '{0} or {1} arguments', args: [counts.min, counts.max] };
  }

  return { key: '{0} to {1} arguments', args: [counts.min, counts.max] };
}

function joinAlternatives(values: (number | MessageDescriptor)[]): MessageDescriptor {
  if (values.length <= 1) {
    const value = values[0];
    return value === undefined ? { key: '{0} arguments', args: [0] }
      : typeof value === 'number' ? { key: '{0}', args: [value] } : value;
  }

  const prefix = values.slice(0, -1).reduce((left, right) => ({
    key: '{0}, {1}', args: [left, right]
  }));
  return { key: '{0} or {1}', args: [prefix, values[values.length - 1]] };
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
        ...message("Unknown GUI receiver path segment '{0}'.", segment),
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
      ...message('DoModal should not be called inside a GCDialog OnCreate handler.'),
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
