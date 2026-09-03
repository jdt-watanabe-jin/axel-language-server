import type {
  AnalysisDeclaration,
  AnalyzedDocument,
  AnalysisGuiClass,
  AnalysisGuiMethod,
  AnalysisGuiPart,
  AnalysisHover,
  AnalysisMemberAccess,
  AnalysisPosition,
  AnalysisReference,
  AnalysisResolvedInclude,
  AnalysisResolvedScriptExecution,
  AnalysisRange
} from '../types/analysis';
import { getBuiltinHover } from './builtins';
import {
  findLocalDeclaration as resolveLocalDeclaration,
  findVisibleDeclaration,
  thisReceiverType,
  visibleDeclarationsByName
} from './resolution';
import {
  allGuiMethods,
  findEnclosingGuiMethodContext,
  findVisibleGuiClass,
  resolveGuiPartPath,
  resolveLongestGuiPartPath,
  type GuiMethodContext,
  type ResolvedGuiPart
} from './guiResolution';

export interface HoverInput {
  analysis: AnalyzedDocument;
  position: AnalysisPosition;
  workspaceIndex: WorkspaceDeclarationIndex;
}

export interface WorkspaceDeclarationIndex {
  findVisibleDeclarations?(sourceUri: string, name: string): AnalysisDeclaration[];
  findGuiClass?(sourceUri: string, name: string): AnalysisGuiClass | undefined;
  resolveIncludeAtPosition?(sourceUri: string, position: AnalysisPosition): AnalysisResolvedInclude | undefined;
  resolveScriptExecutionAtPosition?(sourceUri: string, position: AnalysisPosition): AnalysisResolvedScriptExecution | undefined;
}

export function getHover(input: HoverInput): AnalysisHover | null {
  const includeHover = findIncludeHover(input);
  if (includeHover !== undefined) {
    return includeHover;
  }

  const scriptExecutionHover = findScriptExecutionHover(input);
  if (scriptExecutionHover !== undefined) {
    return scriptExecutionHover;
  }

  const guiHover = findGuiHover(input);
  if (guiHover !== undefined) {
    return guiHover;
  }

  const declaration = findDeclarationAtPosition(input.analysis, input.position);

  if (declaration !== undefined) {
    return hoverForDeclaration(declaration);
  }

  const reference = findReferenceAtPosition(input.analysis, input.position);
  if (reference === undefined) {
    return null;
  }

  const preferredImplicitGuiHover = findPreferredImplicitGuiReferenceHover(input, reference);
  if (preferredImplicitGuiHover !== undefined) {
    return preferredImplicitGuiHover;
  }

  const referenceDeclaration = findDeclarationForReference(input);
  if (referenceDeclaration !== undefined) {
    return hoverForReferenceDeclaration(referenceDeclaration, reference);
  }

  const implicitGuiHover = findImplicitGuiReferenceHover(input, reference);
  if (implicitGuiHover !== undefined) {
    return implicitGuiHover;
  }

  return getBuiltinHover(reference.name);
}

function findIncludeHover(input: HoverInput): AnalysisHover | undefined {
  const include = input.workspaceIndex.resolveIncludeAtPosition?.(input.analysis.uri, input.position);
  return include === undefined ? undefined : hoverFromText(`include: ${include.filePath}`, 'text');
}

function findScriptExecutionHover(input: HoverInput): AnalysisHover | undefined {
  const execution = input.workspaceIndex.resolveScriptExecutionAtPosition?.(input.analysis.uri, input.position);
  return execution === undefined ? undefined : hoverFromText(`axel: ${execution.filePath}`, 'text');
}

function findPreferredImplicitGuiReferenceHover(
  input: HoverInput,
  reference: { name: string; memberAccess?: AnalysisMemberAccess }
): AnalysisHover | undefined {
  const memberAccess = reference.memberAccess;
  if (memberAccess === undefined) {
    const localDeclaration = findLocalDeclaration(input.analysis, reference.name, input.position);
    return localDeclaration === undefined ? findImplicitGuiReferenceHover(input, reference) : undefined;
  }

  const localReceiver = findLocalDeclaration(input.analysis, memberAccess.receiverName, input.position);
  return localReceiver === undefined && typeDeclarationName(input, memberAccess.receiverName) === undefined
    ? findImplicitGuiReferenceHover(input, reference)
    : undefined;
}

