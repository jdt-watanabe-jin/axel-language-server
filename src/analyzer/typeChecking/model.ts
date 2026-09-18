import type { AnalysisDiagnostic, AnalysisMacroDefinition, AnalysisPosition, AnalyzedDocument } from '../../types/analysis';
import type { BuiltinCatalog } from './builtinCatalog';
import type { TypeNode } from './syntax';
export type CheckSite = 'initialize' | 'assign' | 'argument' | 'return' | 'operator' | 'condition' | 'cast';
export type ValueCategory = 'storage' | 'temporary' | 'reference';
export interface Type {
  kind: 'basic' | 'class' | 'pointer' | 'array' | 'reference' | 'function' | 'null' | 'unknown';
  name: string;
  element?: Type;
  const?: boolean;
  classInfo?: ClassInfo;
  call?: FunctionInfo;
  candidates?: FunctionInfo[];
}
export interface FunctionInfo {
  name: string; node: TypeNode; declarator: TypeNode; uri: string; result: Type; parameters: Type[];
  required: number; variadic: boolean; owner?: ClassInfo; scope: Scope;
  instancePath?: string;
  virtual?: boolean;
}
export interface Binding { name: string; type: Type; node: TypeNode; scope: Scope; uri: string }
export interface Scope { parent?: Scope; uri: string; node: TypeNode; owner?: ClassInfo; thisType?: Type; fn?: FunctionInfo; bindings: Binding[] }
export interface ClassInfo {
  id: string; name: string; uri: string; node: TypeNode; role?: string;
  baseName?: string; baseNames?: string[]; fields: Map<string, Binding>; methods: Map<string, FunctionInfo[]>;
  scope: Scope; defined: boolean;
}
export interface ExpressionResult { guiReceiver?: { owner: ClassInfo; path: string[] }; type: Type; category: ValueCategory; constant?: number | string | boolean; constantExpression?: boolean; unknown?: boolean }
export interface TypeContext {
  sourcePosition?: (position: AnalysisPosition) => AnalysisPosition;
  resolveMacro?: (name: string, node: TypeNode) => AnalysisMacroDefinition | undefined;
  analysis: AnalyzedDocument; documents: readonly AnalyzedDocument[]; catalog: BuiltinCatalog;
  classes: ClassInfo[]; scopes: Scope[]; functions: FunctionInfo[]; bindings: Binding[];
  aliases: Map<string, Type>; nodeScopes: Map<TypeNode, Scope>; diagnostics: AnalysisDiagnostic[];
  cache: Map<TypeNode, ExpressionResult>;
  semanticCalls: { node: TypeNode; targets: FunctionInfo[] }[];
}
export const unknownType: Type = {kind:'unknown', name:'unknown'};
export const basic = (name: string): Type => ({kind:'basic',name});
export const pointer = (element: Type): Type => ({kind:'pointer',name:element.name+'*',element});
export function dereference(type: Type): Type { return type.kind === 'reference' ? type.element! : type; }
export function sameType(a: Type, b: Type): boolean {
  a=dereference(a); b=dereference(b);
  if(a.kind!==b.kind) { return false; }
  if(a.kind==='class') { return a.classInfo?.id===b.classInfo?.id; }
  if(a.element && b.element) { return sameType(a.element,b.element); }
  return a.name===b.name;
}
export function sameFunctionSignature(a: FunctionInfo, b: FunctionInfo): boolean {
  return a.name === b.name && a.parameters.length === b.parameters.length
    && a.parameters.every((parameter, index) => sameType(parameter, b.parameters[index]));
}
/** Collapse declarations and definitions of one callable while preserving their source identities. */
export function uniquelyResolvedFunctions(candidates: readonly FunctionInfo[]): FunctionInfo[] {
  if (!candidates.length) { return []; }
  const first = candidates[0];
  return candidates.every(candidate => candidate.owner?.id === first.owner?.id
    && sameFunctionSignature(candidate, first)) ? [...candidates] : [];
}
export const numericNames = new Set(['bool','char','unsigned char','short','unsigned short','int','unsigned int','int64','float','double']);
export const isNumeric = (t: Type): boolean => t.kind==='basic' && numericNames.has(t.name);
export const isInteger = (t: Type): boolean => isNumeric(t) && t.name!=='float' && t.name!=='double';
export const role = (t: Type): string | undefined => t.classInfo?.role;
