import type {
  AnalysisCompletionItem,
  AnalysisDeclaration,
  AnalyzedDocument,
  AnalysisGuiClass,
  AnalysisGuiPart,
  AnalysisPosition,
  AnalysisRange
} from '../types/analysis';
import { getBuiltinCompletions } from './builtins';
import { DIRECT_GUI_BASE_NAMES } from './guiClassKinds';
import {
  contains as sharedContains,
  declarationsInTypeHierarchy as sharedDeclarationsInTypeHierarchy,
  isTypeDeclaration as sharedIsTypeDeclaration,
  isVisibleAt as sharedIsVisibleAt,
  listVisibleDeclarations as sharedListVisibleDeclarations,
  receiverTypeName as sharedReceiverTypeName,
  resolveMemberAccessType as sharedResolveMemberAccessType,
  thisReceiverType as sharedThisReceiverType
} from './resolution';

export interface CompletionInput {
  analysis: AnalyzedDocument;
  text: string;
  position: AnalysisPosition;
  workspaceIndex: WorkspaceCompletionIndex;
}

export interface WorkspaceCompletionIndex {
  findVisibleDeclarations?(sourceUri: string, name: string): AnalysisDeclaration[];
  listVisibleDeclarations?(sourceUri: string): AnalysisDeclaration[];
  findGuiClass?(sourceUri: string, name: string): AnalysisGuiClass | undefined;
  findIncludePathCompletions?(sourceUri: string, prefix: string, includeKind: 'quote' | 'angle'): string[];
  findScriptExecutionPathCompletions?(sourceUri: string, prefix: string): string[];
}

type CompletionContext =
  | { kind: 'include'; prefix: string; includeKind: 'quote' | 'angle' }
  | { kind: 'scriptExecution'; prefix: string }
  | { kind: 'member'; receiverName: string; path: string[] }
  | { kind: 'guiReceiver'; rootName: string; path: string[] }
  | { kind: 'type' }
  | { kind: 'topLevel'; typedHash: boolean }
  | { kind: 'expression' };

const DECLARATION_KEYWORDS = [
  '#include',
  '#define',
  'class',
  'struct',
  'union',
  'enum',
  'typedef',
  'public',
  'private',
  'protected',
  'static',
  'extern',
  'global',
  'universal',
  'virtual',
  'const'
];

const EXPRESSION_KEYWORDS = [
  'if',
  'else',
  'switch',
  'case',
  'default',
  'do',
  'while',
  'for',
  'return',
  'break',
  'continue',
  'goto',
  'throw',
  'try',
  'catch',
  'sizeof',
  'new',
  'delete',
  'this',
  'TRUE',
  'FALSE',
  'NULL',
  'nullptr'
];

const BUILTIN_TYPE_NAMES = [
  'char',
  'short',
  'int',
  'int64',
  'long',
  'float',
  'double',
  'void',
  'string'
];

const COMMON_GUI_EVENTS = [
  'OnCreate'
];

const DIALOG_GUI_EVENTS = [
  'OnOK',
  'OnCancel',
  'OnApply'
];

const LIST_VIEW_GUI_EVENTS = [
  'OnChanged',
  'OnClicked',
  'OnDoubleClicked',
  'OnPressed',
  'OnReturnPressed',
  'OnSpacePressed',
  'OnCollapsed',
  'OnExpanded',
  'OnRightButtonPressed',
  'OnSelectionChanged'
];

const TABLE_VIEW_GUI_EVENTS = [
  'OnCurrentChanged',
  'OnDoubleClicked',
  'OnPressed',
  'OnSelectionChanged',
  'OnValueChanged'
];

const SLIDER_GUI_EVENTS = [
  'OnChanged',
  'OnPressed',
  'OnReleased'
];

const BUTTON_GUI_EVENTS = [
  'OnPush',
  'OnChanged',
  'OnSelected',
  'OnClicked'
];

