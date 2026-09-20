import { normalizeProjectSettings } from '../projectScope';
import type { WorkspaceSymbolSettings } from './model';
export function normalizeWorkspaceSymbolSettings(value: unknown): WorkspaceSymbolSettings {
  const settings = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { project: normalizeProjectSettings(value),
    defines: Array.isArray(settings.defines) ? settings.defines.filter((item): item is string => typeof item === 'string') : [],
    tool: typeof settings.tool === 'string' ? settings.tool : undefined,
    targetPlatform: typeof settings.targetPlatform === 'string' ? settings.targetPlatform : undefined,
    internalFeatures: typeof settings.internalFeatures === 'string' ? settings.internalFeatures : undefined };
}
