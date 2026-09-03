import type * as Parser from 'tree-sitter';
import type {
  AnalysisDeclaration,
  AnalysisDeclarationKind,
  AnalysisDocumentUri,
  AnalysisSignature,
  AnalysisReference,
  AnalysisSymbolId
} from '../types/analysis';
import { isGuiPartTypeName } from './guiClassKinds';
import { isDeclarationNodeType, isTypeSpecifierNodeType } from './nodeKinds';
import { getDeclaratorName, nodeToAnalysisRange } from './syntaxTree';

export interface SymbolIndex {
  declarations: AnalysisDeclaration[];
  references: AnalysisReference[];
}

interface DeclaratorName {
  nameNode: Parser.SyntaxNode;
  declaratorNode: Parser.SyntaxNode;
}

interface DeclarationDetail {
  detail: string;
  typeName?: string;
  baseName?: string;
  signature?: AnalysisSignature;
}

export function buildSymbolIndex(
  rootNode: Parser.SyntaxNode,
  uri: AnalysisDocumentUri,
  knownGuiClassNames = new Set<string>()
): SymbolIndex {
  const declarations: AnalysisDeclaration[] = [];
  const declarationNameKeys = new Set<string>();

  collectDeclarations(rootNode, uri, [], declarations, declarationNameKeys, knownGuiClassNames);
  addNonIndexedDeclarationReferenceExclusions(rootNode, declarationNameKeys);

  return {
    declarations,
    references: collectReferences(rootNode, uri, declarationNameKeys)
  };
}

function collectDeclarations(
  node: Parser.SyntaxNode,
  uri: AnalysisDocumentUri,
  containerNames: string[],
  declarations: AnalysisDeclaration[],
  declarationNameKeys: Set<string>,
  knownGuiClassNames: ReadonlySet<string>
): void {
  const nodeDeclarations = declarationsFromNode(node, uri, containerNames, knownGuiClassNames);
  declarations.push(...nodeDeclarations);
  addDeclarationReferenceExclusions(node, nodeDeclarations, declarationNameKeys);

  const nestedContainers = nestedContainerNames(node, containerNames, nodeDeclarations);

  for (const child of node.namedChildren) {
    collectDeclarations(child, uri, nestedContainers, declarations, declarationNameKeys, knownGuiClassNames);
  }
}

function declarationsFromNode(
  node: Parser.SyntaxNode,
  uri: AnalysisDocumentUri,
  containerNames: string[],
  knownGuiClassNames: ReadonlySet<string>
): AnalysisDeclaration[] {
  const macroDeclaration = macroDeclarationFromNode(node, uri);
  if (macroDeclaration !== undefined) {
    return [macroDeclaration];
  }

  if (isDeclarationNodeType(node.type)) {
    return declaratorNames(node).map(({ nameNode, declaratorNode }) => {
      const kind = declarationKind(node.type, declaratorNode);
      return declarationFromNode(
        node,
        nameNode,
        kind,
        uri,
        containerNames,
        detailForDeclarator(node, nameNode, declaratorNode, kind),
        containerNameForDeclarator(containerNames, declaratorNode)
      );
    });
  }

  if (node.type === 'parameter_declaration') {
    return declaratorNames(node).map(({ nameNode, declaratorNode }) => declarationFromNode(
      node,
      nameNode,
      'parameter',
      uri,
      containerNames,
      detailForDeclarator(node, nameNode, declaratorNode, 'parameter')
    ));
  }

  if (node.type === 'gins_definition') {
    const typeNode = node.childForFieldName('type');
    const nameNode = node.childForFieldName('name') ?? declaratorNameFromNode(node);
    if (typeNode !== null && nameNode !== null && isGuiPartTypeName(typeNode.text, knownGuiClassNames)) {
      return [declarationFromNode(
        node,
        nameNode,
        'variable',
        uri,
        containerNames,
        { detail: `${typeNode.text} ${nameNode.text}`, typeName: typeNode.text },
        containerNames.at(-1)
      )];
    }
  }

  if (isTypeSpecifierNodeType(node.type) && node.childForFieldName('body') !== null) {
    const nameNode = node.childForFieldName('name');
    if (nameNode !== null) {
      const declaration = declarationFromNode(node, nameNode, typeKind(node.type), uri, containerNames, {
        detail: typeKind(node.type),
        baseName: baseNameFromTypeSpecifier(node)
      });
      return node.type === 'enum_specifier'
        ? [declaration, ...enumMemberDeclarationsFromNode(node, nameNode.text, uri)]
        : [declaration];
    }

    if (node.type === 'enum_specifier') {
      return enumMemberDeclarationsFromNode(node, undefined, uri);
    }
  }

  const recoveredTypeDeclaration = recoveredTypeDeclarationFromMalformedBody(node, uri, containerNames);
  if (recoveredTypeDeclaration !== undefined) {
    return [recoveredTypeDeclaration];
  }

  return [];
}