export function getCompletions(input: CompletionInput): AnalysisCompletionItem[] {
  const context = classifyCompletionContext(input.text, input.position);

  if (context.kind === 'include') {
    return includePathCompletions(input, context);
  }

  if (context.kind === 'scriptExecution') {
    return scriptExecutionPathCompletions(input, context);
  }

  if (context.kind === 'member') {
    return memberCompletions(input, context);
  }

  if (context.kind === 'guiReceiver') {
    return guiReceiverCompletions(input, context);
  }

  const items: AnalysisCompletionItem[] = [];
  if (context.kind === 'topLevel') {
    items.push(...declarationKeywordItems(context.typedHash));
    items.push(...typeCompletionItems(input));
  }

  if (context.kind === 'expression') {
    items.push(...keywordItems(EXPRESSION_KEYWORDS));
    items.push(...getBuiltinCompletions());
    items.push(...visibleDeclarationCompletions(input, (declaration) => !isTypeDeclaration(declaration)));
    items.push(...implicitGuiContextCompletions(input));
  }

  if (context.kind === 'type') {
    items.push(...typeCompletionItems(input));
  }

  return uniqueCompletions(items);
}

function classifyCompletionContext(text: string, position: AnalysisPosition): CompletionContext {
  const offset = offsetFromPosition(text, position);
  const before = text.slice(0, offset);
  const linePrefix = before.slice(before.lastIndexOf('\n') + 1);
  const include = includeContext(linePrefix);
  if (include !== undefined) {
    return include;
  }

  const scriptExecution = scriptExecutionContext(linePrefix);
  if (scriptExecution !== undefined) {
    return scriptExecution;
  }

  const receiver = receiverContext(linePrefix);
  if (receiver !== undefined) {
    return receiver;
  }

  if (isInheritanceTypeContext(linePrefix)) {
    return { kind: 'type' };
  }

  if (isLikelyTypeContext(text, offset)) {
    return { kind: 'type' };
  }

  return isTopLevelPosition(text, offset) ? { kind: 'topLevel', typedHash: isHashOnlyLinePrefix(linePrefix) } : { kind: 'expression' };
}

function isHashOnlyLinePrefix(linePrefix: string): boolean {
  return /^\s*#$/.test(linePrefix);
}

