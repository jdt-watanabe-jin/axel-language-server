import type {
  AnalysisDeclaration,
  AnalyzedDocument,
  AnalysisPosition,
  AnalysisRange,
  AnalysisScope
} from '../types/analysis';

export interface WorkspaceDeclarationLookup {
  findVisibleDeclarations?(sourceUri: string, name: string): AnalysisDeclaration[];
  listVisibleDeclarations?(sourceUri: string): AnalysisDeclaration[];
}

export interface DeclarationResolutionInput {
  analysis: Pick<AnalyzedDocument, 'uri' | 'declarations' | 'scopes'>;
  position: AnalysisPosition;
  workspaceIndex: WorkspaceDeclarationLookup;
}

export interface DeclarationCallResolution {
  call?: boolean;
  argumentCount?: number;
}

export interface AcceptedArgumentCounts {
  min: number;
  max: number;
}

export function findLocalDeclaration(
  analysis: Pick<AnalyzedDocument, 'uri' | 'declarations' | 'scopes'>,
  name: string,
  position: AnalysisPosition,
  callResolution?: DeclarationCallResolution
): AnalysisDeclaration | undefined {
  return selectBestDeclarationForCall(findLocalDeclarations(analysis, name, position), callResolution);
}

function findLocalDeclarations(
  analysis: Pick<AnalyzedDocument, 'uri' | 'declarations' | 'scopes'>,
  name: string,
  position: AnalysisPosition
): AnalysisDeclaration[] {
  const declarations = new Map(analysis.declarations.map((declaration) => [declaration.id, declaration]));
  let scope = findInnermostScope(analysis.scopes, position);

  while (scope !== undefined) {
    const candidates = scope.declarationIds
      .map((id) => declarations.get(id))
      .filter((item): item is AnalysisDeclaration => (
        item?.name === name && isVisibleAt(item, position, analysis.uri)
      ))
      .sort((left, right) => comparePositions(right.selectionRange.start, left.selectionRange.start));
    if (candidates.length > 0) {
      return candidates;
    }

    scope = analysis.scopes.find((item) => item.id === scope?.parentId);
  }

  return [];
}

export function findVisibleDeclaration(
  input: DeclarationResolutionInput,
  name: string,
  callResolution?: DeclarationCallResolution
): AnalysisDeclaration | undefined {
  return findLocalDeclaration(input.analysis, name, input.position, callResolution)
    ?? selectBestDeclarationForCall(
      input.workspaceIndex.findVisibleDeclarations?.(input.analysis.uri, name) ?? [],
      callResolution
    );
}

export function listVisibleDeclarations(input: DeclarationResolutionInput): AnalysisDeclaration[] {
  const declarations = [
    ...input.analysis.declarations,
    ...(input.workspaceIndex.listVisibleDeclarations?.(input.analysis.uri) ?? [])
  ];
  return Array.from(new Map(declarations.map((declaration) => [declaration.id, declaration])).values())
    .sort(compareDeclarations);
}

export function visibleDeclarationsByName(
  input: DeclarationResolutionInput,
  name: string
): AnalysisDeclaration[] {
  const listed = input.workspaceIndex.listVisibleDeclarations?.(input.analysis.uri);
  if (listed !== undefined) {
    return Array.from(new Map([
      ...input.analysis.declarations,
      ...listed
    ].map((declaration) => [declaration.id, declaration])).values())
      .filter((declaration) => declaration.name === name)
      .sort(compareDeclarations);
  }

  return [
    ...input.analysis.declarations.filter((declaration) => declaration.name === name),
    ...(input.workspaceIndex.findVisibleDeclarations?.(input.analysis.uri, name) ?? [])
  ].sort(compareDeclarations);
}

export function declarationsInTypeHierarchy(
  input: DeclarationResolutionInput,
  typeName: string
): AnalysisDeclaration[] {
  const declarations: AnalysisDeclaration[] = [];
  const visited = new Set<string>();

  function visit(currentTypeName: string): void {
    if (visited.has(currentTypeName)) {
      return;
    }

    visited.add(currentTypeName);
    const visible = listVisibleDeclarations(input);
    declarations.push(...visible.filter((declaration) => (
      declaration.containerName === currentTypeName
    )));
    declarations.push(...recoveredStaticMemberDeclarations(visible, currentTypeName));

    const baseName = visible
      .find((declaration) => isTypeDeclaration(declaration) && declaration.name === currentTypeName)
      ?.baseName;
    if (baseName !== undefined) {
      visit(baseName);
    }
  }

  visit(typeName);
  return Array.from(new Map(declarations.map((declaration) => [declaration.id, declaration])).values())
    .sort(compareDeclarations);
}

export function findDeclarationMember(
  input: DeclarationResolutionInput,
  containerName: string,
  memberName: string,
  callResolution?: DeclarationCallResolution
): AnalysisDeclaration | undefined {
  return selectBestDeclarationForCall(
    declarationsInTypeHierarchy(input, containerName)
      .filter((declaration) => declaration.name === memberName)
      .sort(compareDeclarations),
    callResolution
  );
}

export function resolveMemberAccessType(
  input: DeclarationResolutionInput,
  rootTypeName: string,
  path: string[]
): string | undefined {
  let typeName: string | undefined = rootTypeName;
  for (const memberName of path) {
    if (typeName === undefined) {
      return undefined;
    }

    typeName = findDeclarationMember(input, typeName, memberName)?.typeName;
  }

  return typeName;
}