function findDeclarationAtPosition(
  analysis: AnalyzedDocument,
  position: AnalysisPosition
): AnalysisDeclaration | undefined {
  return analysis.declarations.find((declaration) => contains(declaration.selectionRange, position));
}

function findDeclarationForReference(input: HoverInput): AnalysisDeclaration | undefined {
  const reference = findReferenceAtPosition(input.analysis, input.position);
  if (reference === undefined) {
    return undefined;
  }

  if (reference.memberAccess !== undefined) {
    return findMemberDeclaration(input, reference.memberAccess, input.position);
  }

  if (reference.typeReference === true) {
    const typeDeclaration = visibleDeclarationsByName(input, reference.name).find(isTypeDeclaration);
    if (typeDeclaration !== undefined) {
      return typeDeclaration;
    }
  }

  return findDeclarationByName(input, reference.name, input.position);
}

function findGuiHover(input: HoverInput): AnalysisHover | null | undefined {
  const declaration = findDeclarationAtPosition(input.analysis, input.position);
  if (declaration !== undefined) {
    return findGuiDeclarationHover(input, declaration);
  }

  return findGuiReceiverPathHover(input)
    ?? findGuiReferenceHover(input)
    ?? findGuiBaseClassReferenceHover(input)
    ?? findGuiTypeReferenceHover(input);
}

function findGuiDeclarationHover(
  input: HoverInput,
  declaration: AnalysisDeclaration
): AnalysisHover | null | undefined {
  const guiClass = findVisibleGuiClass(input, declaration.name);
  if (declaration.kind === 'class' && guiClass !== undefined) {
    return hoverForDeclarationText(guiClassText(guiClass), declaration.documentation);
  }

  const part = findGuiPartForDeclaration(input.analysis.guiClasses, declaration);
  if (part !== undefined) {
    return hoverForDeclarationText(guiPartText(part.ownerName, part.part), declaration.documentation);
  }

  const method = findGuiMethodForDeclaration(input.analysis, declaration);
  if (method === undefined) {
    return undefined;
  }

  return isResolvableGuiMethod(input, method)
    ? hoverForDeclarationText(declaration.detail, declaration.documentation)
    : null;
}

function findGuiReferenceHover(input: HoverInput): AnalysisHover | null | undefined {
  const reference = findReferenceAtPosition(input.analysis, input.position);
  if (reference === undefined) {
    return undefined;
  }

  if (reference.memberAccess === undefined) {
    return undefined;
  }

  const part = resolveGuiMemberAccess(input, reference.memberAccess, input.position);
  return part === undefined ? undefined : hoverFromText(guiPartText(part.ownerName, part.part));
}

function findImplicitGuiReferenceHover(
  input: HoverInput,
  reference: { name: string; memberAccess?: AnalysisMemberAccess }
): AnalysisHover | undefined {
  const context = findEnclosingGuiMethodContext(input);
  if (context === undefined) {
    return undefined;
  }

  if (reference.memberAccess !== undefined) {
    return hoverForImplicitGuiMemberAccess(input, context, reference.memberAccess);
  }

  const part = resolveGuiPartPath(input, context.rootClassName, [reference.name]);
  if (part !== undefined) {
    return hoverFromText(implicitGuiPartText(context.rootClassName, part.part));
  }

  const member = findImplicitGuiContextMember(input, context, reference.name);
  const ownerMember = member
    ?? findDeclarationMemberWithoutRecovery(input, context.rootClassName, reference.name, new Set<string>());
  const shouldUseReceiverType = member !== undefined || ownerMember?.containerName === undefined;
  return ownerMember === undefined ? undefined : hoverForDeclarationText(
    shouldUseReceiverType
      ? hoverTextForGuiContextMemberDeclaration(ownerMember, context)
      : hoverTextForMemberDeclaration(ownerMember),
    ownerMember.documentation
  );
}

function findImplicitGuiContextMember(
  input: HoverInput,
  context: GuiMethodContext,
  memberName: string
): AnalysisDeclaration | undefined {
  const recoveredMember = findRecoveredGuiDeclarationMember(input, context.receiverTypeName, memberName);
  return findDirectDeclarationMember(input, context.receiverTypeName, memberName)
    ?? (isImplicitGuiRecoveredMember(recoveredMember, memberName) ? recoveredMember : undefined)
    ?? findDeclarationMemberWithoutRecovery(input, context.receiverTypeName, memberName, new Set<string>());
}

