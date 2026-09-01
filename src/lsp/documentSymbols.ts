import { DocumentSymbol, SymbolKind } from 'vscode-languageserver/node';
import type { AnalysisSymbol, AnalysisSymbolKind } from '../types/analysis';

export function toLspDocumentSymbol(symbol: AnalysisSymbol): DocumentSymbol {
  return DocumentSymbol.create(
    symbol.name,
    symbol.detail ?? symbol.kind,
    toLspSymbolKind(symbol.kind),
    symbol.range,
    symbol.selectionRange,
    symbol.children?.map(toLspDocumentSymbol)
  );
}

function toLspSymbolKind(kind: AnalysisSymbolKind): SymbolKind {
  switch (kind) {
    case 'function':
      return SymbolKind.Function;
    case 'method':
      return SymbolKind.Method;
    case 'parameter':
    case 'variable':
      return SymbolKind.Variable;
    case 'field':
      return SymbolKind.Field;
    case 'typedef':
      return SymbolKind.TypeParameter;
    case 'class':
      return SymbolKind.Class;
    case 'struct':
      return SymbolKind.Struct;
    case 'union':
      return SymbolKind.Object;
    case 'enum':
      return SymbolKind.Enum;
    case 'enumMember':
      return SymbolKind.EnumMember;
    case 'macro':
      return SymbolKind.Constant;
    case 'include':
      return SymbolKind.File;
  }
}
