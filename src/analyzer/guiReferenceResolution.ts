import type { AnalysisDeclaration, AnalysisGuiClass, AnalysisGuiPart, AnalysisRange, AnalysisReference, AnalyzedDocument } from '../types/analysis';
import { compareDeclarations, comparePositions, findLocalDeclaration, isTypeDeclaration,
  selectBestDeclarationForCall, visibleDeclarationsByName as visibleDeclarations,
  declarationsInTypeHierarchy, type DeclarationResolutionInput } from './resolution';
import { findEnclosingGuiMethodContext, resolveGuiPartPath, resolveLongestGuiPartPath,
  type GuiResolutionInput, type GuiMethodContext, type ResolvedGuiPart } from './guiResolution';

export interface GuiReferenceInput extends DeclarationResolutionInput {
  analysis: DeclarationResolutionInput['analysis'] & GuiResolutionInput['analysis'];
  workspaceIndex: DeclarationResolutionInput['workspaceIndex'] & NonNullable<GuiResolutionInput['workspaceIndex']>;
}

export interface ResolvedImplicitGuiReference {
  context: GuiMethodContext;
  part?: ResolvedGuiPart;
  declaration?: AnalysisDeclaration;
  /** Local names and explicit type receivers take precedence over implicit GUI lookup. */
  preferred: boolean;
  useReceiverType?: boolean;
}

/** Resolve once; consumers only format, classify or navigate the resulting declaration. */
export function resolveImplicitGuiReference(input: GuiReferenceInput, reference: AnalysisReference): ResolvedImplicitGuiReference | undefined {
  const context = findEnclosingGuiMethodContext(input);
  if (!context || reference.typeReference) { return undefined; }
  const receiverName = reference.memberAccess?.receiverName ?? reference.name;
  const preferred = findLocalDeclaration(input.analysis, receiverName, input.position) === undefined
    && (!reference.memberAccess || !visibleDeclarations(input, receiverName).some(isTypeDeclaration));
  if (reference.memberAccess) {
    const path = [reference.memberAccess.receiverName, ...reference.memberAccess.memberNames];
    const prefix = resolveLongestGuiPartPath(input, context.rootClassName, path);
    if (!prefix) { return undefined; }
    if (prefix.length === path.length) {
      return { context, preferred, part: prefix.part, declaration: findDeclarationForGuiPart(input, prefix.part) };
    }
    let typeName: string | undefined = prefix.part.part.typeName;
    let declaration: AnalysisDeclaration | undefined;
    for (const [index, name] of path.slice(prefix.length).entries()) {
      if (!typeName) { return undefined; }
      declaration = findGuiDeclarationMember(input, typeName, name,
        index === path.length - prefix.length - 1 ? reference : undefined);
      typeName = declaration?.typeName;
    }
    return declaration ? { context, preferred, declaration } : undefined;
  }
  const part = resolveGuiPartPath(input, context.rootClassName, [reference.name]);
  if (part) { return { context, preferred, part, declaration: findDeclarationForGuiPart(input, part) }; }
  const member = findGuiDeclarationMember(input, context.receiverTypeName, reference.name, reference);
  const declaration = member
    ?? findGuiDeclarationMember(input, context.rootClassName, reference.name, reference);
  return declaration ? { context, preferred, declaration,
    useReceiverType: (member !== undefined && member.containerName === context.receiverTypeName) || declaration.containerName === undefined
  } : undefined;
}

/** Completion candidates use exactly the same owner and shadowing rules as references. */
export function implicitGuiMemberDeclarations(input: GuiReferenceInput): AnalysisDeclaration[] {
  const context = findEnclosingGuiMethodContext(input);
  if (!context) { return []; }
  const candidates = [...declarationsInTypeHierarchy(input, context.receiverTypeName),
    ...declarationsInTypeHierarchy(input, context.rootClassName)];
  const result: AnalysisDeclaration[] = [];
  for (const name of new Set(candidates.filter(d => d.kind !== 'parameter').map(d => d.name))) {
    const resolved = resolveImplicitGuiReference(input, { name, uri: input.analysis.uri,
      range: { start: input.position, end: input.position } });
    if (resolved?.preferred && resolved.declaration) { result.push(resolved.declaration); }
  }
  return result;
}

