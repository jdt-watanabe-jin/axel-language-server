import type * as Parser from 'tree-sitter';
import type { AnalysisGuiClass, AnalysisGuiMethod, AnalysisGuiPart, AnalysisSymbol, AnalysisSymbolKind } from '../types/analysis';
import { isDeclarationNodeType, isIncludeNodeType, isTypeSpecifierNodeType } from './nodeKinds';
import { getDeclaratorName, nodeToAnalysisRange } from './syntaxTree';

export interface CollectDocumentSymbolsOptions {
  guiClasses?: readonly AnalysisGuiClass[];
  guiMethods?: readonly AnalysisGuiMethod[];
}

export function collectDocumentSymbols(
  rootNode: Parser.SyntaxNode,
  options: CollectDocumentSymbolsOptions = {}
): AnalysisSymbol[] {
  const symbols: AnalysisSymbol[] = [];
  const nestedGuiMethods = nestableGuiMethods(options);

  for (const child of rootNode.namedChildren) {
    symbols.push(...symbolsFromNode(child, { nestedGuiMethods }));
  }

  return attachGuiSymbols(symbols, options);
}

interface SymbolContext {
  nestedGuiMethods: ReadonlySet<string>;
  containerKind?: AnalysisSymbolKind;
}

function symbolFromNode(node: Parser.SyntaxNode, context: SymbolContext): AnalysisSymbol | null {
  if (isIncludeNodeType(node.type)) {
    return includeSymbolFromNode(node);
  }

  const macroSymbol = macroSymbolFromNode(node);
  if (macroSymbol !== null) {
    return macroSymbol;
  }

  if (isDeclarationNodeType(node.type)) {
    return declarationSymbolFromNode(node, context);
  }

  if (isTypeSpecifierNodeType(node.type)) {
    return typeSymbolFromNode(node, context);
  }

  return null;
}

function symbolsFromNode(node: Parser.SyntaxNode, context: SymbolContext): AnalysisSymbol[] {
  const anonymousEnumMembers = anonymousEnumMemberSymbolsFromFieldDeclaration(node);
  if (anonymousEnumMembers !== undefined) {
    return anonymousEnumMembers;
  }

  const symbol = symbolFromNode(node, context);
  if (symbol !== null) {
    return [symbol];
  }

  if (!isTransparentSymbolContainer(node)) {
    return [];
  }

  return node.namedChildren.flatMap((child) => symbolsFromNode(child, context));
}

function anonymousEnumMemberSymbolsFromFieldDeclaration(node: Parser.SyntaxNode): AnalysisSymbol[] | undefined {
  if (node.type !== 'field_declaration') {
    return undefined;
  }

  const typeNode = node.childForFieldName('type');
  if (typeNode?.type !== 'enum_specifier' || typeNode.childForFieldName('name') !== null) {
    return undefined;
  }

  return enumMemberSymbolsFromNode(typeNode, '');
}

function isTransparentSymbolContainer(node: Parser.SyntaxNode): boolean {
  return node.type === 'preproc_if'
    || node.type === 'preproc_ifdef'
    || node.type === 'preproc_else'
    || node.type === 'preproc_elif';
}

function includeSymbolFromNode(node: Parser.SyntaxNode): AnalysisSymbol | null {
  const pathNode = node.childForFieldName('path');
  if (pathNode === null) {
    return null;
  }

  return {
    name: includePathName(pathNode.text),
    kind: 'include',
    detail: normalizeSymbolText(node.text),
    range: nodeToAnalysisRange(node),
    selectionRange: nodeToAnalysisRange(pathNode)
  };
}

function macroSymbolFromNode(node: Parser.SyntaxNode): AnalysisSymbol | null {
  if (node.type !== 'preproc_def' && node.type !== 'preproc_function_def') {
    return null;
  }

  const nameNode = node.childForFieldName('name');
  if (nameNode === null) {
    return null;
  }

  return {
    name: nameNode.text,
    kind: 'macro',
    detail: normalizeSymbolText(node.text),
    range: nodeToAnalysisRange(node),
    selectionRange: nodeToAnalysisRange(nameNode)
  };
}

function declarationSymbolFromNode(node: Parser.SyntaxNode, context: SymbolContext): AnalysisSymbol | null {
  if (node.type === 'function_definition' && context.nestedGuiMethods.has(rangeKey(nodeToAnalysisRange(node)))) {
    return null;
  }

  const nameNode = getDeclaratorName(node);
  if (nameNode === null) {
    return null;
  }

  const kind = declarationKind(node.type, nameNode.text, context.containerKind, node);
  return {
    name: nameNode.text,
    kind,
    detail: kind,
    range: nodeToAnalysisRange(node),
    selectionRange: nodeToAnalysisRange(nameNode)
  };
}