export function receiverTypeName(input: DeclarationResolutionInput, receiverName: string): string | undefined {
  return (findLocalDeclaration(input.analysis, receiverName, input.position)
    ?? visibleDeclarationsByName(input, receiverName)[0])
    ?.typeName;
}

export function selectBestDeclarationForCall<T extends AnalysisDeclaration>(
  declarations: T[],
  callResolution: DeclarationCallResolution | undefined
): T | undefined {
  if (callResolution?.call === true && callResolution.argumentCount !== undefined) {
    const argumentCount = callResolution.argumentCount;
    const callableDeclarations = declarations.filter((declaration) => declaration.signature !== undefined);
    const matchingDeclaration = callableDeclarations.find((declaration) => (
      acceptsArgumentCount(acceptedArgumentCounts(declaration), argumentCount)
    ));
    if (matchingDeclaration !== undefined) {
      return matchingDeclaration;
    }

    if (callableDeclarations.length > 0) {
      return callableDeclarations[0];
    }
  }

  return declarations[0];
}

export function acceptedArgumentCounts(declaration: AnalysisDeclaration): AcceptedArgumentCounts {
  const parameters = declaration.signature?.parameters ?? [];
  const restParameterIndex = parameters.findIndex((parameter) => parameter.label.includes('...'));
  if (restParameterIndex >= 0) {
    return {
      min: requiredParameterCount(parameters.slice(0, restParameterIndex)),
      max: Number.POSITIVE_INFINITY
    };
  }

  return {
    min: requiredParameterCount(parameters),
    max: parameters.length
  };
}

export function acceptsArgumentCount(counts: AcceptedArgumentCounts, argumentCount: number): boolean {
  return counts.min <= argumentCount && argumentCount <= counts.max;
}

function requiredParameterCount(parameters: NonNullable<AnalysisDeclaration['signature']>['parameters']): number {
  const firstOptionalIndex = parameters.findIndex((parameter) => parameter.optional === true);
  return firstOptionalIndex < 0 ? parameters.length : firstOptionalIndex;
}

function recoveredStaticMemberDeclarations(
  declarations: AnalysisDeclaration[],
  containerName: string
): AnalysisDeclaration[] {
  return declarations
    .filter((declaration) => declaration.containerName === undefined)
    .filter((declaration) => declaration.detail.startsWith('static '))
    .filter((declaration) => recoveredStaticMemberOwner(declarations, declaration)?.name === containerName)
    .map((declaration) => ({ ...declaration, containerName }));
}

function recoveredStaticMemberOwner(
  declarations: AnalysisDeclaration[],
  member: AnalysisDeclaration
): AnalysisDeclaration | undefined {
  return declarations
    .filter(isTypeDeclaration)
    .filter((declaration) => declaration.uri === member.uri)
    .filter((declaration) => positionBefore(declaration.selectionRange.start, member.selectionRange.start))
    .sort((left, right) => comparePositions(right.selectionRange.start, left.selectionRange.start))[0];
}

export function thisReceiverType(input: DeclarationResolutionInput): string | undefined {
  const containingDeclarations = input.analysis.declarations
    .filter((declaration) => contains(declaration.range, input.position))
    .sort((left, right) => rangeSize(left.range) - rangeSize(right.range));

  const method = containingDeclarations.find((declaration) => (
    declaration.kind === 'function' && declaration.containerName !== undefined
  ));
  if (method?.containerName !== undefined) {
    return method.containerName;
  }

  return containingDeclarations.find(isTypeDeclaration)?.name;
}

export function isTypeDeclaration(declaration: AnalysisDeclaration): boolean {
  return declaration.kind === 'class'
    || declaration.kind === 'struct'
    || declaration.kind === 'union'
    || declaration.kind === 'enum'
    || declaration.kind === 'typedef';
}

export function isVisibleAt(
  declaration: AnalysisDeclaration,
  position: AnalysisPosition,
  sourceUri: string
): boolean {
  return declaration.uri !== sourceUri || positionBeforeOrEqual(declaration.selectionRange.start, position);
}

export function findInnermostScope(
  scopes: AnalysisScope[],
  position: AnalysisPosition
): AnalysisScope | undefined {
  return scopes
    .filter((scope) => contains(scope.range, position))
    .sort((left, right) => rangeSize(left.range) - rangeSize(right.range))[0];
}

export function contains(range: AnalysisRange, position: AnalysisPosition): boolean {
  return positionBeforeOrEqual(range.start, position) && positionBefore(position, range.end);
}

export function positionBeforeOrEqual(left: AnalysisPosition, right: AnalysisPosition): boolean {
  return left.line < right.line || (left.line === right.line && left.character <= right.character);
}

export function positionBefore(left: AnalysisPosition, right: AnalysisPosition): boolean {
  return left.line < right.line || (left.line === right.line && left.character < right.character);
}

export function comparePositions(left: AnalysisPosition, right: AnalysisPosition): number {
  return left.line - right.line || left.character - right.character;
}

export function compareDeclarations(left: AnalysisDeclaration, right: AnalysisDeclaration): number {
  return left.uri.localeCompare(right.uri)
    || comparePositions(left.selectionRange.start, right.selectionRange.start)
    || comparePositions(left.selectionRange.end, right.selectionRange.end);
}

export function rangeSize(range: AnalysisRange): number {
  return (range.end.line - range.start.line) * 1_000_000 + range.end.character - range.start.character;
}
