import type {
  AnalysisDeclaration,
  AnalyzedDocument,
  AnalysisGuiClass,
  AnalysisGuiMethod,
  AnalysisGuiPart,
  AnalysisMemberAccess,
  AnalysisPosition,
  AnalysisRange,
  AnalysisReference,
  AnalysisResolvedInclude,
  AnalysisResolvedScriptExecution
} from '../types/analysis';
import {
  compareDeclarations,
  comparePositions,
  contains,
  findLocalDeclaration,
  findVisibleDeclaration,
  isTypeDeclaration,
  thisReceiverType,
  visibleDeclarationsByName
} from './resolution';

export interface AnalysisLocation {
  uri: string;
  range: AnalysisRange;
}

export interface NavigationInput {
  analysis: AnalyzedDocument;
  position: AnalysisPosition;
  workspaceIndex: WorkspaceNavigationIndex;
}

export interface ReferencesInput extends NavigationInput {
  includeDeclaration: boolean;
}

export interface WorkspaceNavigationIndex {
  findVisibleDeclarations?(sourceUri: string, name: string): AnalysisDeclaration[];
  listVisibleDeclarations?(sourceUri: string): AnalysisDeclaration[];
  findGuiClass?(sourceUri: string, name: string): AnalysisGuiClass | undefined;
  listVisibleDocuments?(sourceUri: string): AnalyzedDocument[];
  listReferenceSearchDocuments?(sourceUri: string): AnalyzedDocument[];
  resolveIncludeAtPosition?(sourceUri: string, position: AnalysisPosition): AnalysisResolvedInclude | undefined;
  resolveScriptExecutionAtPosition?(sourceUri: string, position: AnalysisPosition): AnalysisResolvedScriptExecution | undefined;
}

export function getDefinitions(input: NavigationInput): AnalysisLocation[] {
  const include = input.workspaceIndex.resolveIncludeAtPosition?.(input.analysis.uri, input.position);
  if (include !== undefined) {
    return [{
      uri: include.uri,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
      }
    }];
  }

  const execution = input.workspaceIndex.resolveScriptExecutionAtPosition?.(input.analysis.uri, input.position);
  if (execution !== undefined) {
    return [{
      uri: execution.uri,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
      }
    }];
  }

  const declaration = findNavigationTargetDeclaration(input);
  return declaration === undefined ? [] : [locationFromDeclaration(declaration)];
}

export function getReferences(input: ReferencesInput): AnalysisLocation[] {
  const target = findNavigationTargetDeclaration(input);
  if (target === undefined) {
    return [];
  }

  const documents = referenceSearchDocuments(input);
  const locations = documents.flatMap((analysis) => referencesToDeclaration(input, analysis, target));
  if (input.includeDeclaration) {
    locations.push(locationFromDeclaration(target));
  }

  return uniqueLocations(locations).sort(compareLocations);
}

export function findNavigationTargetDeclaration(input: NavigationInput): AnalysisDeclaration | undefined {
  const declaration = findDeclarationAtPosition(input.analysis, input.position);
  if (declaration !== undefined) {
    return declaration;
  }

  const guiReceiverDeclaration = findGuiReceiverPathDeclaration(input);
  if (guiReceiverDeclaration !== undefined) {
    return guiReceiverDeclaration;
  }

  const reference = findReferenceAtPosition(input.analysis, input.position);
  if (reference === undefined) {
    return undefined;
  }

  const preferredImplicitGuiDeclaration = findPreferredImplicitGuiReferenceDeclaration(input, reference);
  if (preferredImplicitGuiDeclaration !== undefined) {
    return preferredImplicitGuiDeclaration;
  }

  const ordinaryDeclaration = findDeclarationForReference(input, reference);
  return ordinaryDeclaration ?? findImplicitGuiReferenceDeclaration(input, reference);
}

function referencesToDeclaration(
  navigationInput: NavigationInput,
  analysis: AnalyzedDocument,
  target: AnalysisDeclaration
): AnalysisLocation[] {
  const locations: AnalysisLocation[] = [];
  for (const reference of analysis.references) {
    const declaration = findNavigationTargetDeclaration({
      analysis,
      position: reference.range.start,
      workspaceIndex: navigationInput.workspaceIndex
    });
    if (declaration?.id === target.id) {
      locations.push(locationFromReference(reference));
    }
  }

  return locations;
}

function findDeclarationAtPosition(
  analysis: AnalyzedDocument,
  position: AnalysisPosition
): AnalysisDeclaration | undefined {
  return analysis.declarations.find((declaration) => contains(declaration.selectionRange, position));
}

function findReferenceAtPosition(
  analysis: AnalyzedDocument,
  position: AnalysisPosition
): AnalysisReference | undefined {
  return analysis.references.find((reference) => contains(reference.range, position));
}

