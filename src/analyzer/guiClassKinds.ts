import type { AnalysisGuiClassKind } from '../types/analysis';

const DIRECT_GUI_BASE_KINDS = new Map<string, AnalysisGuiClassKind>([
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

export const DIRECT_GUI_BASE_NAMES = Array.from(DIRECT_GUI_BASE_KINDS.keys());

export function classifyDirectGuiBase(baseName: string): AnalysisGuiClassKind | undefined {
  return DIRECT_GUI_BASE_KINDS.get(baseName);
}

export function isGuiPartTypeName(typeName: string, knownGuiClassNames: ReadonlySet<string> = new Set<string>()): boolean {
  return knownGuiClassNames.has(typeName)
    || DIRECT_GUI_BASE_KINDS.has(typeName)
    || /^GC[A-Za-z_$][0-9A-Za-z_$]*$/.test(typeName);
}
