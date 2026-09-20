import type { AnalysisRange, AnalysisSymbolKind } from '../../types/analysis';
export interface WorkspaceSymbolEntry {
  name: string;
  qualifiedName: string;
  containerName?: string;
  kind: AnalysisSymbolKind;
  uri: string;
  selectionRange: AnalysisRange;
}
export interface WorkspaceSymbolSettings {
  exclude: string[];
  defines: string[];
  tool?: string;
  targetPlatform?: string;
  internalFeatures?: string;
}
