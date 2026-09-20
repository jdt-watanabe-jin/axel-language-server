import type { WorkspaceSymbolSettings } from './model';
export function normalizeWorkspaceSymbolSettings(value: unknown, logError: (message: string) => void = () => undefined): WorkspaceSymbolSettings {
  const settings = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const workspace = settings.workspaceSymbols && typeof settings.workspaceSymbols === 'object'
    ? settings.workspaceSymbols as Record<string, unknown> : {};
  const exclude: string[] = [];
  for (const pattern of Array.isArray(workspace.exclude) ? workspace.exclude : []) {
    if (typeof pattern !== 'string' || !pattern || /^[!/]/.test(pattern) || /[:\\]/.test(pattern)
      || pattern.split('/').some(part => !part || part === '..' || part === '.')) {
      logError(`Invalid workspace symbol exclusion: ${String(pattern)}`);
    } else { exclude.push(pattern); }
  }
  return { exclude: [...new Set(exclude)],
    defines: Array.isArray(settings.defines) ? settings.defines.filter((item): item is string => typeof item === 'string') : [],
    tool: typeof settings.tool === 'string' ? settings.tool : undefined,
    targetPlatform: typeof settings.targetPlatform === 'string' ? settings.targetPlatform : undefined,
    internalFeatures: typeof settings.internalFeatures === 'string' ? settings.internalFeatures : undefined };
}