function recoveredTypeDeclarationFromMalformedBody(
  node: Parser.SyntaxNode,
  uri: AnalysisDocumentUri,
  containerNames: string[]
): AnalysisDeclaration | undefined {
  if (!isRecoverableTypeSpecifierNode(node)) {
    return undefined;
  }

  const nameNode = node.childForFieldName('name');
  if (nameNode === null || nextNamedSibling(node)?.type !== 'ERROR') {
    return undefined;
  }

  const sibling = nextNamedSibling(node);
  if (sibling === undefined || !sibling.text.trimStart().startsWith('{')) {
    return undefined;
  }

  return declarationFromNode(node, nameNode, typeKind(node.type), uri, containerNames, {
    detail: typeKind(node.type),
    baseName: baseNameFromTypeSpecifier(node)
  });
}

function isRecoverableTypeSpecifierNode(node: Parser.SyntaxNode): boolean {
  return isTypeSpecifierNodeType(node.type) && node.childForFieldName('body') === null;
}

function nextNamedSibling(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  const siblings = node.parent?.namedChildren;
  if (siblings === undefined) {
    return undefined;
  }

  const index = siblings.findIndex((sibling) => sibling.id === node.id);
  return index < 0 ? undefined : siblings[index + 1];
}

function macroDeclarationFromNode(
  node: Parser.SyntaxNode,
  uri: AnalysisDocumentUri
): AnalysisDeclaration | undefined {
  if (node.type !== 'preproc_def' && node.type !== 'preproc_function_def') {
    return undefined;
  }

  const nameNode = node.childForFieldName('name');
  if (nameNode === null) {
    return undefined;
  }

  return declarationFromNode(
    node,
    nameNode,
    'macro',
    uri,
    [],
    {
      detail: normalizeSignatureText(stripTrailingLineComment(node.text)),
      ...(node.type === 'preproc_function_def' ? { signature: macroSignatureFromNode(node, nameNode) } : {})
    },
    undefined
  );
}

function macroSignatureFromNode(
  node: Parser.SyntaxNode,
  nameNode: Parser.SyntaxNode
): AnalysisSignature | undefined {
  const parametersNode = node.childForFieldName('parameters');
  if (parametersNode === null) {
    return undefined;
  }

  const parameters = macroParameterLabels(parametersNode);
  return {
    label: `#define ${nameNode.text}(${parameters.join(', ')})`,
    parameters: parameters.map((label) => ({ label }))
  };
}

function macroParameterLabels(parametersNode: Parser.SyntaxNode): string[] {
  const labels: string[] = [];
  for (let index = 0; index < parametersNode.childCount; index += 1) {
    const child = parametersNode.child(index);
    if (child?.type === 'identifier' || child?.text === '...') {
      labels.push(child.text);
    }
  }

  return labels;
}

function enumMemberDeclarationsFromNode(
  enumNode: Parser.SyntaxNode,
  enumName: string | undefined,
  uri: AnalysisDocumentUri
): AnalysisDeclaration[] {
  const bodyNode = enumNode.childForFieldName('body');
  if (bodyNode === null) {
    return [];
  }

  return bodyNode.namedChildren
    .filter((child) => child.type === 'enumerator')
    .flatMap((enumerator) => enumMemberDeclarationFromNode(enumerator, enumName, uri));
}