function findPreferredImplicitGuiReferenceDeclaration(
  input: NavigationInput,
  reference: AnalysisReference
): AnalysisDeclaration | undefined {
  if (reference.memberAccess === undefined) {
    const localDeclaration = findLocalDeclaration(input.analysis, reference.name, input.position);
    return localDeclaration === undefined ? findImplicitGuiReferenceDeclaration(input, reference) : undefined;
  }

  const localReceiver = findLocalDeclaration(input.analysis, reference.memberAccess.receiverName, input.position);
  return localReceiver === undefined && typeDeclarationName(input, reference.memberAccess.receiverName) === undefined
    ? findImplicitGuiReferenceDeclaration(input, reference)
    : undefined;
}

function findDeclarationForReference(
  input: NavigationInput,
  reference: AnalysisReference
): AnalysisDeclaration | undefined {
  if (reference.memberAccess !== undefined) {
    return findMemberDeclaration(input, reference.memberAccess);
  }

  return findVisibleDeclaration(input, reference.name);
}

function findMemberDeclaration(
  input: NavigationInput,
  memberAccess: AnalysisMemberAccess
): AnalysisDeclaration | undefined {
  let typeName = memberAccess.receiverName === 'this'
    ? thisReceiverType(input)
    : findVisibleDeclaration(input, memberAccess.receiverName)?.typeName
      ?? typeDeclarationName(input, memberAccess.receiverName);
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

function findImplicitGuiReferenceDeclaration(
  input: NavigationInput,
  reference: AnalysisReference
): AnalysisDeclaration | undefined {
  const context = findEnclosingGuiMethodContext(input);
  if (context === undefined) {
    return undefined;
  }

  if (reference.memberAccess !== undefined) {
    return findImplicitGuiMemberAccessDeclaration(input, context, reference.memberAccess);
  }

  const part = resolveGuiPartPath(input, context.rootClassName, [reference.name]);
  if (part !== undefined) {
    return findDeclarationForGuiPart(input, part);
  }

  return findDeclarationMember(input, context.receiverTypeName, reference.name)
    ?? findDeclarationMember(input, context.rootClassName, reference.name);
}

function findImplicitGuiMemberAccessDeclaration(
  input: NavigationInput,
  context: GuiMethodContext,
  memberAccess: AnalysisMemberAccess
): AnalysisDeclaration | undefined {
  const path = [memberAccess.receiverName, ...memberAccess.memberNames];
  const partPrefix = resolveLongestGuiPartPath(input, context.rootClassName, path);
  if (partPrefix === undefined) {
    return undefined;
  }

  if (partPrefix.length === path.length) {
    return findDeclarationForGuiPart(input, partPrefix.part);
  }

  const memberName = path.at(-1);
  return memberName === undefined
    ? undefined
    : findDeclarationMember(input, partPrefix.part.part.typeName, memberName);
}

function findGuiReceiverPathDeclaration(input: NavigationInput): AnalysisDeclaration | undefined {
  for (const method of allGuiMethods(input.analysis)) {
    const segmentIndex = segmentIndexAtPosition(method, input.position);
    if (segmentIndex === undefined) {
      continue;
    }

    if (segmentIndex === 0) {
      return findVisibleDeclaration(input, method.receiverPath[0]);
    }

    const part = resolveGuiPartPath(input, method.receiverPath[0], method.receiverPath.slice(1, segmentIndex + 1));
    if (part !== undefined) {
      return findDeclarationForGuiPart(input, part);
    }
  }

  return undefined;
}

function findDeclarationMember(
  input: NavigationInput,
  containerName: string,
  memberName: string
): AnalysisDeclaration | undefined {
  return findDeclarationMemberInHierarchy(input, containerName, memberName, new Set<string>());
}

function findDeclarationMemberInHierarchy(
  input: NavigationInput,
  containerName: string,
  memberName: string,
  visitedContainerNames: Set<string>
): AnalysisDeclaration | undefined {
  if (visitedContainerNames.has(containerName)) {
    return undefined;
  }

  visitedContainerNames.add(containerName);
  const member = visibleDeclarations(input, memberName)
    .filter((declaration) => declaration.containerName === containerName)
    .sort(compareDeclarations)[0];
  if (member !== undefined) {
    return member;
  }

  const baseName = visibleDeclarations(input, containerName)
    .filter(isTypeDeclaration)
    .sort(compareDeclarations)[0]?.baseName;
  if (baseName !== undefined) {
    const baseMember = findDeclarationMemberInHierarchy(input, baseName, memberName, visitedContainerNames);
    if (baseMember !== undefined) {
      return baseMember;
    }
  }

  return findRecoveredGuiDeclarationMember(input, containerName, memberName)
    ?? findRecoveredStaticMember(input, containerName, memberName);
}

function findRecoveredGuiDeclarationMember(
  input: NavigationInput,
  containerName: string,
  memberName: string
): AnalysisDeclaration | undefined {
  if (!/^GC[A-Za-z_$][0-9A-Za-z_$]*$/.test(containerName)) {
    return undefined;
  }

  return visibleDeclarations(input, memberName)
    .filter((declaration) => declaration.containerName === undefined && isRecoveredGuiMember(declaration, memberName))
    .sort(compareDeclarations)[0];
}

function isRecoveredGuiMember(declaration: AnalysisDeclaration, memberName: string): boolean {
  return declaration.detail.includes(`${memberName}(`) || declaration.detail.endsWith(memberName);
}

function findRecoveredStaticMember(
  input: NavigationInput,
  containerName: string,
  memberName: string
): AnalysisDeclaration | undefined {
  return visibleDeclarations(input, memberName)
    .filter((declaration) => declaration.containerName === undefined)
    .filter((declaration) => declaration.detail.startsWith('static '))
    .filter((declaration) => recoveredStaticMemberOwner(input, declaration)?.name === containerName)
    .map((declaration) => ({ ...declaration, containerName }))
    .sort(compareDeclarations)[0];
}

function recoveredStaticMemberOwner(
  input: NavigationInput,
  member: AnalysisDeclaration
): AnalysisDeclaration | undefined {
  return input.workspaceIndex.listVisibleDeclarations?.(input.analysis.uri)
    .filter(isTypeDeclaration)
    .filter((declaration) => declaration.uri === member.uri)
    .filter((declaration) => comparePositions(declaration.selectionRange.start, member.selectionRange.start) < 0)
    .sort((left, right) => comparePositions(right.selectionRange.start, left.selectionRange.start))[0];
}

interface GuiMethodContext {
  rootClassName: string;
  receiverTypeName: string;
}

function findEnclosingGuiMethodContext(input: NavigationInput): GuiMethodContext | undefined {
  for (const guiClass of input.analysis.guiClasses) {
    const context = findEnclosingGuiMethodContextInClass(input, guiClass);
    if (context !== undefined) {
      return context;
    }
  }

  for (const method of input.analysis.guiMethods) {
    const context = guiMethodContextFromReceiverPath(input, method);
    if (context !== undefined && contains(method.range, input.position)) {
      return context;
    }
  }

  return undefined;
}

function findEnclosingGuiMethodContextInClass(
  input: NavigationInput,
  guiClass: AnalysisGuiClass
): GuiMethodContext | undefined {
  const classMethod = guiClass.methods.find((method) => contains(method.range, input.position));
  if (classMethod !== undefined) {
    return guiMethodContextFromReceiverPath(input, classMethod)
      ?? { rootClassName: guiClass.name, receiverTypeName: guiClass.name };
  }

  const partMethod = findEnclosingGuiPartMethod(guiClass.parts, input.position);
  if (partMethod !== undefined) {
    return { rootClassName: guiClass.name, receiverTypeName: partMethod.part.typeName };
  }

  return undefined;
}

function findEnclosingGuiPartMethod(
  parts: AnalysisGuiPart[],
  position: AnalysisPosition
): { part: AnalysisGuiPart; method: AnalysisGuiMethod } | undefined {
  for (const part of parts) {
    const method = part.methods.find((candidate) => contains(candidate.range, position));
    if (method !== undefined) {
      return { part, method };
    }

    const childMethod = findEnclosingGuiPartMethod(part.parts, position);
    if (childMethod !== undefined) {
      return childMethod;
    }
  }

  return undefined;
}

function guiMethodContextFromReceiverPath(
  input: NavigationInput,
  method: AnalysisGuiMethod
): GuiMethodContext | undefined {
  const rootClassName = method.receiverPath[0];
  if (rootClassName === undefined) {
    return undefined;
  }

  const partPath = method.receiverPath.slice(1, -1);
  if (partPath.length === 0) {
    return { rootClassName, receiverTypeName: rootClassName };
  }

  const part = resolveGuiPartPath(input, rootClassName, partPath);
  return part === undefined ? undefined : { rootClassName, receiverTypeName: part.part.typeName };
}

interface ResolvedGuiPart {
  ownerUri?: string;
  ownerName: string;
  part: AnalysisGuiPart;
}

interface ResolvedGuiPartPrefix {
  length: number;
  part: ResolvedGuiPart;
}

function resolveGuiPartPath(input: NavigationInput, rootClassName: string, path: string[]): ResolvedGuiPart | undefined {
  let owner = findVisibleGuiClassEntry(input, rootClassName);
  let ownerPath: string[] = [];
  let resolved: ResolvedGuiPart | undefined;
  const rootOwner = owner;
  if (rootOwner !== undefined) {
    const directPart = findPartByPath(rootOwner.guiClass.parts, path);
    if (directPart !== undefined) {
      return { ownerUri: rootOwner.uri, ownerName: rootOwner.guiClass.name, part: directPart };
    }
  }

  for (const segment of path) {
    if (owner === undefined) {
      return undefined;
    }

    const nextPath = [...ownerPath, segment];
    const part = findPartByPath(owner.guiClass.parts, nextPath) ?? findPartByPath(owner.guiClass.parts, [segment]);
    if (part === undefined) {
      return undefined;
    }

    resolved = { ownerUri: owner.uri, ownerName: owner.guiClass.name, part };
    const partClass = findVisibleGuiClassEntry(input, part.typeName);
    owner = partClass ?? owner;
    ownerPath = partClass === undefined ? nextPath : [];
  }

  return resolved;
}

function resolveLongestGuiPartPath(
  input: NavigationInput,
  rootClassName: string,
  path: string[]
): ResolvedGuiPartPrefix | undefined {
  for (let length = path.length; length > 0; length -= 1) {
    const part = resolveGuiPartPath(input, rootClassName, path.slice(0, length));
    if (part !== undefined) {
      return { length, part };
    }
  }

  return undefined;
}

interface GuiClassEntry {
  uri?: string;
  guiClass: AnalysisGuiClass;
}

function findVisibleGuiClassEntry(input: NavigationInput, name: string): GuiClassEntry | undefined {
  for (const analysis of visibleDocuments(input)) {
    const guiClass = analysis.guiClasses.find((candidate) => candidate.name === name);
    if (guiClass !== undefined) {
      return { uri: analysis.uri, guiClass };
    }
  }

  const guiClass = input.workspaceIndex.findGuiClass?.(input.analysis.uri, name);
  return guiClass === undefined ? undefined : { guiClass };
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

function findDeclarationForGuiPart(
  input: NavigationInput,
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

function visibleDeclarations(input: NavigationInput, name: string): AnalysisDeclaration[] {
  return visibleDeclarationsByName(input, name);
}

function typeDeclarationName(input: NavigationInput, name: string): string | undefined {
  return visibleDeclarations(input, name)
    .find(isTypeDeclaration)
    ?.name;
}

function visibleDocuments(input: NavigationInput): AnalyzedDocument[] {
  const documents = [
    input.analysis,
    ...(input.workspaceIndex.listVisibleDocuments?.(input.analysis.uri) ?? [])
  ];
  return Array.from(new Map(documents.map((analysis) => [analysis.uri, analysis])).values());
}

function referenceSearchDocuments(input: NavigationInput): AnalyzedDocument[] {
  const documents = [
    input.analysis,
    ...(input.workspaceIndex.listReferenceSearchDocuments?.(input.analysis.uri) ?? visibleDocuments(input))
  ];
  return Array.from(new Map(documents.map((analysis) => [analysis.uri, analysis])).values());
}

function allGuiMethods(analysis: Pick<AnalyzedDocument, 'guiClasses' | 'guiMethods'>): AnalysisGuiMethod[] {
  return [
    ...analysis.guiMethods,
    ...analysis.guiClasses.flatMap((guiClass) => guiClass.methods)
  ];
}

function segmentIndexAtPosition(
  method: AnalysisGuiMethod,
  position: AnalysisPosition
): number | undefined {
  const segmentIndex = method.receiverPathSegmentRanges
    ?.findIndex((range) => contains(range, position));
  return segmentIndex === undefined || segmentIndex < 0 ? undefined : segmentIndex;
}

function locationFromDeclaration(declaration: AnalysisDeclaration): AnalysisLocation {
  return {
    uri: declaration.uri,
    range: declaration.selectionRange
  };
}

function locationFromReference(reference: AnalysisReference): AnalysisLocation {
  return {
    uri: reference.uri,
    range: reference.range
  };
}

function uniqueLocations(locations: AnalysisLocation[]): AnalysisLocation[] {
  return Array.from(new Map(locations.map((location) => [locationKey(location), location])).values());
}

function locationKey(location: AnalysisLocation): string {
  return [
    location.uri,
    location.range.start.line,
    location.range.start.character,
    location.range.end.line,
    location.range.end.character
  ].join(':');
}

function compareLocations(left: AnalysisLocation, right: AnalysisLocation): number {
  return left.uri.localeCompare(right.uri)
    || comparePositions(left.range.start, right.range.start)
    || comparePositions(left.range.end, right.range.end);
}

function sameRange(left: AnalysisRange, right: AnalysisRange): boolean {
  return samePosition(left.start, right.start) && samePosition(left.end, right.end);
}

function samePosition(left: AnalysisPosition, right: AnalysisPosition): boolean {
  return left.line === right.line && left.character === right.character;
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
