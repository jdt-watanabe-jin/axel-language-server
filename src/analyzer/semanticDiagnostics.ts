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
    && findEnclosingGuiMethodContext(analysis, undefined, reference.range.start)?.rootClassName !== undefined;
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
  const context = findEnclosingGuiMethodContext(analysis, workspaceIndex, reference.range.start);
  if (context === undefined) {
    return false;
  }

  const input = { analysis, position: reference.range.start, workspaceIndex: workspaceIndex ?? {} };
  return findGuiPartByName(analysis, workspaceIndex, context.rootClassName, reference.name) !== undefined
    || findDeclarationMember(input, context.receiverTypeName, reference.name) !== undefined
    || findDeclarationMember(input, context.rootClassName, reference.name) !== undefined
    || isGuiPartTypeName(context.receiverTypeName);
}

interface GuiMethodContext {
  rootClassName: string;
  receiverTypeName: string;
}

function findEnclosingGuiMethodContext(
  analysis: Pick<AnalyzedDocument, 'uri' | 'guiClasses' | 'guiMethods'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined,
  position: AnalysisReference['range']['start']
): GuiMethodContext | undefined {
  for (const guiClass of analysis.guiClasses) {
    const classMethod = guiClass.methods.find((method) => containsRange(method.range, { start: position, end: position }));
    if (classMethod !== undefined) {
      return { rootClassName: guiClass.name, receiverTypeName: guiClass.name };
    }

    const partMethod = findEnclosingGuiPartMethod(guiClass.parts, position);
    if (partMethod !== undefined) {
      return { rootClassName: guiClass.name, receiverTypeName: partMethod.typeName };
    }
  }

  const classResolver = createGuiClassResolver(analysis, workspaceIndex);
  for (const method of analysis.guiMethods) {
    if (!containsRange(method.range, { start: position, end: position })) {
      continue;
    }

    const rootClassName = method.receiverPath[0];
    if (rootClassName === undefined) {
      continue;
    }

    const rootClass = classResolver.find(rootClassName);
    const part = rootClass === undefined
      ? undefined
      : resolveGuiPartPath(rootClass, classResolver, method.receiverPath.slice(1, -1));
    return {
      rootClassName,
      receiverTypeName: part?.typeName ?? rootClassName
    };
  }

  return undefined;
}

function findEnclosingGuiPartMethod(
  parts: AnalysisGuiPart[],
  position: AnalysisReference['range']['start']
): AnalysisGuiPart | undefined {
  for (const part of parts) {
    if (part.methods.some((method) => containsRange(method.range, { start: position, end: position }))) {
      return part;
    }

    const child = findEnclosingGuiPartMethod(part.parts, position);
    if (child !== undefined) {
      return child;
    }
  }

  return undefined;
}

function findGuiPartByName(
  analysis: Pick<AnalyzedDocument, 'uri' | 'guiClasses'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined,
  rootClassName: string,
  name: string
): AnalysisGuiPart | undefined {
  const rootClass = createGuiClassResolver(analysis, workspaceIndex).find(rootClassName);
  return rootClass === undefined ? undefined : findPart(rootClass.parts, (part) => part.name === name);
}

function guiReceiverPathDiagnostics(
  analysis: Pick<AnalyzedDocument, 'uri' | 'diagnostics' | 'guiClasses' | 'guiMethods'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): AnalysisDiagnostic[] {
  if (hasSyntaxDiagnostics(analysis.diagnostics)) {
    return [];
  }

  const classResolver = createGuiClassResolver(analysis, workspaceIndex);
  const diagnostics: AnalysisDiagnostic[] = [];

  for (const method of analysis.guiMethods) {
    const diagnostic = guiReceiverPathDiagnostic(method, classResolver);
    if (diagnostic !== undefined) {
      diagnostics.push(diagnostic);
    }
  }

  return diagnostics;
}

function guiReceiverPathDiagnostic(
  method: AnalysisGuiMethod,
  classResolver: GuiClassResolver
): AnalysisDiagnostic | undefined {
  if (!method.event || method.receiverPath.length < 3 || method.receiverPathSegmentRanges === undefined) {
    return undefined;
  }

  const rootClass = classResolver.find(method.receiverPath[0]);
  if (rootClass === undefined) {
    return undefined;
  }

  for (let index = 1; index < method.receiverPath.length - 1; index += 1) {
    const path = method.receiverPath.slice(1, index + 1);
    if (resolveGuiPartPath(rootClass, classResolver, path) === undefined) {
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

function resolveGuiPartPath(
  rootClass: AnalysisGuiClass,
  classResolver: GuiClassResolver,
  path: string[]
): AnalysisGuiPart | undefined {
  let owner: AnalysisGuiClass | undefined = rootClass;
  let ownerPath: string[] = [];
  let resolved: AnalysisGuiPart | undefined;
  const directPart = findPartByPath(rootClass.parts, path);
  if (directPart !== undefined) {
    return directPart;
  }

  for (const segment of path) {
    if (owner === undefined) {
      return undefined;
    }

    const nextPath = [...ownerPath, segment];
    const part: AnalysisGuiPart | undefined = findPartByPath(owner.parts, nextPath)
      ?? findPartByPath(owner.parts, [segment]);
    if (part === undefined) {
      return undefined;
    }

    resolved = part;
    const partClass = classResolver.find(part.typeName);
    owner = partClass ?? owner;
    ownerPath = partClass === undefined ? nextPath : [];
  }

  return resolved;
}

interface GuiClassResolver {
  find(name: string): AnalysisGuiClass | undefined;
}

function createGuiClassResolver(
  analysis: Pick<AnalyzedDocument, 'uri' | 'guiClasses'>,
  workspaceIndex: WorkspaceSemanticDiagnosticsIndex | undefined
): GuiClassResolver {
  const localClasses = new Map(analysis.guiClasses.map((guiClass) => [guiClass.name, guiClass]));
  return {
    find: (name) => {
      const visibleClasses = workspaceIndex?.findVisibleGuiClasses?.(analysis.uri, name);
      if (visibleClasses !== undefined) {
        return visibleClasses.length === 1 ? visibleClasses[0] : undefined;
      }

      return localClasses.get(name);
    }
  };
}

function hasSyntaxDiagnostics(diagnostics: readonly AnalysisDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => (
    diagnostic.severity === 'error'
    && (diagnostic.message === 'Syntax error.' || diagnostic.message.startsWith('Missing '))
  ));
}

function findPartByPath(parts: AnalysisGuiPart[], path: string[]): AnalysisGuiPart | undefined {
  return findPart(parts, (part) => sameStringArray(part.path, path));
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

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function doModalOnCreateDiagnostics(
  analysis: Pick<AnalyzedDocument, 'references' | 'guiClasses' | 'guiMethods'>
): AnalysisDiagnostic[] {
  const dialogClassNames = new Set(
    analysis.guiClasses
      .filter((guiClass) => guiClass.kind === 'dialog')
      .map((guiClass) => guiClass.name)
  );
  const onCreateMethods = allGuiMethods(analysis.guiClasses, analysis.guiMethods)
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

function allGuiMethods(guiClasses: AnalysisGuiClass[], externalMethods: AnalysisGuiMethod[]): AnalysisGuiMethod[] {
  return [
    ...externalMethods,
    ...guiClasses.flatMap((guiClass) => [
      ...guiClass.methods,
      ...guiPartMethods(guiClass.parts)
    ])
  ];
}

function guiPartMethods(parts: AnalysisGuiPart[]): AnalysisGuiMethod[] {
  return parts.flatMap((part) => [
    ...part.methods,
    ...guiPartMethods(part.parts)
  ]);
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
