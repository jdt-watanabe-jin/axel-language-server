import type * as Parser from 'tree-sitter';
import type { AnalysisDocumentUri, AnalysisReference, AnalysisSemanticToken } from '../types/analysis';
import { nodeToAnalysisRange } from './syntaxTree';

interface MacroParameter {
  name: string;
  range: AnalysisSemanticToken['range'];
}

export function collectPreprocessorSemanticTokens(rootNode: Parser.SyntaxNode): AnalysisSemanticToken[] {
  const tokens: AnalysisSemanticToken[] = [];

  function visit(node: Parser.SyntaxNode): void {
    if (node.type === 'preproc_function_def') {
      tokens.push(...macroParameterTokens(node));
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);
  return tokens;
}

export function collectPreprocessorSemanticTokenReferences(
  rootNode: Parser.SyntaxNode,
  uri: AnalysisDocumentUri
): AnalysisReference[] {
  const references: AnalysisReference[] = [];

  function visit(node: Parser.SyntaxNode): void {
    if (node.type === 'preproc_function_def') {
      references.push(...macroReplacementReferences(node, uri));
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);
  return references;
}

function macroParameterTokens(node: Parser.SyntaxNode): AnalysisSemanticToken[] {
  const parameters = macroParameters(node);
  if (parameters.length === 0) {
    return [];
  }

  return [
    ...parameters.map((parameter) => ({
      range: parameter.range,
      tokenType: 'parameter' as const,
      modifiers: ['declaration' as const]
    })),
    ...macroParameterReferenceTokens(node, parameters)
  ];
}

function macroParameters(node: Parser.SyntaxNode): MacroParameter[] {
  const parametersNode = node.childForFieldName('parameters');
  if (parametersNode === null) {
    return [];
  }

  return parametersNode.namedChildren
    .filter((child) => child.type === 'identifier')
    .map((child) => ({
      name: child.text,
      range: nodeToAnalysisRange(child)
    }));
}

function macroParameterReferenceTokens(
  node: Parser.SyntaxNode,
  parameters: readonly MacroParameter[]
): AnalysisSemanticToken[] {
  const valueNode = node.childForFieldName('value');
  if (valueNode === null) {
    return [];
  }

  const parameterNames = new Set(parameters.map((parameter) => parameter.name));
  return identifierOccurrencesOutsideTrivia(valueNode)
    .filter(({ name }) => parameterNames.has(name))
    .map(({ range }) => ({
      range,
      tokenType: 'parameter' as const,
      modifiers: []
    }));
}

function macroReplacementReferences(
  node: Parser.SyntaxNode,
  uri: AnalysisDocumentUri
): AnalysisReference[] {
  const valueNode = node.childForFieldName('value');
  if (valueNode === null) {
    return [];
  }

  const parameterNames = new Set(macroParameters(node).map((parameter) => parameter.name));
  return identifierOccurrencesOutsideTrivia(valueNode)
    .filter(({ name, call }) => call && !parameterNames.has(name) && !KEYWORDS.has(name))
    .map(({ name, range }) => ({
      name,
      uri,
      range,
      call: true
    }));
}

function identifierOccurrencesOutsideTrivia(node: Parser.SyntaxNode): {
  name: string;
  range: AnalysisSemanticToken['range'];
  call: boolean;
}[] {
  const results: { name: string; range: AnalysisSemanticToken['range']; call: boolean }[] = [];
  const text = node.text;
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];

    if (character === '"' || character === "'") {
      index = skipQuotedText(text, index, character);
      continue;
    }

    if (character === '/' && next === '/') {
      break;
    }

    if (character === '/' && next === '*') {
      index = skipBlockComment(text, index);
      continue;
    }

    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (index < text.length && isIdentifierPart(text[index])) {
        index += 1;
      }

      const name = text.slice(start, index);
      results.push({
        name,
        range: {
          start: {
            line: node.startPosition.row,
            character: node.startPosition.column + start
          },
          end: {
            line: node.startPosition.row,
            character: node.startPosition.column + index
          }
        },
        call: nextNonWhitespaceCharacter(text, index) === '('
      });
      continue;
    }

    index += 1;
  }

  return results;
}

const KEYWORDS = new Set([
  'break',
  'case',
  'catch',
  'continue',
  'default',
  'do',
  'else',
  'for',
  'goto',
  'if',
  'return',
  'switch',
  'throw',
  'try',
  'while'
]);

function nextNonWhitespaceCharacter(text: string, start: number): string | undefined {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }

  return text[index];
}

function skipQuotedText(text: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }

    if (text[index] === quote) {
      return index + 1;
    }

    index += 1;
  }

  return index;
}

function skipBlockComment(text: string, start: number): number {
  const end = text.indexOf('*/', start + 2);
  return end < 0 ? text.length : end + 2;
}

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[0-9A-Za-z_$]/.test(character);
}