function isImplicitGuiRecoveredMember(
  declaration: AnalysisDeclaration | undefined,
  memberName: string
): declaration is AnalysisDeclaration {
  if (declaration === undefined) {
    return false;
  }

  return !declaration.detail.includes(`${memberName}(`) || /^On[A-Za-z_$][0-9A-Za-z_$]*$/.test(memberName);
}

function hoverForImplicitGuiMemberAccess(
  input: HoverInput,
  context: GuiMethodContext,
  memberAccess: AnalysisMemberAccess
): AnalysisHover | undefined {
  const path = [memberAccess.receiverName, ...memberAccess.memberNames];
  const partPrefix = resolveLongestGuiPartPath(input, context.rootClassName, path);
  if (partPrefix === undefined) {
    return undefined;
  }

  if (partPrefix.length === path.length) {
    return hoverFromText(implicitGuiPartText(context.rootClassName, partPrefix.part.part));
  }

  const memberName = path.at(-1);
  if (memberName === undefined) {
    return undefined;
  }

  const member = findDeclarationMember(input, partPrefix.part.part.typeName, memberName);
  return member === undefined ? undefined : hoverForDeclarationText(
    hoverTextForMemberDeclaration(member),
    member.documentation
  );
}

function findGuiTypeReferenceHover(input: HoverInput): AnalysisHover | undefined {
  const reference = findReferenceAtPosition(input.analysis, input.position);
  if (reference === undefined || reference.memberAccess !== undefined) {
    return undefined;
  }

  const guiClass = findVisibleGuiClass(input, reference.name);
  return guiClass === undefined ? undefined : hoverFromText(guiClassText(guiClass));
}

function findGuiBaseClassReferenceHover(
  input: HoverInput
): AnalysisHover | undefined {
  const reference = findReferenceAtPosition(input.analysis, input.position);
  if (reference === undefined) {
    return undefined;
  }

  if (reference.memberAccess !== undefined) {
    return undefined;
  }

  const declaringType = input.analysis.declarations.find((declaration) => (
    isTypeDeclaration(declaration)
    && declaration.baseName === reference.name
    && contains(declaration.range, reference.range.start)
    && isBeforeDeclarationBody(input.analysis, declaration, reference.range.start)
  ));
  if (declaringType === undefined) {
    return undefined;
  }

  const baseGuiClass = findVisibleGuiClass(input, reference.name);
  return baseGuiClass?.baseName === undefined
    ? undefined
    : hoverFromText(`class ${baseGuiClass.baseName}`);
}

function isTypeDeclaration(declaration: AnalysisDeclaration): boolean {
  return declaration.kind === 'class'
    || declaration.kind === 'struct'
    || declaration.kind === 'union'
    || declaration.kind === 'enum'
    || declaration.kind === 'typedef';
}

function isBeforeDeclarationBody(
  analysis: Pick<AnalyzedDocument, 'scopes'>,
  declaration: AnalysisDeclaration,
  position: AnalysisPosition
): boolean {
  const bodyScope = analysis.scopes
    .filter((scope) => contains(declaration.range, scope.range.start))
    .filter((scope) => positionBefore(declaration.selectionRange.start, scope.range.start))
    .sort((left, right) => comparePositions(left.range.start, right.range.start))[0];
  return bodyScope === undefined || positionBefore(position, bodyScope.range.start);
}

function findGuiReceiverPathHover(input: HoverInput): AnalysisHover | undefined {
  for (const method of allGuiMethods(input.analysis)) {
    const segmentIndex = segmentIndexAtPosition(method, input.position);
    if (segmentIndex === undefined) {
      continue;
    }

    const rootClass = findVisibleGuiClass(input, method.receiverPath[0]);
    if (segmentIndex === 0 && rootClass !== undefined) {
      return hoverFromText(guiClassText(rootClass));
    }

    const part = resolveGuiPartPath(input, method.receiverPath[0], method.receiverPath.slice(1, segmentIndex + 1));
    if (part !== undefined) {
      return hoverFromText(guiPartText(part.ownerName, part.part));
    }
  }

  return undefined;
}

function findDeclarationByName(
  input: HoverInput,
  name: string,
  position: AnalysisPosition
): AnalysisDeclaration | undefined {
  return findVisibleDeclaration({ ...input, position }, name);
}

function findReferenceAtPosition(
  analysis: AnalyzedDocument,
  position: AnalysisPosition
): AnalysisReference | undefined {
  return analysis.references.find((item) => contains(item.range, position));
}

