"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INCLUDE_NODE_TYPES = exports.TYPE_SPECIFIER_NODE_TYPES = exports.DECLARATION_NODE_TYPES = void 0;
exports.isDeclarationNodeType = isDeclarationNodeType;
exports.isTypeSpecifierNodeType = isTypeSpecifierNodeType;
exports.isIncludeNodeType = isIncludeNodeType;
const DECLARATION_NODE_TYPE_SET = new Set([
    'function_definition',
    'object_definition',
    'type_definition',
    'field_declaration'
]);
const TYPE_SPECIFIER_NODE_TYPE_SET = new Set([
    'class_specifier',
    'struct_specifier',
    'union_specifier',
    'enum_specifier'
]);
const INCLUDE_NODE_TYPE_SET = new Set([
    'preproc_include'
]);
exports.DECLARATION_NODE_TYPES = Array.from(DECLARATION_NODE_TYPE_SET);
exports.TYPE_SPECIFIER_NODE_TYPES = Array.from(TYPE_SPECIFIER_NODE_TYPE_SET);
exports.INCLUDE_NODE_TYPES = Array.from(INCLUDE_NODE_TYPE_SET);
function isDeclarationNodeType(type) {
    return DECLARATION_NODE_TYPE_SET.has(type);
}
function isTypeSpecifierNodeType(type) {
    return TYPE_SPECIFIER_NODE_TYPE_SET.has(type);
}
function isIncludeNodeType(type) {
    return INCLUDE_NODE_TYPE_SET.has(type);
}
//# sourceMappingURL=nodeKinds.js.map