function typeSymbolFromNode(node: Parser.SyntaxNode, context: SymbolContext): AnalysisSymbol | null {
  const nameNode = node.childForFieldName('name');
  if (nameNode === null) {
    return null;
  }

  const kind = typeKind(node.type);
  const children = childSymbolsFromTypeNode(node, kind, context);
  return {
    name: nameNode.text,
    kind,
    detail: kind,
    range: nodeToAnalysisRange(node),
    selectionRange: nodeToAnalysisRange(nameNode),
    ...(children.length === 0 ? {} : { children })
  };
}

function childSymbolsFromTypeNode(
  node: Parser.SyntaxNode,
  kind: AnalysisSymbolKind,
  context: SymbolContext
): AnalysisSymbol[] {
  if (node.type === 'enum_specifier') {
    return enumMemberSymbolsFromNode(node, node.childForFieldName('name')?.text ?? '');
  }

  if (!['class', 'struct', 'union'].includes(kind)) {
    return [];
  }

  const bodyNode = node.childForFieldName('body');
  if (bodyNode === null) {
    return [];
  }

  return bodyNode.namedChildren.flatMap((child) => symbolsFromNode(child, { ...context, containerKind: kind }));
}

function enumMemberSymbolsFromNode(enumNode: Parser.SyntaxNode, enumName: string): AnalysisSymbol[] {
  const bodyNode = enumNode.childForFieldName('body');
  if (bodyNode === null) {
    return [];
  }

  return bodyNode.namedChildren
    .filter((child) => child.type === 'enumerator')
    .flatMap((enumerator) => enumMemberSymbolFromNode(enumerator, enumName));
}

function enumMemberSymbolFromNode(enumerator: Parser.SyntaxNode, enumName: string): AnalysisSymbol[] {
  const nameNode = enumerator.childForFieldName('name');
  if (nameNode === null) {
    return [];
  }

  const valueNode = enumerator.childForFieldName('value');
  const valueText = valueNode === null ? '' : ` = ${normalizeSymbolText(valueNode.text)}`;
  return [{
    name: nameNode.text,
    kind: 'enumMember',
    detail: `enum ${enumName}::${nameNode.text}${valueText}`,
    range: nodeToAnalysisRange(enumerator),
    selectionRange: nodeToAnalysisRange(nameNode)
  }];
}

function declarationKind(
  type: string,
  name: string,
  containerKind?: AnalysisSymbolKind,
  node?: Parser.SyntaxNode
): AnalysisSymbolKind {
  if (type === 'function_definition') {
    if (isOperatorName(name)) {
      return 'operator';
    }

    return containerKind === undefined ? 'function' : 'method';
  }

  if (
    (type === 'object_definition' || type === 'field_declaration')
    && node !== undefined
    && (containsFunctionDeclarator(node) || containsOperatorDeclarator(node))
  ) {
    if (isOperatorName(name)) {
      return 'operator';
    }

    return containerKind === undefined ? 'function' : 'method';
  }

  if (type === 'type_definition') {
    return 'typedef';
  }

  return containerKind === undefined ? 'variable' : 'field';
}

function containsFunctionDeclarator(node: Parser.SyntaxNode): boolean {
  return node.type === 'function_declarator'
    || node.namedChildren.some(containsFunctionDeclarator);
}

function containsOperatorDeclarator(node: Parser.SyntaxNode): boolean {
  return node.type === 'operator_declarator'
    || node.namedChildren.some(containsOperatorDeclarator);
}

function isOperatorName(name: string): boolean {
  return name.startsWith('operator');
}

function typeKind(type: string): AnalysisSymbolKind {
  if (type === 'struct_specifier') {
    return 'struct';
  }

  if (type === 'union_specifier') {
    return 'union';
  }

  if (type === 'enum_specifier') {
    return 'enum';
  }

  return 'class';
}

function normalizeSymbolText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function includePathName(text: string): string {
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('<') && text.endsWith('>'))) {
    return text.slice(1, -1);
  }

  return text;
}

function attachGuiSymbols(
  symbols: AnalysisSymbol[],
  options: CollectDocumentSymbolsOptions
): AnalysisSymbol[] {
  if (options.guiClasses === undefined || options.guiClasses.length === 0) {
    return symbols;
  }

  const externalMethods = uniqueGuiMethods(options.guiMethods ?? []);
  for (const guiClass of options.guiClasses) {
    const classSymbol = symbols.find((symbol) => (
      symbol.kind === 'class'
      && symbol.name === guiClass.name
      && rangeKey(symbol.range) === rangeKey(guiClass.range)
    ));
    if (classSymbol === undefined) {
      continue;
    }

    const syntaxChildren = (classSymbol.children ?? []).filter((child) => !isGuiPartChild(child, guiClass.parts));
    classSymbol.detail = `class ${guiClass.name} : public ${guiClass.baseName}`;
    classSymbol.children = sortSymbols([
      ...syntaxChildren,
      ...visibleGuiPartSymbols(guiClass, guiClass.parts, externalMethods),
      ...classGuiMethodSymbols(guiClass, externalMethods)
    ]);
  }

  return symbols;
}

