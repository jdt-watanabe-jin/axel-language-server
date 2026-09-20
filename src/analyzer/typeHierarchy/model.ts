import type { AnalysisRange } from '../../types/analysis';

export interface TypeHierarchyRecord {
  key: string;
  shape: string;
  name: string;
  qualifiedName: string;
  kind: 'class' | 'struct' | 'union';
  uri: string;
  range: AnalysisRange;
  selectionRange: AnalysisRange;
  bases: string[];
  defined: boolean;
}
export interface TypeHierarchyData {
  version: 1;
  key: string;
  sourceUri: string;
  session: string;
}
export interface AnalysisTypeHierarchyItem extends Omit<TypeHierarchyRecord, 'bases' | 'shape' | 'defined'> {
  detail: string;
  data: TypeHierarchyData;
}
