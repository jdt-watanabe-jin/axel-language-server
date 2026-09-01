import type {
  AnalysisDeclaration,
  AnalysisRange,
  AnalysisWorkspaceEdit
} from '../types/analysis';
import { getBuiltinHover } from './builtins';
import {
  findNavigationTargetDeclaration,
  getReferences,
  type NavigationInput,
  type WorkspaceNavigationIndex
} from './navigation';
import { comparePositions } from './resolution';

export interface RenameInput extends NavigationInput {
  newName: string;
}

export interface RenameRejection {
  reason: string;
}

export function prepareRename(input: NavigationInput): AnalysisRange | null {
  const target = findSafeRenameTarget(input);
  return target === undefined ? null : rangeAtPosition(input, target);
}

export function getRenameEdits(input: RenameInput): AnalysisWorkspaceEdit | RenameRejection {
  const target = findSafeRenameTarget(input);
  if (target === undefined) {
    return { reason: 'This symbol cannot be renamed.' };
  }

  if (!isIdentifierName(input.newName)) {
    return { reason: `Invalid AXEL identifier '${input.newName}'.` };
  }

  const references = getReferences({
    analysis: input.analysis,
    position: input.position,
    includeDeclaration: true,
    workspaceIndex: input.workspaceIndex
  });
  const changes: AnalysisWorkspaceEdit['changes'] = {};
  for (const location of references) {
    changes[location.uri] ??= [];
    changes[location.uri].push({
      range: location.range,
      newText: input.newName
    });
  }

  return {
    changes: sortChanges(changes)
  };
}

function findSafeRenameTarget(input: NavigationInput): AnalysisDeclaration | undefined {
  const target = findNavigationTargetDeclaration(input);
  if (target === undefined || isUnsafeRenameDeclaration(target)) {
    return undefined;
  }

  if (hasAmbiguousVisibleDeclaration(input.workspaceIndex, input.analysis.uri, target)) {
    return undefined;
  }

  return target;
}

function isUnsafeRenameDeclaration(declaration: AnalysisDeclaration): boolean {
  return declaration.kind === 'include'
    || declaration.kind === 'macro'
    || getBuiltinHover(declaration.name) !== null;
}

function hasAmbiguousVisibleDeclaration(
  workspaceIndex: WorkspaceNavigationIndex,
  sourceUri: string,
  target: AnalysisDeclaration
): boolean {
  const declarations = workspaceIndex.findVisibleDeclarations?.(sourceUri, target.name) ?? [];
  return declarations.some((declaration) => (
    declaration.id !== target.id
    && declaration.kind === target.kind
    && declaration.containerName === target.containerName
  ));
}

function rangeAtPosition(input: NavigationInput, target: AnalysisDeclaration): AnalysisRange {
  const reference = input.analysis.references.find((candidate) => (
    candidate.name === target.name && contains(candidate.range, input.position)
  ));
  return reference?.range ?? target.selectionRange;
}

function sortChanges(changes: AnalysisWorkspaceEdit['changes']): AnalysisWorkspaceEdit['changes'] {
  return Object.fromEntries(Object.entries(changes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([uri, edits]) => [
      uri,
      edits.sort((left, right) => comparePositions(left.range.start, right.range.start))
    ]));
}

function isIdentifierName(name: string): boolean {
  return /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(name);
}

function contains(range: AnalysisRange, position: AnalysisRange['start']): boolean {
  return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) < 0;
}
