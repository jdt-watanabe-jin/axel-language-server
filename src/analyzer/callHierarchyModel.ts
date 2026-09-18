import type { AnalysisRange, AnalysisSymbolKind } from '../types/analysis';

export interface AnalysisCallHierarchyItem {
  name: string;
  kind: AnalysisSymbolKind | 'file';
  detail?: string;
  uri: string;
  range: AnalysisRange;
  selectionRange: AnalysisRange;
  data: { key: string; sourceUri: string };
}

export interface AnalysisCallHierarchyCall {
  item: AnalysisCallHierarchyItem;
  fromRanges: AnalysisRange[];
}
