import { PLATFORM_MACRO_NAMES, platformMacroValue } from './targetPlatform';
import type * as Parser from 'tree-sitter';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { AnalysisPosition, AnalysisRange, AnalyzedDocument } from '../types/analysis';
import { translate } from '../i18n/messages';

export const SYSTEM_MACRO_NAMES = [...PLATFORM_MACRO_NAMES, '__AXEL__', '__AXELVERSION__', '__AXELCONSOLE__', '__FILE__', '__LINE__', '__DATE__', '__TIME__', '__TIMESTAMP__', '__APP_LEDIT__', '__APP_SEDIT__', '__APP_SCHART__'] as const;
const applicationTools: Record<string, string> = { __APP_LEDIT__: 'ismo', __APP_SEDIT__: 'asca', __APP_SCHART__: 'spicechart' };
const runtimeFormats: Record<string, string> = { __DATE__: 'yy/mm/dd', __TIME__: 'hh:mm:ss', __TIMESTAMP__: 'yy/mm/dd hh:mm:ss' };

export interface SystemMacroValue {
  name: string;
  typeName: 'int' | 'string';
  defined: boolean;
  value?: string | number;
  runtimeFormat?: string;
}

export function isSystemMacroName(name: string): boolean {
  return (SYSTEM_MACRO_NAMES as readonly string[]).includes(name);
}

export function normalizeTool(tool: unknown): string {
  return typeof tool === 'string' && ['axel', 'ismo', 'asca', 'spicechart'].includes(tool) ? tool : 'axel';
}

export function systemMacroNames(tool?: string): string[] {
  return SYSTEM_MACRO_NAMES.filter(name => !(name in applicationTools) || applicationTools[name] === normalizeTool(tool));
}

export function resolveSystemMacro(name: string, uri: string, position: AnalysisPosition, tool?: string, targetPlatform?: string): SystemMacroValue | undefined {
  if (!isSystemMacroName(name)) { return undefined; }
  const platformValue = platformMacroValue(name, targetPlatform);
  if (platformValue !== undefined) { return { name, typeName: 'int', defined: true, value: platformValue }; }
  if (name in applicationTools) {
    const defined = applicationTools[name] === normalizeTool(tool);
    return { name, typeName: 'int', defined, ...(defined ? { value: 1 } : {}) };
  }
  if (name === '__AXEL__') { return { name, typeName: 'int', defined: true, value: 1 }; }
  if (name === '__AXELVERSION__') { return { name, typeName: 'int', defined: true, value: 510 }; }
  if (name === '__AXELCONSOLE__') { return { name, typeName: 'int', defined: true, value: normalizeTool(tool) === 'axel' ? 1 : 0 }; }
  if (name === '__LINE__') { return { name, typeName: 'int', defined: true, value: position.line + 1 }; }
  if (name === '__FILE__') {
    let value: string | undefined;
    try {
      const url = new URL(uri);
      // Preserve Windows paths even when the server is tested on another OS.
      value = /^\/[a-z]:\//i.test(url.pathname) && url.protocol === 'file:'
        ? path.win32.normalize(decodeURIComponent(url.pathname.slice(1))) : fileURLToPath(url);
    } catch { /* A non-file URI has no absolute source path. */ }
    return { name, typeName: 'string', defined: true, value };
  }
  return { name, typeName: 'string', defined: true, runtimeFormat: runtimeFormats[name] };
}

export function describeSystemMacro(macro: SystemMacroValue, locale?: string): string {
  const header = translate(locale, 'System-defined macro: {0} ({1})', macro.name, macro.typeName);
  if (!macro.defined) { return header + '\n' + translate(locale, 'Not defined for the current Tool.'); }
  if (macro.runtimeFormat !== undefined) {
    return header + '\n' + translate(locale, 'Determined at runtime ({0}); unavailable while editing.', macro.runtimeFormat);
  }
  return header + '\n' + (macro.value === undefined ? translate(locale, 'Absolute file path is unavailable.') : String(macro.value));
}

export function containsSourcePosition(range: AnalysisRange, position: AnalysisPosition): boolean {
  const compare = (a: AnalysisPosition, b: AnalysisPosition) => a.line - b.line || a.character - b.character;
  return compare(range.start, position) <= 0 && compare(position, range.end) < 0;
}

export function systemMacroAt(analysis: AnalyzedDocument, position: AnalysisPosition) {
  return analysis.systemMacroReferences?.find(ref => containsSourcePosition(ref.range, position));
}

export function collectSystemMacroSyntax(root: Parser.SyntaxNode): {
  references: { name: string; range: AnalysisRange }[];
  mutations: { name: string; range: AnalysisRange }[];
  excludedRanges: AnalysisRange[];
} {
  const references: { name: string; range: AnalysisRange }[] = [];
  const mutations: { name: string; range: AnalysisRange }[] = [];
  const excludedRanges: AnalysisRange[] = [];
  const range = (node: Parser.SyntaxNode): AnalysisRange => ({
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: node.endPosition.row, character: node.endPosition.column }
  });
  const visit = (node: Parser.SyntaxNode): void => {
    if (['comment', 'string_literal', 'char_literal', 'string_content'].includes(node.type)) {
      const excluded = range(node);
      // Cursor positions at an unfinished string or the end of // still belong to that token.
      if (node.type === 'string_content' || (node.type === 'comment' && node.text.startsWith('//'))) {
        excluded.end.character += 1;
      }
      excludedRanges.push(excluded);
      return;
    }
    if (node.type === 'preproc_def' || node.type === 'preproc_function_def') {
      const name = node.childForFieldName('name');
      if (name && isSystemMacroName(name.text)) { mutations.push({ name: name.text, range: range(name) }); }
    }
    if (node.type === 'preproc_call' && /^#\s*undef\b/.test(node.text)) {
      const argument = node.childForFieldName('argument');
      const name = argument?.text.trim().match(/^[A-Za-z_$][0-9A-Za-z_$]*/)?.[0];
      if (argument && name && isSystemMacroName(name)) {
        const argumentRange = range(argument);
        mutations.push({ name, range: { start: argumentRange.start, end: {
          line: argumentRange.start.line, character: argumentRange.start.character + name.length
        } } });
      }
    }
    if (node.type === 'identifier' && isSystemMacroName(node.text)) { references.push({ name: node.text, range: range(node) }); }
    for (const child of node.namedChildren) { visit(child); }
  };
  visit(root);
  return { references, mutations, excludedRanges };
}