function enumMemberDeclarationFromNode(
  enumerator: Parser.SyntaxNode,
  enumName: string | undefined,
  uri: AnalysisDocumentUri
): AnalysisDeclaration[] {
  const nameNode = enumerator.childForFieldName('name');
  if (nameNode === null) {
    return [];
  }

  const valueNode = enumerator.childForFieldName('value');
  const valueText = valueNode === null ? '' : ` = ${normalizeSignatureText(valueNode.text)}`;
  const detail = enumName === undefined
    ? `enum ${nameNode.text}${valueText}`
    : `enum ${enumName}::${nameNode.text}${valueText}`;

  return [declarationFromNode(
    enumerator,
    nameNode,
    'enumMember',
    uri,
    enumName === undefined ? [] : [enumName],
    { detail },
    enumName
  )];
}

function declaratorNames(node: Parser.SyntaxNode): DeclaratorName[] {
  const names: DeclaratorName[] = [];

  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child === null || node.fieldNameForChild(index) !== 'declarator') {
      continue;
    }

    const nameNode = declaratorNameNode(child);
    if (nameNode !== null) {
      names.push({ nameNode, declaratorNode: child });
    }
  }

  return names;
}

function declaratorNameNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === 'qualified_declarator') {
    return nameFieldNode(node);
  }

  const nameNode = isDeclaratorNameNode(node) ? node : getDeclaratorName(node);
  return nameNode?.type === 'qualified_declarator'
    ? nameFieldNode(nameNode)
    : nameNode;
}

function nameFieldNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let index = node.childCount - 1; index >= 0; index -= 1) {
    const child = node.child(index);
    if (child !== null && child.isNamed && node.fieldNameForChild(index) === 'name') {
      return child;
    }
  }

  return node.childForFieldName('name');
}

function declaratorNameFromNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === 'identifier' || node.type === 'class_name') {
    return node;
  }

  const declarator = node.childForFieldName('declarator');
  return declarator === null ? null : declaratorNameNode(declarator);
}

function isDeclaratorNameNode(node: Parser.SyntaxNode): boolean {
  return [
    'identifier',
    'class_name',
    'operator_declarator',
    'conversion_declarator'
  ].includes(node.type);
}

function addDeclarationReferenceExclusions(
  node: Parser.SyntaxNode,
  declarations: AnalysisDeclaration[],
  exclusionKeys: Set<string>
): void {
  for (const declaration of declarations) {
    exclusionKeys.add(rangeKey(declaration.selectionRange));
  }

  for (const declarator of declaratorNodes(node)) {
    addQualifiedDeclaratorIdentifierKeys(declarator, exclusionKeys);
  }

  addPreprocFunctionParameterKeys(node, exclusionKeys);
}

function addPreprocFunctionParameterKeys(node: Parser.SyntaxNode, exclusionKeys: Set<string>): void {
  if (node.type !== 'preproc_function_def') {
    return;
  }

  const parameters = node.childForFieldName('parameters');
  if (parameters === null) {
    return;
  }

  addIdentifierKeys(parameters, exclusionKeys);
}

function addNonIndexedDeclarationReferenceExclusions(
  rootNode: Parser.SyntaxNode,
  exclusionKeys: Set<string>
): void {
  function visit(node: Parser.SyntaxNode): void {
    if (node.type === 'parameter_declaration') {
      addDeclaratorNameKeys(node, exclusionKeys);
    }

    if (node.type === 'enumerator') {
      const nameNode = node.childForFieldName('name');
      if (nameNode !== null) {
        exclusionKeys.add(rangeKey(nodeToAnalysisRange(nameNode)));
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);
}

function addDeclaratorNameKeys(node: Parser.SyntaxNode, exclusionKeys: Set<string>): void {
  for (const declarator of declaratorNodes(node)) {
    const nameNode = declaratorNameNode(declarator);
    if (nameNode !== null) {
      exclusionKeys.add(rangeKey(nodeToAnalysisRange(nameNode)));
    }
  }
}

function declaratorNodes(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const nodes: Parser.SyntaxNode[] = [];

  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child !== null && node.fieldNameForChild(index) === 'declarator') {
      nodes.push(child);
    }
  }

  return nodes;
}

