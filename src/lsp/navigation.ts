import { Location, type Range } from 'vscode-languageserver/node';
import type { AnalysisLocation } from '../analyzer/navigation';
import type { AnalysisRange } from '../types/analysis';

export function toLspLocations(locations: AnalysisLocation[]): Location[] {
  return locations.map((location) => Location.create(location.uri, toLspRange(location.range)));
}

function toLspRange(range: AnalysisRange): Range {
  return {
    start: range.start,
    end: range.end
  };
}