function visibleGuiPartSymbols(
  guiClass: AnalysisGuiClass,
  parts: readonly AnalysisGuiPart[],
  externalMethods: readonly AnalysisGuiMethod[]
): AnalysisSymbol[] {
  return parts.flatMap((part) => {
    if (part.anonymous || part.name === undefined) {
      return visibleGuiPartSymbols(guiClass, part.parts, externalMethods);
    }

    const childSymbols = sortSymbols([
      ...visibleGuiPartSymbols(guiClass, part.parts, externalMethods),
      ...part.methods.map((method) => guiMethodSymbol(method)),
      ...externalPartMethodSymbols(guiClass, part, externalMethods)
    ]);

    return [{
      name: part.name,
      kind: 'field',
      detail: `${part.typeName} ${guiClass.name}::${part.path.join('.')}`,
      range: part.range,
      selectionRange: part.selectionRange ?? part.range,
      ...(childSymbols.length === 0 ? {} : { children: childSymbols })
    }];
  });
}

function classGuiMethodSymbols(
  guiClass: AnalysisGuiClass,
  externalMethods: readonly AnalysisGuiMethod[]
): AnalysisSymbol[] {
  return uniqueGuiMethods([
    ...guiClass.methods.filter((method) => isClassMethod(guiClass, method)),
    ...externalMethods.filter((method) => isClassMethod(guiClass, method))
  ]).map((method) => guiMethodSymbol(method));
}

function externalPartMethodSymbols(
  guiClass: AnalysisGuiClass,
  part: AnalysisGuiPart,
  externalMethods: readonly AnalysisGuiMethod[]
): AnalysisSymbol[] {
  return uniqueGuiMethods([
    ...guiClass.methods,
    ...externalMethods
  ]).filter((method) => isPartMethod(guiClass, part, method)).map((method) => guiMethodSymbol(method));
}

function guiMethodSymbol(method: AnalysisGuiMethod): AnalysisSymbol {
  return {
    name: method.name,
    kind: 'method',
    detail: `void ${method.receiverPath.join('::')}()`,
    range: method.range,
    selectionRange: method.selectionRange ?? method.range
  };
}

function isClassMethod(guiClass: AnalysisGuiClass, method: AnalysisGuiMethod): boolean {
  return method.receiverPath.length === 2
    && method.receiverPath[0] === guiClass.name
    && method.receiverPath[1] === method.name;
}

function isPartMethod(guiClass: AnalysisGuiClass, part: AnalysisGuiPart, method: AnalysisGuiMethod): boolean {
  return method.receiverPath.length === part.path.length + 2
    && method.receiverPath[0] === guiClass.name
    && method.receiverPath[method.receiverPath.length - 1] === method.name
    && samePath(method.receiverPath.slice(1, -1), part.path);
}

function isGuiPartChild(symbol: AnalysisSymbol, parts: readonly AnalysisGuiPart[]): boolean {
  return visibleGuiPartNames(parts).has(symbol.name);
}

function visibleGuiPartNames(parts: readonly AnalysisGuiPart[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const part of parts) {
    if (part.name !== undefined) {
      names.add(part.name);
    }

    for (const childName of visibleGuiPartNames(part.parts)) {
      names.add(childName);
    }
  }

  return names;
}

function nestableGuiMethods(options: CollectDocumentSymbolsOptions): ReadonlySet<string> {
  const ranges = new Set<string>();
  for (const guiClass of options.guiClasses ?? []) {
    for (const method of uniqueGuiMethods([...(options.guiMethods ?? []), ...guiClass.methods])) {
      if (canNestGuiMethod(guiClass, method)) {
        ranges.add(rangeKey(method.range));
      }
    }
  }

  return ranges;
}

function canNestGuiMethod(guiClass: AnalysisGuiClass, method: AnalysisGuiMethod): boolean {
  if (isClassMethod(guiClass, method)) {
    return true;
  }

  return findGuiPart(guiClass.parts, (part) => isPartMethod(guiClass, part, method)) !== undefined;
}

function findGuiPart(
  parts: readonly AnalysisGuiPart[],
  predicate: (part: AnalysisGuiPart) => boolean
): AnalysisGuiPart | undefined {
  for (const part of parts) {
    if (predicate(part)) {
      return part;
    }

    const found = findGuiPart(part.parts, predicate);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function uniqueGuiMethods(methods: readonly AnalysisGuiMethod[]): AnalysisGuiMethod[] {
  const seen = new Set<string>();
  const results: AnalysisGuiMethod[] = [];
  for (const method of methods) {
    const key = `${rangeKey(method.range)}:${method.receiverPath.join('\u0000')}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(method);
  }

  return results;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function sortSymbols(symbols: readonly AnalysisSymbol[]): AnalysisSymbol[] {
  return [...symbols].sort((left, right) => (
    left.range.start.line - right.range.start.line
    || left.range.start.character - right.range.start.character
    || left.range.end.line - right.range.end.line
    || left.range.end.character - right.range.end.character
  ));
}

function rangeKey(range: ReturnType<typeof nodeToAnalysisRange>): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}