function addIdentifierKeys(node: Parser.SyntaxNode, exclusionKeys: Set<string>): void {
  if (node.type === 'identifier' || node.type === 'class_name') {
    exclusionKeys.add(rangeKey(nodeToAnalysisRange(node)));
  }

  for (const child of node.namedChildren) {
    addIdentifierKeys(child, exclusionKeys);
  }
}

function addQualifiedDeclaratorIdentifierKeys(
  node: Parser.SyntaxNode,
  exclusionKeys: Set<string>
): void {
  if (node.type === 'qualified_declarator') {
    addIdentifierKeys(node, exclusionKeys);
    return;
  }

  for (const child of node.namedChildren) {
    addQualifiedDeclaratorIdentifierKeys(child, exclusionKeys);
  }
}

function isContainerDeclarationNode(node: Parser.SyntaxNode): boolean {
  return node.type === 'function_definition'
    || node.type === 'class_specifier'
    || node.type === 'struct_specifier'
    || node.type === 'union_specifier';
}

function nestedContainerNames(
  node: Parser.SyntaxNode,
  containerNames: string[],
  nodeDeclarations: AnalysisDeclaration[]
): string[] {
  if (isContainerDeclarationNode(node)) {
    return [...containerNames, ...nodeDeclarations.map((declaration) => declaration.name)];
  }

  if (node.type !== 'gins_definition' || nodeDeclarations.length === 0) {
    return containerNames;
  }

  const typeName = nodeDeclarations[0].typeName;
  return typeName === undefined ? containerNames : [...containerNames, typeName];
}

function declarationFromNode(
  node: Parser.SyntaxNode,
  nameNode: Parser.SyntaxNode,
  kind: AnalysisDeclarationKind,
  uri: AnalysisDocumentUri,
  containerNames: string[],
  declarationDetail: DeclarationDetail = { detail: kind },
  containerName = containerNames.at(-1)
): AnalysisDeclaration {
  const selectionRange = declarationSelectionRange(nameNode);
  return {
    id: declarationId(uri, selectionRange, nameNode.text),
    name: nameNode.text,
    kind,
    uri,
    range: nodeToAnalysisRange(node),
    selectionRange,
    detail: declarationDetail.detail,
    ...(containerName === undefined ? {} : { containerName }),
    ...(declarationDetail.typeName === undefined ? {} : { typeName: declarationDetail.typeName }),
    ...(declarationDetail.baseName === undefined ? {} : { baseName: declarationDetail.baseName }),
    ...(declarationDetail.signature === undefined ? {} : { signature: declarationDetail.signature })
  };
}

function declarationSelectionRange(nameNode: Parser.SyntaxNode): ReturnType<typeof nodeToAnalysisRange> {
  const range = nodeToAnalysisRange(nameNode);
  const parent = nameNode.parent;
  if (parent === null) {
    return range;
  }

  for (let index = 1; index < parent.childCount; index += 1) {
    const child = parent.child(index);
    const previous = parent.child(index - 1);
    if (
      child?.id === nameNode.id
      && previous?.text === '~'
      && parent.fieldNameForChild(index) === 'name'
      && parent.fieldNameForChild(index - 1) === 'name'
    ) {
      return {
        start: nodeToAnalysisRange(previous).start,
        end: range.end
      };
    }
  }

  return range;
}

function baseNameFromTypeSpecifier(node: Parser.SyntaxNode): string | undefined {
  const baseClassClause = node.namedChildren.find((child) => child.type === 'base_class_clause');
  const baseClassName = baseClassClause?.namedChildren
    .find((child) => child.type === 'class_name' || child.type === 'identifier');
  return baseClassName?.text;
}

function containerNameForDeclarator(
  containerNames: string[],
  declaratorNode: Parser.SyntaxNode
): string | undefined {
  return qualifiedDeclaratorScope(declaratorNode) ?? containerNames.at(-1);
}

