const DECLARATION_NODE_TYPE_SET = new Set<string>([
  'function_definition',
  'object_definition',
  'type_definition',
  'field_declaration'
]);

const TYPE_SPECIFIER_NODE_TYPE_SET = new Set<string>([
  'class_specifier',
  'struct_specifier',
  'union_specifier',
  'enum_specifier'
]);

const INCLUDE_NODE_TYPE_SET = new Set<string>([
  'preproc_include'
]);

export const DECLARATION_NODE_TYPES = Array.from(DECLARATION_NODE_TYPE_SET);
export const TYPE_SPECIFIER_NODE_TYPES = Array.from(TYPE_SPECIFIER_NODE_TYPE_SET);
export const INCLUDE_NODE_TYPES = Array.from(INCLUDE_NODE_TYPE_SET);

export function isDeclarationNodeType(type: string): boolean {
  return DECLARATION_NODE_TYPE_SET.has(type);
}

export function isTypeSpecifierNodeType(type: string): boolean {
  return TYPE_SPECIFIER_NODE_TYPE_SET.has(type);
}

export function isIncludeNodeType(type: string): boolean {
  return INCLUDE_NODE_TYPE_SET.has(type);
}
