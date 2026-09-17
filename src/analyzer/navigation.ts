import { resolveImplicitGuiReference, findDeclarationForGuiPart, findGuiDeclarationMember as findDeclarationMember } from './guiReferenceResolution';
import type { DocumentationBindings } from './documentation/model';
import { systemMacroAt } from './systemMacros';
import type {
  AnalysisDeclaration,
  AnalyzedDocument,
  AnalysisGuiClass,
  AnalysisGuiMethod,
  AnalysisMemberAccess,
  AnalysisPosition,
  AnalysisRange,
  AnalysisReference,
  AnalysisResolvedInclude,
  AnalysisResolvedScriptExecution
} from '../types/analysis';
import {
  comparePositions,
  contains,
  findVisibleDeclaration,
  isTypeDeclaration,
  receiverTypeName,
  thisReceiverType,
  visibleDeclarationsByName
} from './resolution';
import {
  allGuiMethods,
  resolveGuiPartPath,
} from './guiResolution';

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
  documentationBindings?(sourceUri: string): DocumentationBindings;
  findVisibleDeclarations?(sourceUri: string, name: string): AnalysisDeclaration[];
  listVisibleDeclarations?(sourceUri: string): AnalysisDeclaration[];
  findGuiClass?(sourceUri: string, name: string): AnalysisGuiClass | undefined;
  listVisibleDocuments?(sourceUri: string): AnalyzedDocument[];
  listReferenceSearchDocuments?(sourceUri: string): AnalyzedDocument[];
  resolveIncludeAtPosition?(sourceUri: string, position: AnalysisPosition): AnalysisResolvedInclude | undefined;
  resolveScriptExecutionAtPosition?(sourceUri: string, position: AnalysisPosition): AnalysisResolvedScriptExecution | undefined;
}

export function getDefinitions(input: NavigationInput): AnalysisLocation[] {
  if (systemMacroAt(input.analysis, input.position)) { return []; }
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
  if (systemMacroAt(input.analysis, input.position)) { return []; }
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
  const writtenMacro = input.analysis.expandedMacroReferences?.find(ref => contains(ref.range, input.position));
  if (writtenMacro) { return findDeclarationForReference(input, writtenMacro); }
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

  const implicitGui = resolveImplicitGuiReference(input, reference);
  const preferredImplicitGuiDeclaration = implicitGui?.preferred ? implicitGui.declaration : undefined;
  if (preferredImplicitGuiDeclaration !== undefined) {
    return preferredImplicitGuiDeclaration;
  }

  const ordinaryDeclaration = findDeclarationForReference(input, reference);
  return ordinaryDeclaration ?? implicitGui?.declaration;
}

function referencesToDeclaration(
  navigationInput: NavigationInput,
  analysis: AnalyzedDocument,
  target: AnalysisDeclaration
): AnalysisLocation[] {
  const locations: AnalysisLocation[] = [];
  for (const reference of analysis.navigationReferences ?? analysis.references) {
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
  return (analysis.navigationReferences ?? analysis.references).find((reference) => contains(reference.range, position));
}

function findDeclarationForReference(
  input: NavigationInput,
  reference: AnalysisReference
): AnalysisDeclaration | undefined {
  if (reference.memberAccess !== undefined) {
    return findMemberDeclaration(input, reference.memberAccess, reference);
  }

  return findVisibleDeclaration(input, reference.name, reference);
}

function findMemberDeclaration(
  input: NavigationInput,
  memberAccess: AnalysisMemberAccess,
  reference?: Pick<AnalysisReference, 'call' | 'argumentCount'>
): AnalysisDeclaration | undefined {
  let typeName = memberAccess.receiverName === 'this'
    ? thisReceiverType(input)
    : receiverTypeName(input, memberAccess.receiverName)
      ?? typeDeclarationName(input, memberAccess.receiverName);
  let memberDeclaration: AnalysisDeclaration | undefined;

  for (const [index, memberName] of memberAccess.memberNames.entries()) {
    if (typeName === undefined) {
      return undefined;
    }

    const isLastMember = index === memberAccess.memberNames.length - 1;
    memberDeclaration = findDeclarationMember(input, typeName, memberName, isLastMember ? reference : undefined);
    typeName = memberDeclaration?.typeName;
  }

  return memberDeclaration;
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
