import type { SemanticTokens, SemanticTokensLegend } from 'vscode-languageserver/node';
import type {
  AnalysisSemanticToken,
  AnalysisInactiveSemanticTokenModifier,
  AnalysisSemanticTokenType
} from '../types/analysis';

// Keep this legend append-only after release; clients encode token data by numeric index.
export const SEMANTIC_TOKEN_LEGEND: SemanticTokensLegend = {
  tokenTypes: [
    'class',
    'enum',
    'enumMember',
    'function',
    'macro',
    'method',
    'parameter',
    'property',
    'struct',
    'type',
    'variable',
    'operator'
  ],
  tokenModifiers: [
    'declaration',
    'inactive'
  ]
};

export function toLspSemanticTokens(tokens: readonly AnalysisSemanticToken[]): SemanticTokens {
  const data: number[] = [];
  let previousLine = 0;
  let previousStartCharacter = 0;

  for (const token of tokens) {
    const line = token.range.start.line;
    const startCharacter = token.range.start.character;
    const deltaLine = line - previousLine;
    const deltaStart = deltaLine === 0
      ? startCharacter - previousStartCharacter
      : startCharacter;

    data.push(
      deltaLine,
      deltaStart,
      token.range.end.character - token.range.start.character,
      tokenTypeIndex(token.tokenType),
      tokenModifierBitset(token.modifiers)
    );

    previousLine = line;
    previousStartCharacter = startCharacter;
  }

  return { data };
}

function tokenTypeIndex(tokenType: AnalysisSemanticTokenType): number {
  return SEMANTIC_TOKEN_LEGEND.tokenTypes.indexOf(tokenType);
}

function tokenModifierBitset(modifiers: readonly AnalysisInactiveSemanticTokenModifier[]): number {
  return modifiers.reduce((bitset, modifier) => {
    const index = SEMANTIC_TOKEN_LEGEND.tokenModifiers.indexOf(modifier);
    return index < 0 ? bitset : bitset | (1 << index);
  }, 0);
}
