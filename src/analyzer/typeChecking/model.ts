import type { AnalysisDiagnostic, AnalysisMacroDefinition, AnalyzedDocument } from '../../types/analysis';
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
  name: string; node: TypeNode; uri: string; result: Type; parameters: Type[];
  required: number; variadic: boolean; owner?: ClassInfo; scope: Scope;
  instancePath?: string;
}
export interface Binding { name: string; type: Type; node: TypeNode; scope: Scope; uri: string }
export interface Scope { parent?: Scope; uri: string; node: TypeNode; owner?: ClassInfo; fn?: FunctionInfo; bindings: Binding[] }
export interface ClassInfo {
  id: string; name: string; uri: string; node: TypeNode; role?: string;
  baseName?: string; fields: Map<string, Binding>; methods: Map<string, FunctionInfo[]>;
  scope: Scope; defined: boolean;
}
export interface ExpressionResult { guiReceiver?: { owner: ClassInfo; path: string[] }; type: Type; category: ValueCategory; constant?: number | string | boolean; constantExpression?: boolean; unknown?: boolean }
export interface TypeContext {
  resolveMacro?: (name: string, node: TypeNode) => AnalysisMacroDefinition | undefined;
  analysis: AnalyzedDocument; documents: readonly AnalyzedDocument[]; catalog: BuiltinCatalog;
  classes: ClassInfo[]; scopes: Scope[]; functions: FunctionInfo[]; bindings: Binding[];
  aliases: Map<string, Type>; nodeScopes: Map<TypeNode, Scope>; diagnostics: AnalysisDiagnostic[];
  cache: Map<TypeNode, ExpressionResult>;
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
export const numericNames = new Set(['bool','char','unsigned char','short','unsigned short','int','unsigned int','int64','float','double']);
export const isNumeric = (t: Type): boolean => t.kind==='basic' && numericNames.has(t.name);
export const isInteger = (t: Type): boolean => isNumeric(t) && t.name!=='float' && t.name!=='double';
export const role = (t: Type): string | undefined => t.classInfo?.role;
