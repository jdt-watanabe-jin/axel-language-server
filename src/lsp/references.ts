import type { Location } from 'vscode-languageserver/node';
import type { AnalysisLocation } from '../analyzer/navigation';
import { toLspLocations } from './navigation';

export function toLspReferenceLocations(locations: AnalysisLocation[]): Location[] {
  return toLspLocations(locations);
}
