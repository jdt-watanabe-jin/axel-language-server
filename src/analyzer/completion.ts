import { declarationOrigin } from './declarationOrigin';
import { containsSourcePosition, describeSystemMacro, resolveSystemMacro, systemMacroNames } from './systemMacros';
import { translate } from '../i18n/messages';
import type {
  AnalysisCompletionItem,
  AnalysisDeclaration,
  AnalyzedDocument,
  AnalysisGuiClass,
  AnalysisGuiPart,
  AnalysisPosition
} from '../types/analysis';
import { DIRECT_GUI_BASE_NAMES } from './guiClassKinds';
import {
  contains,
  declarationsInTypeHierarchy as sharedDeclarationsInTypeHierarchy,
  isTypeDeclaration as sharedIsTypeDeclaration,
  isVisibleAt as sharedIsVisibleAt,
  listVisibleDeclarations as sharedListVisibleDeclarations,
  receiverTypeName as sharedReceiverTypeName,
  resolveMemberAccessType as sharedResolveMemberAccessType,
  thisReceiverType as sharedThisReceiverType
} from './resolution';
import {
  findEnclosingGuiMethodContext,
  findVisibleGuiClassEntry,
  resolveGuiPartPath
} from './guiResolution';

export interface CompletionInput {
  locale?: string;
  analysis: AnalyzedDocument;
  text: string;
  position: AnalysisPosition;
  workspaceIndex: WorkspaceCompletionIndex;
}

export interface WorkspaceCompletionIndex {
  listVisibleDocuments?(sourceUri: string): AnalyzedDocument[];
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
  if ((context.kind === 'expression' || context.kind === 'topLevel')
    && !(input.analysis.completionExcludedRanges ?? []).some(range => containsSourcePosition(range, input.position))) {
    for (const name of systemMacroNames(input.analysis.tool)) {
      const macro = resolveSystemMacro(name, input.analysis.uri, input.position, input.analysis.tool, input.analysis.targetPlatform, input.analysis.internalFeatures)!;
      items.push({ name, kind: 'macro', detail: describeSystemMacro(macro, input.locale) });
    }
  }
  if (context.kind === 'topLevel') {
    items.push(...declarationKeywordItems(context.typedHash));
    items.push(...typeCompletionItems(input));
  }