function findMemberDeclaration(
  input: HoverInput,
  memberAccess: AnalysisMemberAccess,
  position: AnalysisPosition
): AnalysisDeclaration | undefined {
  let typeName = memberAccess.receiverName === 'this'
    ? thisReceiverType({ ...input, position })
    : findDeclarationByName(input, memberAccess.receiverName, position)?.typeName
      ?? typeDeclarationName({ ...input, position }, memberAccess.receiverName);
  let memberDeclaration: AnalysisDeclaration | undefined;

  for (const memberName of memberAccess.memberNames) {
    if (typeName === undefined) {
      return undefined;
    }

    memberDeclaration = findDeclarationMember(input, typeName, memberName);
    typeName = memberDeclaration?.typeName;
  }

  return memberDeclaration;
}

function resolveGuiMemberAccess(
  input: HoverInput,
  memberAccess: AnalysisMemberAccess,
  position: AnalysisPosition
): ResolvedGuiPart | undefined {
  const typeName = memberAccess.receiverName === 'this'
    ? thisReceiverType({ ...input, position })
    : findDeclarationByName(input, memberAccess.receiverName, position)?.typeName;
  if (typeName === undefined) {
    return undefined;
  }

  return resolveGuiPartPath(input, typeName, memberAccess.memberNames);
}

function findDeclarationMember(
  input: HoverInput,
  containerName: string,
  memberName: string
): AnalysisDeclaration | undefined {
  return findDeclarationMemberInHierarchy(input, containerName, memberName, new Set<string>());
}

function findDeclarationMemberInHierarchy(
  input: HoverInput,
  containerName: string,
  memberName: string,
  visitedContainerNames: Set<string>
): AnalysisDeclaration | undefined {
  if (visitedContainerNames.has(containerName)) {
    return undefined;
  }

  visitedContainerNames.add(containerName);
  const member = findDirectDeclarationMember(input, containerName, memberName);
  if (member !== undefined) {
    return member;
  }

  const baseName = findTypeBaseName(input, containerName);
  if (baseName !== undefined) {
    const baseMember = findDeclarationMemberInHierarchy(input, baseName, memberName, visitedContainerNames);
    if (baseMember !== undefined) {
      return baseMember;
    }
  }

  return findRecoveredGuiDeclarationMember(input, containerName, memberName)
    ?? findRecoveredStaticMember(input, containerName, memberName);
}

function findDirectDeclarationMember(
  input: HoverInput,
  containerName: string,
  memberName: string
): AnalysisDeclaration | undefined {
  return visibleDeclarations(input, memberName)
    .filter((declaration) => declaration.containerName === containerName)
    .sort(compareDeclarations)[0];
}

function findDeclarationMemberWithoutRecovery(
  input: HoverInput,
  containerName: string,
  memberName: string,
  visitedContainerNames: Set<string>
): AnalysisDeclaration | undefined {
  if (visitedContainerNames.has(containerName)) {
    return undefined;
  }

  visitedContainerNames.add(containerName);
  const member = findDirectDeclarationMember(input, containerName, memberName);
  if (member !== undefined) {
    return member;
  }

  const baseName = findTypeBaseName(input, containerName);
  return baseName === undefined
    ? undefined
    : findDeclarationMemberWithoutRecovery(input, baseName, memberName, visitedContainerNames);
}

function findRecoveredGuiDeclarationMember(
  input: HoverInput,
  containerName: string,
  memberName: string
): AnalysisDeclaration | undefined {
  if (!/^GC[A-Za-z_$][0-9A-Za-z_$]*$/.test(containerName)) {
    return undefined;
  }

  const declaration = visibleDeclarations(input, memberName)
    .filter((item) => item.containerName === undefined && isRecoveredGuiMember(item, memberName))
    .sort(compareDeclarations)[0];
  return declaration === undefined ? undefined : { ...declaration, containerName };
}

function isRecoveredGuiMember(declaration: AnalysisDeclaration, memberName: string): boolean {
  return declaration.detail.includes(`${memberName}(`) || declaration.detail.endsWith(memberName);
}

function findRecoveredStaticMember(
  input: HoverInput,
  containerName: string,
  memberName: string
): AnalysisDeclaration | undefined {
  return visibleDeclarations(input, memberName)
    .filter((declaration) => declaration.containerName === undefined)
    .filter((declaration) => declaration.detail.startsWith('static '))
    .filter((declaration) => recoveredStaticMemberOwner(input, containerName, declaration)?.name === containerName)
    .map((declaration) => ({ ...declaration, containerName }))
    .sort(compareDeclarations)[0];
}