function qualifiedDeclaratorScope(node: Parser.SyntaxNode): string | undefined {
  if (node.type === 'qualified_declarator') {
    return node.childForFieldName('scope')?.text;
  }

  for (const child of node.namedChildren) {
    const scope = qualifiedDeclaratorScope(child);
    if (scope !== undefined) {
      return scope;
    }
  }

  return undefined;
}

function detailForDeclarator(
  declarationNode: Parser.SyntaxNode,
  nameNode: Parser.SyntaxNode,
  declaratorNode: Parser.SyntaxNode,
  kind: AnalysisDeclarationKind
): DeclarationDetail {
  if (kind === 'function') {
    const detail = functionDetail(declarationNode, declaratorNode);
    return {
      detail: detail ?? kind,
      ...(detail === undefined ? {} : { signature: signatureFromFunctionDeclarator(detail, declaratorNode) })
    };
  }

  if (kind !== 'variable' && kind !== 'parameter') {
    return { detail: kind };
  }

  const typeNode = declarationNode.childForFieldName('type');
  const typeText = typeNode === null ? undefined : typeTextFromNode(typeNode);
  if (typeText === undefined) {
    return { detail: kind };
  }

  return {
    detail: `${typeText} ${declaratorText(declaratorNode, nameNode)}`,
    typeName: typeText
  };
}

function signatureFromFunctionDeclarator(
  label: string,
  declaratorNode: Parser.SyntaxNode
): AnalysisSignature | undefined {
  const parameterList = findFunctionParameterList(declaratorNode);
  if (parameterList === undefined) {
    return undefined;
  }

  return {
    label,
    parameters: parameterLabels(parameterList).map((parameterLabel) => ({ label: parameterLabel }))
  };
}

function findFunctionParameterList(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  if (node.type === 'function_declarator') {
    return node.childForFieldName('parameters') ?? undefined;
  }

  for (const child of node.namedChildren) {
    const parameterList = findFunctionParameterList(child);
    if (parameterList !== undefined) {
      return parameterList;
    }
  }

  return undefined;
}

function parameterLabels(parameterList: Parser.SyntaxNode): string[] {
  const labels: string[] = [];
  for (let index = 0; index < parameterList.childCount; index += 1) {
    const child = parameterList.child(index);
    if (child?.type === 'parameter_declaration') {
      labels.push(normalizeSignatureText(child.text));
    } else if (child?.text === '...') {
      labels.push('...');
    }
  }

  return labels;
}

function functionDetail(
  declarationNode: Parser.SyntaxNode,
  declaratorNode: Parser.SyntaxNode
): string | undefined {
  const declarator = normalizeSignatureText(declaratorNode.text);
  const typeNode = declarationNode.childForFieldName('type');
  const typeText = typeNode === null ? undefined : typeTextFromNode(typeNode);
  if (typeText === undefined) {
    return declarator || undefined;
  }

  const storageText = declarationNode.childForFieldName('storage_class_specifier')?.text;
  const storageClass = declarationNode.type === 'function_definition' || storageText === 'static'
    ? storageText
    : undefined;
  return [storageClass, typeText, declarator]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(' ');
}

function typeTextFromNode(typeNode: Parser.SyntaxNode): string | undefined {
  const nameNode = typeNode.childForFieldName('name');
  if (nameNode !== null) {
    return normalizeSignatureText(nameNode.text);
  }

  return normalizeSignatureText(typeNode.text) || undefined;
}

function declaratorText(declaratorNode: Parser.SyntaxNode, nameNode: Parser.SyntaxNode): string {
  const source = declaratorNode.type === 'init_declarator'
    ? declaratorNode.childForFieldName('declarator')?.text ?? declaratorNode.text
    : declaratorNode.text;

  return source.includes(nameNode.text) ? normalizeSignatureText(source) : nameNode.text;
}

function normalizeSignatureText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripTrailingLineComment(text: string): string {
  let quote: '"' | '\'' | undefined;
  let escaped = false;

  for (let index = 0; index < text.length - 1; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === '\'') {
      quote = character;
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      return text.slice(0, index);
    }
  }

  return text;
}

