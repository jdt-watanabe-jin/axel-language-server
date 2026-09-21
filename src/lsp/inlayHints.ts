import { InlayHintKind, type InlayHint } from 'vscode-languageserver/node';
import type { AnalysisInlayHint } from '../analyzer/inlayHints';

export interface InlayHintsSettings { enabled: boolean; suppressWhenArgumentContainsName: boolean }

export function normalizeInlayHintsSettings(settings: unknown): InlayHintsSettings {
  const object = (value: unknown): Record<string,unknown> =>
    value !== null && typeof value === 'object' ? value as Record<string,unknown> : {};
  const values = object(object(object(settings).inlayHints).parameterNames);
  return {
    enabled: typeof values.enabled === 'boolean' ? values.enabled : false,
    suppressWhenArgumentContainsName: typeof values.suppressWhenArgumentContainsName === 'boolean'
      ? values.suppressWhenArgumentContainsName : true
  };
}

export function toLspInlayHints(hints: AnalysisInlayHint[]): InlayHint[] {
  return hints.map(hint=>({position:hint.position,label:hint.label,kind:InlayHintKind.Parameter,paddingRight:true}));
}
