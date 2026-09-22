import { findEnclosingGuiMethodContext, type GuiResolutionInput } from './guiResolution';
import type {
  AnalysisGuiClass,
  AnalysisDeclaration,
  AnalyzedDocument,
  AnalysisPosition,
  AnalysisRange,
  AnalysisScope
} from '../types/analysis';

export interface WorkspaceDeclarationLookup extends NonNullable<GuiResolutionInput['workspaceIndex']> {
  getVisibleDeclarationSnapshot?(sourceUri: string): readonly AnalysisDeclaration[];
  findVisibleGuiClasses?(sourceUri: string, name: string): AnalysisGuiClass[];
  findVisibleDeclarations?(sourceUri: string, name: string): AnalysisDeclaration[];
  listVisibleDeclarations?(sourceUri: string): AnalysisDeclaration[];
}

export interface DeclarationResolutionInput {
  analysis: Pick<AnalyzedDocument, 'uri' | 'declarations' | 'scopes'> & Partial<Pick<AnalyzedDocument, 'guiClasses' | 'guiMethods'>>;
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

// Declaration arrays identify immutable analysis generations. Weak keys release old generations.
interface DeclarationIndex {
  declarations: AnalysisDeclaration[];
  byName: Map<string, AnalysisDeclaration[]>;
  byContainer: Map<string, AnalysisDeclaration[]>;
  hierarchies: Map<string, AnalysisDeclaration[]>;
}
const emptyDeclarations: AnalysisDeclaration[] = [];
const visibleIndexes = new WeakMap<AnalysisDeclaration[], WeakMap<readonly AnalysisDeclaration[], DeclarationIndex>>();
const scopeIdIndexes = new WeakMap<AnalysisScope[], Map<string, AnalysisScope>>();
const localIndexes = new WeakMap<AnalysisDeclaration[], Map<string, AnalysisDeclaration>>();
const scopeNameIndexes = new WeakMap<AnalysisDeclaration[], WeakMap<string[], Map<string, AnalysisDeclaration[]>>>();

function visibleDeclarationsSnapshot(input: DeclarationResolutionInput): readonly AnalysisDeclaration[] | undefined {
  return input.workspaceIndex.getVisibleDeclarationSnapshot?.(input.analysis.uri)
    ?? input.workspaceIndex.listVisibleDeclarations?.(input.analysis.uri);
}

function visibleIndex(input: DeclarationResolutionInput, listed = visibleDeclarationsSnapshot(input) ?? emptyDeclarations): DeclarationIndex {
  let generations = visibleIndexes.get(input.analysis.declarations);
  if (!generations) { generations = new WeakMap(); visibleIndexes.set(input.analysis.declarations, generations); }
  const cached = generations.get(listed);
  if (cached) { return cached; }
  const declarations = Array.from(new Map([...input.analysis.declarations, ...listed].map(d => [d.id, d])).values()).sort(compareDeclarations);
  const index: DeclarationIndex = {declarations, byName:new Map(), byContainer:new Map(), hierarchies:new Map()};
  for (const declaration of declarations) {
    const names = index.byName.get(declaration.name) ?? [];
    names.push(declaration); index.byName.set(declaration.name, names);
    if (declaration.containerName !== undefined) {
      const members = index.byContainer.get(declaration.containerName) ?? [];
      members.push(declaration); index.byContainer.set(declaration.containerName, members);
    }
  }
  generations.set(listed, index);
  return index;
}

export function findLocalDeclaration(
  analysis: DeclarationResolutionInput['analysis'],
  name: string,
  position: AnalysisPosition,
  callResolution?: DeclarationCallResolution
): AnalysisDeclaration | undefined {
  return selectBestDeclarationForCall(findLocalDeclarations(analysis, name, position), callResolution);
}

export function findLocalDeclarations(
  analysis: DeclarationResolutionInput['analysis'],
  name: string,
  position: AnalysisPosition
): AnalysisDeclaration[] {
  let declarations = localIndexes.get(analysis.declarations);
  if (!declarations) {
    declarations = new Map(analysis.declarations.map(declaration => [declaration.id, declaration]));
    localIndexes.set(analysis.declarations, declarations);
  }
  let scopeIds = scopeIdIndexes.get(analysis.scopes);
  if (!scopeIds) {
    scopeIds = new Map(analysis.scopes.map(scope => [scope.id, scope]));
    scopeIdIndexes.set(analysis.scopes, scopeIds);
  }
  let scope = findInnermostScope(analysis.scopes, position);

  let scoped = scopeNameIndexes.get(analysis.declarations);
  if (!scoped) { scoped = new WeakMap(); scopeNameIndexes.set(analysis.declarations, scoped); }
  while (scope !== undefined) {
    const globalScope = scope.parentId === undefined;
    if (globalScope) {
      // Out-of-class definitions have a file-level lexical scope, but belong
      // to their class. Search that class before considering global functions.
      // GUI event receivers are resolved separately by implicit GUI lookup.
      const input = { analysis, position, workspaceIndex: {} };
      const { guiClasses, guiMethods } = analysis;
      const guiContext = guiClasses && guiMethods && findEnclosingGuiMethodContext({
        analysis: { uri: analysis.uri, declarations: analysis.declarations, guiClasses, guiMethods }, position
      });
      let owner = guiContext ? undefined : thisReceiverType(input);
      const visited = new Set<string>();
      while (owner !== undefined && !visited.has(owner)) {
        visited.add(owner);
        const index = visibleIndex(input);
        const members = (index.byContainer.get(owner) ?? [])
          .filter(declaration => declaration.name === name
            && (declaration.kind === 'function' || declaration.kind === 'method'));
        if (members.length > 0) { return members; }
        owner = index.byName.get(owner)?.find(isTypeDeclaration)?.baseName;
      }
    }
    let names = scoped.get(scope.declarationIds);
    if (!names) {
      names = new Map();
      for (const id of scope.declarationIds) {
        const declaration = declarations.get(id);
        if (!declaration) { continue; }
        const entries = names.get(declaration.name) ?? [];
        entries.push(declaration); names.set(declaration.name, entries);
      }
      scoped.set(scope.declarationIds, names);
    }
    const candidates = (names.get(name) ?? [])
      .filter(item => !globalScope || item.containerName === undefined
        || (item.kind !== 'function' && item.kind !== 'method'))
      .filter(item => isVisibleAt(item, position, analysis.uri))
      .sort((left, right) => comparePositions(right.selectionRange.start, left.selectionRange.start));
    if (candidates.length > 0) {
      return candidates;
    }

    scope = scope.parentId === undefined ? undefined : scopeIds.get(scope.parentId);
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
  return visibleIndex(input).declarations.slice();
}

export function visibleDeclarationsByName(
  input: DeclarationResolutionInput,
  name: string
): AnalysisDeclaration[] {
  const listed = visibleDeclarationsSnapshot(input);
  if (listed !== undefined) {
    return visibleIndex(input, listed).byName.get(name)?.slice() ?? [];
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
  const index = visibleIndex(input);
  const cached = index.hierarchies.get(typeName);
  if (cached) { return cached.slice(); }
  const declarations: AnalysisDeclaration[] = [];
  const visited = new Set<string>();
  function visit(currentTypeName: string): void {
    if (visited.has(currentTypeName)) { return; }
    visited.add(currentTypeName);
    declarations.push(...index.byContainer.get(currentTypeName) ?? []);
    const baseName = index.byName.get(currentTypeName)?.find(isTypeDeclaration)?.baseName;
    if (baseName !== undefined) { visit(baseName); }
  }
  visit(typeName);
  const result = Array.from(new Map(declarations.map(declaration => [declaration.id, declaration])).values()).sort(compareDeclarations);
  index.hierarchies.set(typeName, result);
  return result.slice();
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
  const local = findLocalDeclaration(input.analysis, receiverName, input.position);
  const localScope = local && input.analysis.scopes.find(scope => scope.declarationIds.includes(local.id));
  if (local && localScope?.parentId !== undefined) {
    return local.typeName;
  }

  // Out-of-class method bodies have a lexical parent at file scope. Resolve
  // their owning class fields before globals or unrelated header declarations.
  const owner = thisReceiverType(input);
  const member = owner === undefined ? undefined : findDeclarationMember(input, owner, receiverName);
  return (member ?? local ?? visibleDeclarationsByName(input, receiverName)[0])?.typeName;
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

interface OwnerScope extends AnalysisScope { declaration: AnalysisDeclaration }
const ownerScopeIndexes = new WeakMap<AnalysisDeclaration[], { methods: OwnerScope[]; types: OwnerScope[] }>();
function ownerScopes(declarations: AnalysisDeclaration[]): { methods: OwnerScope[]; types: OwnerScope[] } {
  let index = ownerScopeIndexes.get(declarations);
  if (!index) {
    index = { methods: [], types: [] };
    for (const declaration of declarations) {
      const method = declaration.kind === 'function' && declaration.containerName !== undefined;
      if (!method && !isTypeDeclaration(declaration)) { continue; }
      const scope = { id: declaration.id, declaration, range: declaration.range, declarationIds: [] };
      (method ? index.methods : index.types).push(scope);
    }
    ownerScopeIndexes.set(declarations, index);
  }
  return index;
}

export function thisReceiverType(input: DeclarationResolutionInput): string | undefined {
  const { guiClasses, guiMethods } = input.analysis;
  if (guiClasses && guiMethods) {
    const context = findEnclosingGuiMethodContext({ ...input, analysis: { uri: input.analysis.uri, declarations: input.analysis.declarations, guiClasses, guiMethods },
      workspaceIndex: {
        findGuiClass: (uri, name) => input.workspaceIndex.findGuiClass?.(uri, name)
          ?? input.workspaceIndex.findVisibleGuiClasses?.(uri, name)?.[0],
        listVisibleDocuments: input.workspaceIndex.listVisibleDocuments?.bind(input.workspaceIndex)
      }
    });
    if (context) { return context.receiverTypeName; }
  }
  const owners = ownerScopes(input.analysis.declarations);
  // Preserve method precedence and the smallest-range/source-order tie rule.
  const method = findInnermostScope(owners.methods, input.position) as OwnerScope | undefined;
  if (method) { return method.declaration.containerName; }
  const type = findInnermostScope(owners.types, input.position) as OwnerScope | undefined;
  return type?.declaration.name;
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
  // Functions are visible throughout their owning scope, including calls before
  // their definition. Scope traversal still controls which declarations qualify.
  return declaration.kind === 'function' || declaration.kind === 'method'
    || declaration.uri !== sourceUri || positionBeforeOrEqual(declaration.selectionRange.start, position);
}

interface ScopeInterval {
  scope:AnalysisScope; order:number; size:number; start:AnalysisPosition; end:AnalysisPosition;
  maxEnd:AnalysisPosition; firstStart:AnalysisPosition; left?:ScopeInterval; right?:ScopeInterval;
}
const scopeIntervals=new WeakMap<AnalysisScope[],ScopeInterval|undefined>();
/** Immutable scope ranges form a balanced interval index; ties keep source-array order. */
export function findInnermostScope(scopes:AnalysisScope[],position:AnalysisPosition):AnalysisScope|undefined {
  let root=scopeIntervals.get(scopes);
  if(!scopeIntervals.has(scopes)){
    const sorted=scopes.map((scope,order)=>({scope,order,size:rangeSize(scope.range),start:scope.range.start,end:scope.range.end}))
      .sort((a,b)=>comparePositions(a.start,b.start)||a.order-b.order);
    const build=(start:number,end:number):ScopeInterval|undefined=>{
      if(start>=end)return undefined;
      const mid=(start+end)>>>1,entry=sorted[mid];
      const left=build(start,mid),right=build(mid+1,end);
      let maxEnd=entry.end;
      for(const child of [left,right])if(child&&comparePositions(child.maxEnd,maxEnd)>0)maxEnd=child.maxEnd;
      return {...entry,left,right,maxEnd,firstStart:sorted[start].start};
    };
    root=build(0,sorted.length);scopeIntervals.set(scopes,root);
  }
  let best:ScopeInterval|undefined;
  const visit=(node:ScopeInterval|undefined):void=>{
    if(!node||comparePositions(node.firstStart,position)>0||comparePositions(node.maxEnd,position)<=0)return;
    if(comparePositions(node.start,position)<=0&&comparePositions(position,node.end)<0
      &&(!best||node.size<best.size||node.size===best.size&&node.order<best.order))best=node;
    visit(node.left);visit(node.right);
  };
  visit(root);return best?.scope;
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
  return Number(!!left.startup) - Number(!!right.startup) || left.uri.localeCompare(right.uri)
    || comparePositions(left.selectionRange.start, right.selectionRange.start)
    || comparePositions(left.selectionRange.end, right.selectionRange.end);
}

export function rangeSize(range: AnalysisRange): number {
  return (range.end.line - range.start.line) * 1_000_000 + range.end.character - range.start.character;
}
