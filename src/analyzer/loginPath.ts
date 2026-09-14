import * as path from 'path';
import { normalizeTool } from './systemMacros';

export function resolveLoginPath(sxmHome: string | undefined, tool: string | undefined): string | undefined {
  if (!sxmHome?.trim()) { return undefined; }
  const selected = normalizeTool(tool);
  const directory = selected === 'asca' ? '_asca' : selected === 'spicechart' ? '_spicechart' : '';
  return path.join(sxmHome, 'bin', directory, '_login.axl');
}
