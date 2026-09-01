import {
  CompletionItemKind,
  type CompletionItem
} from 'vscode-languageserver/node';
import type { AnalysisCompletionItem } from '../types/analysis';

export function toLspCompletionItem(item: AnalysisCompletionItem): CompletionItem {
  return {
    label: item.name,
    kind: toCompletionItemKind(item.kind),
    detail: item.detail,
    documentation: item.documentation,
    insertText: item.insertText,
    filterText: item.filterText,
    sortText: item.sortText
  };
}

function toCompletionItemKind(kind: AnalysisCompletionItem['kind']): CompletionItemKind {
  switch (kind) {
    case 'function':
      return CompletionItemKind.Function;
    case 'method':
    case 'event':
      return CompletionItemKind.Method;
    case 'variable':
      return CompletionItemKind.Variable;
    case 'property':
      return CompletionItemKind.Property;
    case 'class':
      return CompletionItemKind.Class;
    case 'struct':
      return CompletionItemKind.Struct;
    case 'union':
      return CompletionItemKind.Struct;
    case 'enum':
      return CompletionItemKind.Enum;
    case 'enumMember':
      return CompletionItemKind.EnumMember;
    case 'macro':
      return CompletionItemKind.Constant;
    case 'typedef':
      return CompletionItemKind.TypeParameter;
    case 'include':
      return CompletionItemKind.File;
    case 'keyword':
      return CompletionItemKind.Keyword;
  }
}
