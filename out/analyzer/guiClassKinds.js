"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DIRECT_GUI_BASE_NAMES = void 0;
exports.classifyDirectGuiBase = classifyDirectGuiBase;
exports.isGuiPartTypeName = isGuiPartTypeName;
const DIRECT_GUI_BASE_KINDS = new Map([
    ['GCDialog', 'dialog'],
    ['GCFileDialog', 'fileDialog'],
    ['GCWidget', 'widget'],
    ['GCHBoxLayout', 'guiPart'],
    ['GCVBoxLayout', 'guiPart'],
    ['GCHBox', 'guiPart'],
    ['GCVBox', 'guiPart'],
    ['GCGroupBox', 'guiPart'],
    ['GCButtonGroup', 'guiPart'],
    ['GCTabGroup', 'guiPart']
]);
exports.DIRECT_GUI_BASE_NAMES = Array.from(DIRECT_GUI_BASE_KINDS.keys());
function classifyDirectGuiBase(baseName) {
    return DIRECT_GUI_BASE_KINDS.get(baseName);
}
function isGuiPartTypeName(typeName, knownGuiClassNames = new Set()) {
    return knownGuiClassNames.has(typeName)
        || DIRECT_GUI_BASE_KINDS.has(typeName)
        || /^GC[A-Za-z_$][0-9A-Za-z_$]*$/.test(typeName);
}
//# sourceMappingURL=guiClassKinds.js.map