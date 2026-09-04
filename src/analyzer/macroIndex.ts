import type * as Parser from 'tree-sitter';
import type {
  AnalysisDocumentUri,
  AnalysisMacroDefinition,
  AnalysisParameter
} from '../types/analysis';
import { findNamedNodes, nodeToAnalysisRange } from './syntaxTree';

export function collectMacroDefinitions(
  rootNode: Parser.SyntaxNode,
  uri: AnalysisDocumentUri
): AnalysisMacroDefinition[] {
  return findNamedNodes(
    rootNode,
    (node) => node.type === 'preproc_def' || node.type === 'preproc_function_def'
  ).flatMap((node) => macroDefinitionFromNode(node, uri));
}

export function normalizeMacroReplacementText(text: string): string {
  return text.replace(/[ \t]*\\\r?\n/g, '\n').trim();
}

function macroDefinitionFromNode(
  node: Parser.SyntaxNode,
  uri: AnalysisDocumentUri
): AnalysisMacroDefinition[] {
  const nameNode = node.childForFieldName('name');
  if (nameNode === null) {
    return [];
  }

  const valueNode = node.childForFieldName('value');
  const detail = normalizeSignatureText(stripTrailingLineComment(node.text));
  const replacementText = valueNode === null
    ? ''
    : normalizeMacroReplacementText(stripTrailingLineComment(valueNode.text));
  const documentation = trailingLineCommentText(node.text);
  const parameters = node.type === 'preproc_function_def'
    ? macroParameters(node)
    : undefined;

  return [{
    name: nameNode.text,
    uri,
    range: nodeToAnalysisRange(node),
    selectionRange: nodeToAnalysisRange(nameNode),
    detail,
    ...(documentation === undefined ? {} : { documentation }),
    ...(parameters === undefined ? {} : { parameters }),
    replacementText
  }];
}

function macroParameters(node: Parser.SyntaxNode): AnalysisParameter[] | undefined {
  const parametersNode = node.childForFieldName('parameters');
  if (parametersNode === null) {
    return undefined;
  }

  const parameters = parametersNode.namedChildren
    .filter((child) => child.type === 'identifier' || child.text === '...')
    .map((child) => ({ label: child.text }));
  return parameters;
}

function normalizeSignatureText(text: string): string {
  return text.replace(/[ \t]*\\\r?\n[ \t]*/g, ' ').trim();
}

function stripTrailingLineComment(text: string): string {
  const index = trailingLineCommentIndex(text);
  return index === undefined ? text : text.slice(0, index).trimEnd();
}

function trailingLineCommentText(text: string): string | undefined {
  const index = trailingLineCommentIndex(text);
  if (index === undefined) {
    return undefined;
  }

  const comment = text.slice(index + 2).replace(/[ \t]*\\\r?\n/g, '\n').trim();
  return comment.length === 0 ? undefined : comment;
}

function trailingLineCommentIndex(text: string): number | undefined {
  let quote: string | undefined;
  for (let index = 0; index < text.length - 1; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (quote !== undefined) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      return index;
    }
  }

  return undefined;
}