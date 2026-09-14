import type * as Parser from 'tree-sitter';
import type {
  AnalysisDocumentUri,
  AnalysisGuiClass,
  AnalysisGuiClassKind,
  AnalysisGuiMethod,
  AnalysisGuiPart
} from '../types/analysis';
import { classifyDirectGuiBase, isGuiPartTypeName } from './guiClassKinds';
import { getDeclaratorName, nodeToAnalysisRange } from './syntaxTree';

type KnownGuiClasses = ReadonlySet<string> | ReadonlyMap<string, AnalysisGuiClassKind>;

export function buildGuiIndex(
  rootNode: Parser.SyntaxNode,
  _uri: AnalysisDocumentUri,
  knownGuiClasses: KnownGuiClasses = new Set<string>()
): AnalysisGuiClass[] {
  const classNodes = rootNode.descendantsOfType('class_specifier');
  const resolvedGuiClasses = resolveKnownGuiClasses(classNodes, knownGuiClassMap(knownGuiClasses));
  const classes = collectGuiClasses(classNodes, resolvedGuiClasses);
  const classByName = new Map(classes.map((guiClass) => [guiClass.name, guiClass]));

  for (const method of collectExternalGuiMethods(rootNode)) {
    const rootClass = method.receiverPath[0];
    const guiClass = rootClass === undefined ? undefined : classByName.get(rootClass);
    guiClass?.methods.push(method);
  }

  return classes;
}

function resolveKnownGuiClasses(
  classNodes: Parser.SyntaxNode[],
  initialClasses: ReadonlyMap<string, AnalysisGuiClassKind>
): ReadonlyMap<string, AnalysisGuiClassKind> {
  const classesByName = new Map(initialClasses);
  const bases = classNodes.flatMap(node => {
    const name = node.childForFieldName('name')?.text;
    const baseName = baseNameFromClassSpecifier(node);
    return name !== undefined && baseName !== undefined ? [{name,baseName}] : [];
  });
  let previousSize = -1;
  while (classesByName.size !== previousSize) {
    previousSize = classesByName.size;
    // Resolve each pass before adding names to preserve duplicate-name precedence.
    const resolved = bases.map(({name,baseName}) => ({name,kind:classifyGuiClassKind(baseName,classesByName)}));
    for (const {name,kind} of resolved) {
      if (kind !== undefined && !classesByName.has(name)) { classesByName.set(name,kind); }
    }
  }
  return classesByName;
}

function collectGuiClasses(
  classNodes: Parser.SyntaxNode[],
  knownGuiClasses: ReadonlyMap<string, AnalysisGuiClassKind>
): AnalysisGuiClass[] {
  return classNodes.flatMap(node => {
    const guiClass = guiClassFromNode(node,knownGuiClasses);
    return guiClass ? [guiClass] : [];
  });
}

function guiClassFromNode(
  node: Parser.SyntaxNode,
  knownGuiClasses: ReadonlyMap<string, AnalysisGuiClassKind>
): AnalysisGuiClass | undefined {
  const nameNode = node.childForFieldName('name');
  const baseName = baseNameFromClassSpecifier(node);
  if (nameNode === null || baseName === undefined) {
    return undefined;
  }

  const kind = classifyGuiClassKind(baseName, knownGuiClasses);
  if (kind === undefined) {
    return undefined;
  }

  const bodyNode = node.childForFieldName('body');
  return {
    name: nameNode.text,
    baseName,
    kind,
    range: nodeToAnalysisRange(node),
    parts: bodyNode === null ? [] : collectGuiParts(bodyNode, [], knownGuiClasses),
    methods: bodyNode === null ? [] : collectInlineGuiMethods(bodyNode, [nameNode.text])
  };
}

function classifyGuiClassKind(
  baseName: string,
  knownGuiClasses: ReadonlyMap<string, AnalysisGuiClassKind>
): AnalysisGuiClassKind | undefined {
  const directKind = classifyDirectGuiBase(baseName);
  if (directKind !== undefined) {
    return directKind;
  }

  const knownKind = knownGuiClasses.get(baseName);
  if (knownKind !== undefined) {
    return knownKind;
  }

  if (/^GC[A-Za-z_$][0-9A-Za-z_$]*$/.test(baseName)) {
    return 'guiPart';
  }

  return undefined;
}

function baseNameFromClassSpecifier(node: Parser.SyntaxNode): string | undefined {
  const baseClause = node.namedChildren.find((child) => child.type === 'base_class_clause');
  return baseClause?.namedChildren.find((child) => isTypeNameNode(child))?.text;
}

/** Conditional directives wrap declarations without introducing a GUI scope. */
function* guiScopeChildren(node: Parser.SyntaxNode): Iterable<Parser.SyntaxNode> {
  for (const child of node.namedChildren) {
    if (['preproc_if', 'preproc_ifdef', 'preproc_else', 'preproc_elif', 'preproc_elifdef'].includes(child.type)) {
      yield* guiScopeChildren(child);
    } else {
      yield child;
    }
  }
}

function collectGuiParts(
  node: Parser.SyntaxNode,
  parentPath: string[],
  knownGuiClasses: ReadonlyMap<string, AnalysisGuiClassKind>
): AnalysisGuiPart[] {
  const parts: AnalysisGuiPart[] = [];

  for (const child of guiScopeChildren(node)) {
    if (child.type !== 'gins_definition' && child.type !== 'field_declaration') {
      continue;
    }

    const part = guiPartFromNode(child, parentPath, knownGuiClasses);
    if (part !== undefined) {
      parts.push(part);
    }
  }

  return parts;
}