function collectReferences(
  rootNode: Parser.SyntaxNode,
  uri: AnalysisDocumentUri,
  declarationNameKeys: Set<string>
): AnalysisReference[] {
  const references: AnalysisReference[] = [];
  const referenceExclusionKeys = new Set(declarationNameKeys);
  const callTargetKeys = collectCallTargetKeys(rootNode);

  function visit(node: Parser.SyntaxNode): void {
    const memberReference = memberReferenceFromNode(node, uri, callTargetKeys);
    if (memberReference !== undefined) {
      references.push(memberReference);
      referenceExclusionKeys.add(rangeKey(memberReference.range));
    }

    const qualifiedReference = qualifiedReferenceFromNode(node, uri, callTargetKeys);
    if (qualifiedReference !== undefined) {
      references.push(qualifiedReference);
      referenceExclusionKeys.add(rangeKey(qualifiedReference.range));
    }

    const qualifiedReceiverReference = qualifiedReceiverReferenceFromNode(node, uri);
    if (qualifiedReceiverReference !== undefined) {
      references.push(qualifiedReceiverReference);
      referenceExclusionKeys.add(rangeKey(qualifiedReceiverReference.range));
    }

    if (isReferenceNameNode(node)) {
      const range = nodeToAnalysisRange(node);
      const key = rangeKey(range);
      if (!referenceExclusionKeys.has(key)) {
        references.push({
          name: node.text,
          uri,
          range,
          ...(callTargetKeys.has(key) ? { call: true } : {}),
          ...(isTypeReferenceNameNode(node) ? { typeReference: true } : {})
        });
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);
  return references;
}

function isReferenceNameNode(node: Parser.SyntaxNode): boolean {
  return node.type === 'identifier'
    || node.type === 'class_name'
    || node.type === 'gtop_class'
    || node.type === 'gins_class';
}

function isTypeReferenceNameNode(node: Parser.SyntaxNode): boolean {
  if (node.type !== 'class_name' && node.type !== 'gins_class' && node.type !== 'gtop_class') {
    return false;
  }

  const parent = node.parent;
  if (parent === null) {
    return false;
  }

  return parent.childForFieldName('type') === node || parent.type === 'base_class_clause';
}

function memberReferenceFromNode(
  node: Parser.SyntaxNode,
  uri: AnalysisDocumentUri,
  callTargetKeys: ReadonlySet<string>
): AnalysisReference | undefined {
  if (node.type !== 'field_expression') {
    return undefined;
  }

  const chain = memberAccessChain(node);
  const currentMember = chain.memberNodes.at(-1);
  if (chain.receiverName === undefined || currentMember === undefined) {
    return undefined;
  }

  const range = nodeToAnalysisRange(currentMember);
  return {
    name: currentMember.text,
    uri,
    range,
    ...(callTargetKeys.has(rangeKey(range)) ? { call: true } : {}),
    memberAccess: {
      receiverName: chain.receiverName,
      memberNames: chain.memberNodes.map((memberNode) => memberNode.text)
    }
  };
}

function memberAccessChain(node: Parser.SyntaxNode): {
  receiverName?: string;
  memberNodes: Parser.SyntaxNode[];
} {
  const argument = node.childForFieldName('argument');
  const field = node.childForFieldName('field');
  const memberNodes = field === null ? [] : [field];

  if (argument?.type === 'field_expression') {
    const parentChain = memberAccessChain(argument);
    return {
      receiverName: parentChain.receiverName,
      memberNodes: [...parentChain.memberNodes, ...memberNodes]
    };
  }

  return {
    receiverName: isMemberReceiverNode(argument)
      ? argument.text
      : undefined,
    memberNodes
  };
}

function qualifiedReceiverReferenceFromNode(
  node: Parser.SyntaxNode,
  uri: AnalysisDocumentUri
): AnalysisReference | undefined {
  if (node.type !== 'qualified_identifier' || node.parent?.type === 'qualified_identifier') {
    return undefined;
  }

  const receiver = qualifiedIdentifierSegments(node)[0];
  if (receiver === undefined) {
    return undefined;
  }

  return {
    name: receiver.text,
    uri,
    range: nodeToAnalysisRange(receiver),
    typeReference: true
  };
}

function qualifiedReferenceFromNode(
  node: Parser.SyntaxNode,
  uri: AnalysisDocumentUri,
  callTargetKeys: ReadonlySet<string>
): AnalysisReference | undefined {
  if (node.type !== 'qualified_identifier' || node.parent?.type === 'qualified_identifier') {
    return undefined;
  }

  const segments = qualifiedIdentifierSegments(node);
  const receiver = segments[0];
  const memberNodes = segments.slice(1);
  const currentMember = memberNodes.at(-1);
  if (receiver === undefined || currentMember === undefined) {
    return undefined;
  }

  const range = nodeToAnalysisRange(currentMember);
  return {
    name: currentMember.text,
    uri,
    range,
    ...(callTargetKeys.has(rangeKey(range)) ? { call: true } : {}),
    memberAccess: {
      receiverName: receiver.text,
      memberNames: memberNodes.map((memberNode) => memberNode.text)
    }
  };
}

function qualifiedIdentifierSegments(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const segments: Parser.SyntaxNode[] = [];

  function visit(current: Parser.SyntaxNode): void {
    if (isQualifiedIdentifierSegmentNode(current)) {
      segments.push(current);
      return;
    }

    for (const child of current.namedChildren) {
      visit(child);
    }
  }

  visit(node);
  return segments;
}

function isQualifiedIdentifierSegmentNode(node: Parser.SyntaxNode | null | undefined): boolean {
  return node?.type === 'identifier' || node?.type === 'namespace_identifier';
}

function isMemberReceiverNode(node: Parser.SyntaxNode | null | undefined): node is Parser.SyntaxNode {
  return node?.type === 'identifier' || node?.type === 'class_name' || node?.type === 'this';
}

function collectCallTargetKeys(rootNode: Parser.SyntaxNode): Set<string> {
  const keys = new Set<string>();

  function visit(node: Parser.SyntaxNode): void {
    if (node.type === 'call_expression') {
      const target = callTargetNameNode(node.childForFieldName('function'));
      if (target !== undefined) {
        keys.add(rangeKey(nodeToAnalysisRange(target)));
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);
  return keys;
}

function callTargetNameNode(node: Parser.SyntaxNode | null): Parser.SyntaxNode | undefined {
  if (node === null) {
    return undefined;
  }

  if (isCallTargetNameNode(node)) {
    return node;
  }

  const field = node.type === 'field_expression' ? node.childForFieldName('field') : null;
  if (field !== null && isCallTargetNameNode(field)) {
    return field;
  }

  for (const child of [...node.namedChildren].reverse()) {
    const target = callTargetNameNode(child);
    if (target !== undefined) {
      return target;
    }
  }

  return undefined;
}

function isCallTargetNameNode(node: Parser.SyntaxNode): boolean {
  return isReferenceNameNode(node) || node.type === 'member_identifier';
}

function declarationId(uri: AnalysisDocumentUri, range: ReturnType<typeof nodeToAnalysisRange>, name: string): AnalysisSymbolId {
  return `${uri}#${range.start.line}:${range.start.character}:${name}`;
}

function rangeKey(range: ReturnType<typeof nodeToAnalysisRange>): string {
  return `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

function declarationKind(type: string, declaratorNode?: Parser.SyntaxNode): AnalysisDeclarationKind {
  if (type === 'function_definition') {
    return 'function';
  }

  if (
    (type === 'object_definition' || type === 'field_declaration')
    && declaratorNode !== undefined
    && (containsFunctionDeclarator(declaratorNode) || containsOperatorDeclarator(declaratorNode))
  ) {
    return 'function';
  }

  if (type === 'type_definition') {
    return 'typedef';
  }

  return 'variable';
}

function containsFunctionDeclarator(node: Parser.SyntaxNode): boolean {
  return node.type === 'function_declarator'
    || node.namedChildren.some(containsFunctionDeclarator);
}

function containsOperatorDeclarator(node: Parser.SyntaxNode): boolean {
  return node.type === 'operator_declarator'
    || node.namedChildren.some(containsOperatorDeclarator);
}

function typeKind(type: string): AnalysisDeclarationKind {
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