  if (context.kind === 'expression') {
    items.push(...typeCompletionItems(input));
    items.push(...keywordItems(EXPRESSION_KEYWORDS));
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
    .map((candidate) => includeCompletionFromPath(candidate, input.locale));
}

function scriptExecutionContext(linePrefix: string): CompletionContext | undefined {
  const match = linePrefix.match(/(?:^|[;{])\s*@([^\s;`"']*)$/);
  return match === null ? undefined : { kind: 'scriptExecution', prefix: match[1] };
}

function includeCompletionFromPath(candidate: string, locale?: string): AnalysisCompletionItem {
  const name = includePathSegment(candidate);
  const parentPath = candidate.slice(0, candidate.length - name.length);
  return {
    name,
    kind: 'include',
    detail: parentPath.length === 0 ? translate(locale, 'include path') : translate(locale, 'include path: {0}', parentPath),
    insertText: name,
    filterText: candidate,
    sortText: candidate
  };
}

function scriptExecutionPathCompletions(
  input: CompletionInput,
  context: Extract<CompletionContext, { kind: 'scriptExecution' }>
): AnalysisCompletionItem[] {
  const segmentStart = Math.max(context.prefix.lastIndexOf('/'), context.prefix.lastIndexOf('\\')) + 1;
  const offset = offsetFromPosition(input.text, input.position);
  const suffixLength = input.text.slice(offset).match(/^[^/\\\s;`"']*/)?.[0].length ?? 0;
  const nextCharacter = input.text[offset + suffixLength];
  const hasSeparator = nextCharacter === '/' || nextCharacter === '\\';
  return (input.workspaceIndex.findScriptExecutionPathCompletions?.(
    input.analysis.uri,
    context.prefix
  ) ?? [])
    .map((candidate, index) => {
      const name = includePathSegment(candidate);
      const isFolder = candidate.endsWith('/');
      const parentPath = candidate.slice(0, candidate.length - name.length - (isFolder ? 1 : 0));
      const insertText = isFolder ? `${name}/` : name;
      return {
        name,
        kind: isFolder ? 'folder' : 'function',
        detail: parentPath.length === 0 ? translate(input.locale, 'AXEL execution file') : translate(input.locale, 'AXEL execution path: {0}', parentPath),
        insertText,
        filterText: name,
        sortText: String(index).padStart(10, '0'),
        textEdit: {
          range: {
            start: { line: input.position.line, character: input.position.character - context.prefix.length + segmentStart },
            end: { line: input.position.line, character: input.position.character + suffixLength + (isFolder && hasSeparator ? 1 : 0) }
          },
          newText: insertText
        }
      };
    });
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

  const entry = findVisibleGuiClassEntry(input, receiverType);
  return uniqueCompletions([
    ...typeMemberCompletions(input, receiverType),
    ...guiPartChildCompletions(input, entry?.guiClass.parts ?? [], entry?.uri)
  ]);
}

function guiReceiverCompletions(
  input: CompletionInput,
  context: Extract<CompletionContext, { kind: 'guiReceiver' }>
): AnalysisCompletionItem[] {
  const entry = findVisibleGuiClassEntry(input, context.rootName);
  const root = entry?.guiClass;
  if (root === undefined) {
    return staticTypeMemberCompletions(input, context);
  }

  const part = context.path.length === 0 ? undefined : resolveGuiPartPath(input, context.rootName, context.path);
  const receiverTypeName = part?.part.typeName ?? root.name;
  return uniqueCompletions([
    ...guiPartChildCompletions(input, part?.part.parts ?? root.parts, part?.ownerUri ?? entry?.uri),
    ...typeMemberCompletions(input, receiverTypeName),
    ...guiEventCompletions(root.kind === 'dialog' && context.path.length === 0 ? 'GCDialog' : receiverTypeName, input.locale)
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

  const entry = findVisibleGuiClassEntry(input, context.rootClassName);
  return uniqueCompletions([
    ...visibleDeclarationCompletions(input, (declaration) => !isTypeDeclaration(declaration)),
    ...guiPartChildCompletions(input, entry?.guiClass.parts ?? [], entry?.uri),
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
    .filter((declaration) => declaration.kind !== 'parameter')
    .map((declaration) => ({
      name: declaration.name,
      kind: declaration.kind === 'function' ? 'method' : 'property',
      detail: memberDetail(declaration),
      ...completionDocumentation(input, declaration)
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
  const visibleIds = lexicallyVisibleDeclarationIds(input);
  const receiverType = thisReceiverType(input);
  const memberIds = new Set<string>();
  if (receiverType !== undefined) {
    for (const declaration of declarationsInTypeHierarchy(input, receiverType)) {
      if (declaration.kind !== 'parameter') {
        visibleIds.add(declaration.id);
        memberIds.add(declaration.id);
      }
    }
  }
  const declarations = listVisibleDeclarations(input);
  const typeNames = new Set(declarations.filter(isTypeDeclaration).map((declaration) => declaration.name));
  const enclosingScopeIds = new Set(input.analysis.scopes
    .filter((scope) => scope.parentId !== undefined && contains(scope.range, input.position))
    .flatMap((scope) => scope.declarationIds));
  const memberOwnerNames = new Set(declarations
    .filter((declaration) => ['class', 'struct', 'union'].includes(declaration.kind))
    .map((declaration) => declaration.name));
  return declarations
    .filter((declaration) => visibleIds.has(declaration.id))
    .filter((declaration) => enclosingScopeIds.has(declaration.id)
      || !memberOwnerNames.has(declaration.containerName ?? '')
      || memberIds.has(declaration.id))
    .filter(predicate)
    .filter((declaration) => isVisibleAt(declaration, input.position, input.analysis.uri))
    .map((declaration) => completionFromDeclaration(input, declaration, typeNames));
}

function lexicallyVisibleDeclarationIds(input: CompletionInput): Set<string> {
  const documents = new Map((input.workspaceIndex.listVisibleDocuments?.(input.analysis.uri) ?? [])
    .map((document) => [document.uri, document]));
  documents.set(input.analysis.uri, input.analysis);
  const ids = new Set<string>();
  for (const document of documents.values()) {
    for (const scope of document.scopes) {
      if (scope.parentId === undefined
        || (document.uri === input.analysis.uri && contains(scope.range, input.position))) {
        for (const id of scope.declarationIds) {
          ids.add(id);
        }
      }
    }
  }
  return ids;
}

function completionFromDeclaration(
  input: CompletionInput,
  declaration: AnalysisDeclaration,
  typeNames: ReadonlySet<string>
): AnalysisCompletionItem {
  return {
    name: declaration.name,
    kind: completionKindForDeclaration(declaration),
    detail: declaration.kind !== 'parameter' && typeNames.has(declaration.containerName ?? '')
      ? memberDetail(declaration)
      : declaration.detail,
    ...completionDocumentation(input, declaration)
  };
}

function completionDocumentation(
  input: CompletionInput,
  declaration: AnalysisDeclaration
): Pick<AnalysisCompletionItem, 'documentation'> {
  const origin = declarationOrigin(input.analysis.uri, declaration.uri, input.locale);
  const documentation = [declaration.documentation, origin].filter((text) => text !== undefined).join('\n\n');
  return documentation.length === 0 ? {} : { documentation };
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

function guiPartChildCompletions(
  input: CompletionInput,
  parts: AnalysisGuiPart[],
  ownerUri: string | undefined
): AnalysisCompletionItem[] {
  const origin = declarationOrigin(input.analysis.uri, ownerUri, input.locale);
  return flattenNamedParts(parts)
    .map((part) => ({
      name: part.name,
      kind: 'property',
      detail: `${part.typeName} ${part.path.join('.')}`,
      ...(origin === undefined ? {} : { documentation: origin })
    }));
}

function flattenNamedParts(parts: AnalysisGuiPart[]): (AnalysisGuiPart & { name: string })[] {
  return parts.flatMap((part) => [
    ...(part.name === undefined ? [] : [{ ...part, name: part.name }]),
    ...flattenNamedParts(part.parts)
  ]);
}

function guiEventCompletions(typeName: string, locale?: string): AnalysisCompletionItem[] {
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
    detail: translate(locale, 'GUI event handler')
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
    ...DIRECT_GUI_BASE_NAMES.map((name) => ({ name, kind: 'class' as const, detail: translate(input.locale, 'GUI base class') })),
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