function recoveredStaticMemberOwner(
  input: HoverInput,
  containerName: string,
  member: AnalysisDeclaration
): AnalysisDeclaration | undefined {
  return visibleDeclarations(input, containerName)
    .filter((declaration) => declaration.kind === 'class' || declaration.kind === 'struct' || declaration.kind === 'union')
    .filter((declaration) => declaration.uri === member.uri)
    .filter((declaration) => positionBefore(declaration.selectionRange.start, member.selectionRange.start))
    .sort((left, right) => comparePositions(right.selectionRange.start, left.selectionRange.start))[0];
}

function findTypeBaseName(input: HoverInput, typeName: string): string | undefined {
  return visibleDeclarations(input, typeName)
    .filter((declaration) => declaration.kind === 'class' || declaration.kind === 'struct' || declaration.kind === 'union')
    .sort(compareDeclarations)[0]?.baseName;
}

function typeDeclarationName(input: HoverInput, name: string): string | undefined {
  return visibleDeclarations(input, name)
    .find((declaration) => declaration.kind === 'class' || declaration.kind === 'struct' || declaration.kind === 'union')
    ?.name;
}

function visibleDeclarations(input: HoverInput, name: string): AnalysisDeclaration[] {
  return visibleDeclarationsByName(input, name);
}

function findLocalDeclaration(
  analysis: AnalyzedDocument,
  name: string,
  position: AnalysisPosition
): AnalysisDeclaration | undefined {
  return resolveLocalDeclaration(analysis, name, position);
}

function hoverForDeclaration(declaration: AnalysisDeclaration): AnalysisHover {
  if (declaration.kind === 'function' && declaration.containerName !== undefined) {
    return hoverForDeclarationText(hoverTextForMemberDeclaration(declaration), declaration.documentation);
  }

  const plainText = declaration.detail === declaration.kind
    ? `${declaration.detail} ${declaration.name}`
    : declaration.detail;
  return hoverForDeclarationText(plainText, declaration.documentation);
}

function hoverForReferenceDeclaration(
  declaration: AnalysisDeclaration,
  reference: { memberAccess?: AnalysisMemberAccess }
): AnalysisHover {
  const plainText = reference.memberAccess === undefined
    ? hoverTextForDeclaration(declaration)
    : hoverTextForMemberDeclaration(declaration);
  return hoverForDeclarationText(plainText, declaration.documentation);
}

function hoverTextForDeclaration(declaration: AnalysisDeclaration): string {
  return declaration.detail === declaration.kind
    ? `${declaration.detail} ${declaration.name}`
    : declaration.detail;
}

function hoverTextForMemberDeclaration(declaration: AnalysisDeclaration): string {
  if (declaration.containerName === undefined || declaration.detail.includes('::')) {
    return hoverTextForDeclaration(declaration);
  }

  const memberSignatureText = `${declaration.name}(`;
  if (declaration.detail.includes(memberSignatureText)) {
    return declaration.detail.replace(memberSignatureText, `${declaration.containerName}::${memberSignatureText}`);
  }

  const spacedMemberSignature = new RegExp(`${escapeRegExp(declaration.name)}(\\s*\\()`);
  if (spacedMemberSignature.test(declaration.detail)) {
    return declaration.detail.replace(spacedMemberSignature, `${declaration.containerName}::${declaration.name}$1`);
  }

  const memberNameText = declaration.name;
  return declaration.detail.endsWith(memberNameText)
    ? `${declaration.detail.slice(0, -memberNameText.length)}${declaration.containerName}::${memberNameText}`
    : hoverTextForDeclaration(declaration);
}