export function findGuiDeclarationMember(
  input: GuiReferenceInput,
  containerName: string,
  memberName: string,
  reference?: Pick<AnalysisReference, 'call' | 'argumentCount'>
): AnalysisDeclaration | undefined {
  return findDeclarationMemberInHierarchy(input, containerName, memberName, new Set<string>(), reference);
}

function findDeclarationMemberInHierarchy(
  input: GuiReferenceInput,
  containerName: string,
  memberName: string,
  visitedContainerNames: Set<string>,
  reference?: Pick<AnalysisReference, 'call' | 'argumentCount'>
): AnalysisDeclaration | undefined {
  if (visitedContainerNames.has(containerName)) {
    return undefined;
  }

  visitedContainerNames.add(containerName);
  const member = findDirectDeclarationMember(input, containerName, memberName, reference);
  if (member !== undefined) {
    return member;
  }

  const baseName = findTypeBaseName(input, containerName);
  if (baseName !== undefined) {
    const baseMember = findDeclarationMemberInHierarchy(input, baseName, memberName, visitedContainerNames, reference);
    if (baseMember !== undefined) {
      return baseMember;
    }
  }

  return undefined;
}

function findDirectDeclarationMember(
  input: GuiReferenceInput,
  containerName: string,
  memberName: string,
  reference?: Pick<AnalysisReference, 'call' | 'argumentCount'>
): AnalysisDeclaration | undefined {
  return selectBestDeclarationForCall(
    visibleDeclarations(input, memberName)
      .filter((declaration) => declaration.containerName === containerName)
      .sort(compareDeclarations),
    reference
  );
}

function findTypeBaseName(input: GuiReferenceInput, typeName: string): string | undefined {
  return visibleDeclarations(input, typeName)
    .filter((declaration) => declaration.kind === 'class' || declaration.kind === 'struct' || declaration.kind === 'union')
    .sort(compareDeclarations)[0]?.baseName;
}

function findPartByPath(parts: AnalysisGuiPart[], path: string[]): AnalysisGuiPart | undefined {
  for (const part of parts) {
    if (sameStringArray(part.path, path)) {
      return part;
    }

    const child = findPartByPath(part.parts, path);
    if (child !== undefined) {
      return child;
    }
  }

  return undefined;
}

export function findDeclarationForGuiPart(
  input: GuiReferenceInput,
  resolved: ResolvedGuiPart
): AnalysisDeclaration | undefined {
  if (resolved.part.name === undefined) {
    return undefined;
  }

  for (const analysis of visibleDocuments(input)) {
    if (resolved.ownerUri !== undefined && analysis.uri !== resolved.ownerUri) {
      continue;
    }

    const ownerClass = analysis.guiClasses.find((guiClass) => (
      guiClass.name === resolved.ownerName && guiClassContainsPart(guiClass, resolved.part)
    ));
    if (ownerClass === undefined) {
      continue;
    }

    const declaration = analysis.declarations.find((candidate) => (
      candidate.name === resolved.part.name && sameRange(candidate.range, resolved.part.range)
    ));
    if (declaration !== undefined) {
      return declaration;
    }
  }

  return undefined;
}

function guiClassContainsPart(guiClass: AnalysisGuiClass, target: AnalysisGuiPart): boolean {
  return findPartByPath(guiClass.parts, target.path) !== undefined;
}


function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
function sameRange(left: AnalysisRange, right: AnalysisRange): boolean {
  return comparePositions(left.start, right.start) === 0 && comparePositions(left.end, right.end) === 0;
}
function visibleDocuments(input: GuiReferenceInput): AnalyzedDocument[] {
  return [input.analysis as AnalyzedDocument, ...(input.workspaceIndex.listVisibleDocuments?.(input.analysis.uri) ?? [])];
}