function includeContext(linePrefix: string): CompletionContext | undefined {
  const quoted = linePrefix.match(/^\s*#\s*(?:include|using)\s+L?"([^"\n]*)$/);
  if (quoted !== null) {
    return { kind: 'include', prefix: quoted[1], includeKind: 'quote' };
  }

  const angled = linePrefix.match(/^\s*#\s*(?:include|using)\s+<([^>\n]*)$/);
  return angled === null ? undefined : { kind: 'include', prefix: angled[1], includeKind: 'angle' };
}

function receiverContext(linePrefix: string): CompletionContext | undefined {
  const match = linePrefix.match(/([A-Za-z_$][0-9A-Za-z_$]*(?:(?:::|\.|->)[A-Za-z_$][0-9A-Za-z_$]*)*)(?:::|\.|->)[A-Za-z_$0-9]*$/);
  if (match === null) {
    return undefined;
  }

  const text = match[1];
  const fullMatch = match[0];
  const parts = text.split(/::|\.|->/).filter((part) => part.length > 0);
  const rootName = parts[0];
  if (rootName === undefined) {
    return undefined;
  }

  return fullMatch.includes('::')
    ? { kind: 'guiReceiver', rootName, path: parts.slice(1) }
    : { kind: 'member', receiverName: rootName, path: parts.slice(1) };
}

function isInheritanceTypeContext(linePrefix: string): boolean {
  return /:\s*(?:(?:public|private|protected)\s*)?$/.test(linePrefix);
}

function isLikelyTypeContext(text: string, offset: number): boolean {
  const before = text.slice(0, offset);
  const after = text.slice(offset);
  const prefix = before.match(/(?:^|[;{}\n])\s*([A-Za-z_$][0-9A-Za-z_$]*\s+)*$/);
  const suffix = after.match(/^\s*[A-Za-z_$][0-9A-Za-z_$]*\s*(?:[;=({,*&[]|$)/);
  return prefix !== null && suffix !== null;
}

function isTopLevelPosition(text: string, offset: number): boolean {
  let depth = 0;
  for (const char of text.slice(0, offset)) {
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth = Math.max(0, depth - 1);
    }
  }

  return depth === 0;
}

function includePathCompletions(
  input: CompletionInput,
  context: Extract<CompletionContext, { kind: 'include' }>
): AnalysisCompletionItem[] {
  return (input.workspaceIndex.findIncludePathCompletions?.(
    input.analysis.uri,
    context.prefix,
    context.includeKind
  ) ?? [])
    .map((candidate) => includeCompletionFromPath(candidate));
}

function scriptExecutionContext(linePrefix: string): CompletionContext | undefined {
  const match = linePrefix.match(/(?:^|[;{]\s*)@([^\s;`]*)$/);
  return match === null ? undefined : { kind: 'scriptExecution', prefix: match[1] };
}

function includeCompletionFromPath(candidate: string): AnalysisCompletionItem {
  const name = includePathSegment(candidate);
  const parentPath = candidate.slice(0, candidate.length - name.length);
  return {
    name,
    kind: 'include',
    detail: parentPath.length === 0 ? 'include path' : `include path: ${parentPath}`,
    insertText: name,
    filterText: candidate,
    sortText: candidate
  };
}

function scriptExecutionPathCompletions(
  input: CompletionInput,
  context: Extract<CompletionContext, { kind: 'scriptExecution' }>
): AnalysisCompletionItem[] {
  return (input.workspaceIndex.findScriptExecutionPathCompletions?.(
    input.analysis.uri,
    context.prefix
  ) ?? [])
    .map((candidate) => scriptExecutionCompletionFromPath(candidate));
}

function scriptExecutionCompletionFromPath(candidate: string): AnalysisCompletionItem {
  const name = includePathSegment(candidate);
  const parentPath = candidate.slice(0, candidate.length - name.length);
  return {
    name,
    kind: 'function',
    detail: parentPath.length === 0 ? 'AXEL execution file' : `AXEL execution path: ${parentPath}`,
    insertText: name,
    filterText: candidate,
    sortText: candidate
  };
}

function includePathSegment(candidate: string): string {
  const trimmed = candidate.endsWith('/') ? candidate.slice(0, -1) : candidate;
  const slashIndex = trimmed.lastIndexOf('/');
  return slashIndex === -1 ? trimmed : trimmed.slice(slashIndex + 1);
}

function memberCompletions(
  input: CompletionInput,
  context: Extract<CompletionContext, { kind: 'member' }>
): AnalysisCompletionItem[] {
  const implicit = implicitGuiMemberCompletions(input, [context.receiverName, ...context.path]);
  if (implicit.length > 0) {
    return uniqueCompletions(implicit);
  }

  const rootTypeName = context.receiverName === 'this'
    ? thisReceiverType(input)
    : receiverTypeName(input, context.receiverName);
  if (rootTypeName === undefined) {
    return [];
  }

  const receiverType = resolveMemberAccessType(input, rootTypeName, context.path);
  if (receiverType === undefined) {
    return [];
  }

  const guiClass = findVisibleGuiClass(input, receiverType);
  return uniqueCompletions([
    ...typeMemberCompletions(input, receiverType),
    ...guiPartChildCompletions(guiClass?.parts ?? [])
  ]);
}

function guiReceiverCompletions(
  input: CompletionInput,
  context: Extract<CompletionContext, { kind: 'guiReceiver' }>
): AnalysisCompletionItem[] {
  const root = findVisibleGuiClass(input, context.rootName);
  if (root === undefined) {
    return staticTypeMemberCompletions(input, context);
  }

  const part = context.path.length === 0 ? undefined : resolveGuiPartPath(input, context.rootName, context.path);
  const receiverTypeName = part?.part.typeName ?? root.name;
  return uniqueCompletions([
    ...guiPartChildCompletions(part?.part.parts ?? root.parts),
    ...typeMemberCompletions(input, receiverTypeName),
    ...guiEventCompletions(root.kind === 'dialog' && context.path.length === 0 ? 'GCDialog' : receiverTypeName)
  ]);
}

function staticTypeMemberCompletions(
  input: CompletionInput,
  context: Extract<CompletionContext, { kind: 'guiReceiver' }>
): AnalysisCompletionItem[] {
  const rootTypeName = typeDeclarationName(input, context.rootName);
  if (rootTypeName === undefined) {
    return [];
  }

  const receiverType = context.path.length === 0
    ? rootTypeName
    : resolveMemberAccessType(input, rootTypeName, context.path);
  return receiverType === undefined ? [] : uniqueCompletions(typeMemberCompletions(input, receiverType));
}

function implicitGuiContextCompletions(input: CompletionInput): AnalysisCompletionItem[] {
  const context = findEnclosingGuiMethodContext(input);
  if (context === undefined) {
    return [];
  }

  const root = findVisibleGuiClass(input, context.rootClassName);
  return uniqueCompletions([
    ...visibleDeclarationCompletions(input, (declaration) => !isTypeDeclaration(declaration)),
    ...guiPartChildCompletions(root?.parts ?? []),
    ...typeMemberCompletions(input, context.rootClassName),
    ...typeMemberCompletions(input, context.receiverTypeName)
  ]);
}

function implicitGuiMemberCompletions(input: CompletionInput, path: string[]): AnalysisCompletionItem[] {
  const context = findEnclosingGuiMethodContext(input);
  if (context === undefined) {
    return [];
  }

  const part = resolveGuiPartPath(input, context.rootClassName, path);
  return part === undefined ? [] : guiReceiverCompletions(input, {
    kind: 'guiReceiver',
    rootName: context.rootClassName,
    path: part.part.path
  });
}

function typeMemberCompletions(input: CompletionInput, typeName: string): AnalysisCompletionItem[] {
  return declarationsInTypeHierarchy(input, typeName)
    .map((declaration) => ({
      name: declaration.name,
      kind: declaration.kind === 'function' ? 'method' : 'property',
      detail: memberDetail(declaration)
    }));
}

function declarationsInTypeHierarchy(input: CompletionInput, typeName: string): AnalysisDeclaration[] {
  return sharedDeclarationsInTypeHierarchy(input, typeName);
}

function resolveMemberAccessType(input: CompletionInput, rootTypeName: string, path: string[]): string | undefined {
  return sharedResolveMemberAccessType(input, rootTypeName, path);
}

function receiverTypeName(input: CompletionInput, receiverName: string): string | undefined {
  return sharedReceiverTypeName(input, receiverName);
}

function thisReceiverType(input: CompletionInput): string | undefined {
  return sharedThisReceiverType(input);
}

function visibleDeclarationCompletions(
  input: CompletionInput,
  predicate: (declaration: AnalysisDeclaration) => boolean
): AnalysisCompletionItem[] {
  return listVisibleDeclarations(input)
    .filter(predicate)
    .filter((declaration) => isVisibleAt(declaration, input.position, input.analysis.uri))
    .map(completionFromDeclaration);
}

function completionFromDeclaration(declaration: AnalysisDeclaration): AnalysisCompletionItem {
  return {
    name: declaration.name,
    kind: completionKindForDeclaration(declaration),
    detail: declaration.detail
  };
}

function completionKindForDeclaration(declaration: AnalysisDeclaration): AnalysisCompletionItem['kind'] {
  if (declaration.kind === 'function') {
    return declaration.containerName === undefined ? 'function' : 'method';
  }

  if (declaration.kind === 'method') {
    return 'method';
  }

  if (declaration.kind === 'field') {
    return 'property';
  }

  if (declaration.kind === 'variable' || declaration.kind === 'parameter') {
    return declaration.containerName === undefined ? 'variable' : 'property';
  }

  return declaration.kind;
}

function guiPartChildCompletions(parts: AnalysisGuiPart[]): AnalysisCompletionItem[] {
  return flattenNamedParts(parts)
    .map((part) => ({
      name: part.name,
      kind: 'property',
      detail: `${part.typeName} ${part.path.join('.')}`
    }));
}

function flattenNamedParts(parts: AnalysisGuiPart[]): (AnalysisGuiPart & { name: string })[] {
  return parts.flatMap((part) => [
    ...(part.name === undefined ? [] : [{ ...part, name: part.name }]),
    ...flattenNamedParts(part.parts)
  ]);
}

function guiEventCompletions(typeName: string): AnalysisCompletionItem[] {
  const names = new Set(COMMON_GUI_EVENTS);
  if (typeName.includes('Dialog')) {
    for (const name of DIALOG_GUI_EVENTS) {
      names.add(name);
    }
  }

  addMatchingEvents(names, typeName, /ListView/, LIST_VIEW_GUI_EVENTS);
  addMatchingEvents(names, typeName, /TableView/, TABLE_VIEW_GUI_EVENTS);
  addMatchingEvents(names, typeName, /Slider/, SLIDER_GUI_EVENTS);
  addMatchingEvents(names, typeName, /Button|CheckBox|ComboBox|ListBox|ControlButton|ButtonGroup/, BUTTON_GUI_EVENTS);

  return Array.from(names).sort().map((name) => ({
    name,
    kind: 'event',
    detail: 'GUI event handler'
  }));
}

function addMatchingEvents(names: Set<string>, typeName: string, pattern: RegExp, events: readonly string[]): void {
  if (!pattern.test(typeName)) {
    return;
  }

  for (const event of events) {
    names.add(event);
  }
}

function listVisibleDeclarations(input: CompletionInput): AnalysisDeclaration[] {
  return sharedListVisibleDeclarations(input);
}

interface GuiMethodContext {
  rootClassName: string;
  receiverTypeName: string;
}

function findEnclosingGuiMethodContext(input: CompletionInput): GuiMethodContext | undefined {
  for (const guiClass of input.analysis.guiClasses) {
    const classMethod = guiClass.methods.find((method) => contains(method.range, input.position));
    if (classMethod !== undefined) {
      return { rootClassName: guiClass.name, receiverTypeName: guiClass.name };
    }

    const partMethod = findEnclosingGuiPartMethod(guiClass.parts, input.position);
    if (partMethod !== undefined) {
      return { rootClassName: guiClass.name, receiverTypeName: partMethod.typeName };
    }
  }

  for (const method of input.analysis.guiMethods) {
    if (!contains(method.range, input.position)) {
      continue;
    }

    const rootClassName = method.receiverPath[0];
    if (rootClassName === undefined) {
      continue;
    }

    const partPath = method.receiverPath.slice(1, -1);
    const part = resolveGuiPartPath(input, rootClassName, partPath);
    return {
      rootClassName,
      receiverTypeName: part?.part.typeName ?? rootClassName
    };
  }

  return undefined;
}

function findEnclosingGuiPartMethod(parts: AnalysisGuiPart[], position: AnalysisPosition): AnalysisGuiPart | undefined {
  for (const part of parts) {
    if (part.methods.some((method) => contains(method.range, position))) {
      return part;
    }

    const child = findEnclosingGuiPartMethod(part.parts, position);
    if (child !== undefined) {
      return child;
    }
  }

  return undefined;
}

interface ResolvedGuiPart {
  ownerName: string;
  part: AnalysisGuiPart;
}

function resolveGuiPartPath(input: CompletionInput, rootClassName: string, path: string[]): ResolvedGuiPart | undefined {
  let owner = findVisibleGuiClass(input, rootClassName);
  let ownerPath: string[] = [];
  let resolved: ResolvedGuiPart | undefined;
  const rootOwner = owner;
  if (rootOwner !== undefined) {
    const directPart = findPartByPath(rootOwner.parts, path);
    if (directPart !== undefined) {
      return { ownerName: rootOwner.name, part: directPart };
    }
  }

  for (const segment of path) {
    if (owner === undefined) {
      return undefined;
    }

    const nextPath = [...ownerPath, segment];
    const part = findPartByPath(owner.parts, nextPath) ?? findPartByPath(owner.parts, [segment]);
    if (part === undefined) {
      return undefined;
    }

    resolved = { ownerName: owner.name, part };
    const partClass = findVisibleGuiClass(input, part.typeName);
    owner = partClass ?? owner;
    ownerPath = partClass === undefined ? nextPath : [];
  }

  return resolved;
}

function findVisibleGuiClass(input: CompletionInput, name: string): AnalysisGuiClass | undefined {
  return input.analysis.guiClasses.find((guiClass) => guiClass.name === name)
    ?? input.workspaceIndex.findGuiClass?.(input.analysis.uri, name);
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

function keywordItems(names: readonly string[]): AnalysisCompletionItem[] {
  return names.map((name) => ({ name, kind: 'keyword' }));
}

function declarationKeywordItems(typedHash: boolean): AnalysisCompletionItem[] {
  return DECLARATION_KEYWORDS.map((name) => ({
    name,
    kind: 'keyword',
    insertText: typedHash && name.startsWith('#') ? name.slice(1) : undefined
  }));
}

function typeCompletionItems(input: CompletionInput): AnalysisCompletionItem[] {
  return [
    ...keywordItems(BUILTIN_TYPE_NAMES),
    ...DIRECT_GUI_BASE_NAMES.map((name) => ({ name, kind: 'class' as const, detail: 'GUI base class' })),
    ...visibleDeclarationCompletions(input, isTypeDeclaration)
  ];
}

function uniqueCompletions(items: AnalysisCompletionItem[]): AnalysisCompletionItem[] {
  const uniqueItems = new Map<string, AnalysisCompletionItem>();
  for (const item of items) {
    const existing = uniqueItems.get(item.name);
    if (existing === undefined || completionPriority(item) > completionPriority(existing)) {
      uniqueItems.set(item.name, item);
    }
  }

  return Array.from(uniqueItems.values())
    .sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
}

function completionPriority(item: AnalysisCompletionItem): number {
  if (isTypeCompletionKind(item.kind)) {
    return 2;
  }

  return item.kind === 'keyword' ? 0 : 1;
}

function isTypeCompletionKind(kind: AnalysisCompletionItem['kind']): boolean {
  return kind === 'class'
    || kind === 'struct'
    || kind === 'union'
    || kind === 'enum'
    || kind === 'typedef';
}

function isTypeDeclaration(declaration: AnalysisDeclaration): boolean {
  return sharedIsTypeDeclaration(declaration);
}

function typeDeclarationName(input: CompletionInput, name: string): string | undefined {
  return listVisibleDeclarations(input)
    .filter((declaration) => declaration.name === name)
    .find(isTypeDeclaration)
    ?.name;
}

function isVisibleAt(declaration: AnalysisDeclaration, position: AnalysisPosition, sourceUri: string): boolean {
  return sharedIsVisibleAt(declaration, position, sourceUri);
}

function memberDetail(declaration: AnalysisDeclaration): string {
  if (declaration.containerName === undefined || declaration.detail.includes('::')) {
    return declaration.detail;
  }

  return declaration.detail.replace(declaration.name, `${declaration.containerName}::${declaration.name}`);
}

function offsetFromPosition(text: string, position: AnalysisPosition): number {
  const lines = text.split('\n');
  return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
}

function contains(range: AnalysisRange, position: AnalysisPosition): boolean {
  return sharedContains(range, position);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