function hoverTextForGuiContextMemberDeclaration(
  declaration: AnalysisDeclaration,
  context: GuiMethodContext
): string {
  const memberSignatureText = `${declaration.name}(`;
  const ownerSignature = declaration.containerName === undefined
    ? undefined
    : `${declaration.containerName}::${memberSignatureText}`;
  if (ownerSignature !== undefined && declaration.detail.includes(ownerSignature)) {
    return declaration.detail.replace(ownerSignature, `${context.receiverTypeName}::${memberSignatureText}`);
  }

  if (declaration.detail.includes(memberSignatureText)) {
    return declaration.detail.replace(memberSignatureText, `${context.receiverTypeName}::${memberSignatureText}`);
  }

  if (declaration.containerName !== undefined) {
    const ownerSpacedMemberSignature = new RegExp(
      `${escapeRegExp(declaration.containerName)}::${escapeRegExp(declaration.name)}(\\s*\\()`
    );
    if (ownerSpacedMemberSignature.test(declaration.detail)) {
      return declaration.detail.replace(
        ownerSpacedMemberSignature,
        `${context.receiverTypeName}::${declaration.name}$1`
      );
    }
  }

  return hoverTextForMemberDeclaration({ ...declaration, containerName: context.receiverTypeName });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hoverFromText(plainText: string, language = 'axel'): AnalysisHover {
  return {
    markdown: `\`\`\`${language}\n${plainText}\n\`\`\``,
    plainText
  };
}

function hoverForDeclarationText(plainText: string, documentation: string | undefined): AnalysisHover {
  if (documentation === undefined) {
    return hoverFromText(plainText);
  }

  return {
    markdown: `\`\`\`axel\n${plainText}\n\`\`\`\n\n${documentation}`,
    plainText: `${plainText}\n${documentation}`
  };
}

function findGuiPartForDeclaration(
  guiClasses: AnalysisGuiClass[],
  declaration: AnalysisDeclaration
): ResolvedGuiPart | undefined {
  for (const guiClass of guiClasses) {
    const part = findPartInClass(guiClass, (candidate) => (
      candidate.name === declaration.name && sameRange(candidate.range, declaration.range)
    ));
    if (part !== undefined) {
      return { ownerName: guiClass.name, part };
    }
  }

  return undefined;
}

function findGuiMethodForDeclaration(
  analysis: Pick<AnalyzedDocument, 'guiClasses' | 'guiMethods'>,
  declaration: AnalysisDeclaration
): AnalysisGuiMethod | undefined {
  return allGuiMethods(analysis)
    .find((method) => method.name === declaration.name && sameRange(method.range, declaration.range));
}

function isResolvableGuiMethod(input: HoverInput, method: AnalysisGuiMethod): boolean {
  if (!method.event || method.receiverPath.length <= 2) {
    return true;
  }

  const rootName = method.receiverPath[0];
  const partPath = method.receiverPath.slice(1, -1);
  return resolveGuiPartPath(input, rootName, partPath) !== undefined;
}

function findPartInClass(
  guiClass: AnalysisGuiClass,
  predicate: (part: AnalysisGuiPart) => boolean
): AnalysisGuiPart | undefined {
  return findPart(guiClass.parts, predicate);
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

function guiPartText(ownerName: string, part: AnalysisGuiPart): string {
  return `${part.typeName} ${ownerName}::${part.path.join('.')}`;
}

function implicitGuiPartText(rootClassName: string, part: AnalysisGuiPart): string {
  return guiPartText(rootClassName, part);
}

function guiClassText(guiClass: AnalysisGuiClass): string {
  return `class ${guiClass.name} : public ${guiClass.baseName}`;
}

function sameRange(left: AnalysisRange, right: AnalysisRange): boolean {
  return samePosition(left.start, right.start) && samePosition(left.end, right.end);
}

function samePosition(left: AnalysisPosition, right: AnalysisPosition): boolean {
  return left.line === right.line && left.character === right.character;
}

function segmentIndexAtPosition(
  method: AnalysisGuiMethod,
  position: AnalysisPosition
): number | undefined {
  const segmentIndex = method.receiverPathSegmentRanges
    ?.findIndex((range) => contains(range, position));
  return segmentIndex === undefined || segmentIndex < 0 ? undefined : segmentIndex;
}

function contains(range: AnalysisRange, position: AnalysisPosition): boolean {
  return positionBeforeOrEqual(range.start, position) && positionBefore(position, range.end);
}

function positionBeforeOrEqual(left: AnalysisPosition, right: AnalysisPosition): boolean {
  return left.line < right.line || (left.line === right.line && left.character <= right.character);
}

function positionBefore(left: AnalysisPosition, right: AnalysisPosition): boolean {
  return left.line < right.line || (left.line === right.line && left.character < right.character);
}

function comparePositions(left: AnalysisPosition, right: AnalysisPosition): number {
  return left.line - right.line || left.character - right.character;
}

function compareDeclarations(left: AnalysisDeclaration, right: AnalysisDeclaration): number {
  return left.uri.localeCompare(right.uri)
    || comparePositions(left.selectionRange.start, right.selectionRange.start)
    || comparePositions(left.selectionRange.end, right.selectionRange.end);
}
