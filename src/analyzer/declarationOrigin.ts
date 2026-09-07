import { fileURLToPath } from 'url';
import type { AnalysisHover } from '../types/analysis';
import { translate } from '../i18n/messages';

export function declarationOrigin(sourceUri: string, definitionUri: string | undefined, locale?: string): string | undefined {
  if (definitionUri === undefined || definitionUri === sourceUri) {
    return undefined;
  }

  let filePath: string;
  try {
    filePath = fileURLToPath(definitionUri);
  } catch {
    filePath = definitionUri;
  }
  return translate(locale, 'defined in {0}', filePath);
}

export function withDeclarationOrigin(
  hover: AnalysisHover,
  sourceUri: string,
  definitionUri: string | undefined,
  locale?: string
): AnalysisHover {
  const origin = declarationOrigin(sourceUri, definitionUri, locale);
  if (origin === undefined) {
    return hover;
  }

  // Escape punctuation so paths remain literal in Markdown, including Windows separators.
  const escapedOrigin = origin.replace(/([\\`*_{}[\]()<>#+.!|~-])/g, '\\$1');
  return {
    markdown: `${hover.markdown}\n\n${escapedOrigin}`,
    plainText: `${hover.plainText}\n${origin}`
  };
}