function guiPartFromNode(
  node: Parser.SyntaxNode,
  parentPath: string[],
  knownGuiClasses: ReadonlyMap<string, AnalysisGuiClassKind>
): AnalysisGuiPart | undefined {
  const typeName = node.childForFieldName('type')?.text;
  if (typeName === undefined || !isGuiPartTypeName(typeName, new Set(knownGuiClasses.keys()))) {
    return undefined;
  }

  const nameNode = partNameNode(node);
  const name = nameNode?.text;
  const anonymous = name === undefined;
  const path = anonymous ? parentPath : [...parentPath, name];

  return {
    name,
    typeName,
    path,
    anonymous,
    range: nodeToAnalysisRange(node),
    ...(nameNode === null ? {} : { selectionRange: nodeToAnalysisRange(nameNode) }),
    parts: collectGuiParts(node, path, knownGuiClasses),
    methods: collectInlineGuiMethods(node, path)
  };
}

function knownGuiClassMap(knownGuiClasses: KnownGuiClasses): ReadonlyMap<string, AnalysisGuiClassKind> {
  if (knownGuiClasses instanceof Map) {
    return knownGuiClasses;
  }

  return new Map(Array.from(knownGuiClasses as ReadonlySet<string>).map((name) => [name, 'guiPart']));
}

function partNameNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return node.childForFieldName('name') ?? declaratorNameFromNode(node);
}

function declaratorNameFromNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === 'identifier' || node.type === 'class_name') {
    return node;
  }

  const declarator = node.childForFieldName('declarator');
  if (declarator === null) {
    return null;
  }

  return declarator.type === 'identifier' || declarator.type === 'class_name'
    ? declarator
    : getDeclaratorName(declarator);
}

function collectInlineGuiMethods(node: Parser.SyntaxNode, receiverPath: string[]): AnalysisGuiMethod[] {
  const methods: AnalysisGuiMethod[] = [];

  for (const child of guiScopeChildren(node)) {
    if (child.type !== 'gins_attributes_definition' && child.type !== 'function_definition') {
      continue;
    }

    const method = methodFromFunctionNode(child, receiverPath);
    if (method !== undefined) {
      methods.push(method);
    }
  }

  return methods;
}

export function collectExternalGuiMethods(rootNode: Parser.SyntaxNode): AnalysisGuiMethod[] {
  return rootNode.descendantsOfType('function_definition').flatMap(node => {
    const method = externalMethodFromFunctionNode(node);
    return method ? [method] : [];
  });
}

function methodFromFunctionNode(
  node: Parser.SyntaxNode,
  receiverPath: string[]
): AnalysisGuiMethod | undefined {
  const nameNode = functionNameNode(node);
  if (nameNode === null) {
    return undefined;
  }

  return {
    name: nameNode.text,
    receiverPath: [...receiverPath, nameNode.text],
    selectionRange: nodeToAnalysisRange(nameNode),
    event: isGuiEventName(nameNode.text),
    range: nodeToAnalysisRange(node)
  };
}

function externalMethodFromFunctionNode(node: Parser.SyntaxNode): AnalysisGuiMethod | undefined {
  const qualified = findQualifiedDeclarator(node);
  const scope = qualified?.childForFieldName('scope');
  const name = qualified?.childForFieldName('name');
  if (qualified === undefined || scope === null || scope === undefined || name === null || name === undefined) {
    return undefined;
  }

  const instanceSegments = instancePathSegments(qualified);
  return {
    name: name.text,
    receiverPath: [scope.text, ...instanceSegments.map((segment) => segment.name), name.text],
    receiverPathSegmentRanges: [
      nodeToAnalysisRange(scope),
      ...instanceSegments.map((segment) => segment.range),
      nodeToAnalysisRange(name)
    ],
    selectionRange: nodeToAnalysisRange(name),
    event: isGuiEventName(name.text),
    range: nodeToAnalysisRange(node)
  };
}

function findQualifiedDeclarator(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  if (node.type === 'qualified_declarator') {
    return node;
  }

  for (const child of node.namedChildren) {
    const found = findQualifiedDeclarator(child);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function functionNameNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const declarator = node.childForFieldName('declarator');
  return declarator === null ? null : getDeclaratorName(declarator);
}

interface InstancePathSegment {
  name: string;
  range: ReturnType<typeof nodeToAnalysisRange>;
}

function instancePathSegments(qualifiedDeclarator: Parser.SyntaxNode): InstancePathSegment[] {
  const instance = qualifiedDeclarator.childForFieldName('instance');
  if (instance === null) {
    return [];
  }

  return identifierSegmentsFromInstanceName(instance);
}

function identifierSegmentsFromInstanceName(node: Parser.SyntaxNode): InstancePathSegment[] {
  const segments: InstancePathSegment[] = [];

  for (const child of node.namedChildren) {
    if (child.type === 'identifier') {
      segments.push({
        name: child.text,
        range: nodeToAnalysisRange(child)
      });
      continue;
    }

    if (child.type === 'instance_name') {
      segments.push(...identifierSegmentsFromInstanceName(child));
    }
  }

  return segments;
}

function isGuiEventName(name: string): boolean {
  return /^On[A-Za-z_][0-9A-Za-z_$]*$/.test(name);
}

function isTypeNameNode(node: Parser.SyntaxNode): boolean {
  return node.type === 'class_name'
    || node.type === 'gins_class'
    || node.type === 'gtop_class'
    || node.type === 'identifier';
}
