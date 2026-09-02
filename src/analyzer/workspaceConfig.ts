import * as path from 'path';
import type { WorkspaceIndexOptions } from './workspaceIndex';

const ENVIRONMENT_PATH_SEPARATOR = ';';

interface AxelEnvironment {
  APP_AXELPATH?: string;
  SXM_FORCED_INCLUDE_FILES?: string;
}

export function workspaceIndexOptionsFromEnvironment(environment: AxelEnvironment): WorkspaceIndexOptions {
  return {
    includeRoots: splitPathList(environment.APP_AXELPATH),
    forcedIncludeFiles: splitPathList(environment.SXM_FORCED_INCLUDE_FILES)
  };
}

export function mergeWorkspaceIndexOptions(
  base: WorkspaceIndexOptions,
  overrides: unknown
): WorkspaceIndexOptions {
  if (!isWorkspaceIndexOptions(overrides)) {
    return base;
  }

  const maxNumberOfProblems = overrides.maxNumberOfProblems ?? base.maxNumberOfProblems;
  const defines = overrides.defines ?? base.defines;
  return {
    includeRoots: normalizePaths(overrides.includeRoots ?? base.includeRoots ?? []),
    forcedIncludeRoots: normalizePaths(overrides.forcedIncludeRoots ?? base.forcedIncludeRoots ?? []),
    forcedIncludeFiles: normalizeUniquePaths([
      ...(base.forcedIncludeFiles ?? []),
      ...(overrides.forcedIncludeFiles ?? [])
    ]),
    ...(defines === undefined ? {} : { defines }),
    ...(maxNumberOfProblems === undefined ? {} : { maxNumberOfProblems })
  };
}

function splitPathList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') {
    return [];
  }

  return normalizePaths(value.split(ENVIRONMENT_PATH_SEPARATOR).filter((entry) => entry.trim() !== ''));
}

function normalizePaths(paths: string[]): string[] {
  return paths.map((filePath) => path.normalize(filePath));
}

function normalizeUniquePaths(paths: string[]): string[] {
  return Array.from(new Set(normalizePaths(paths)));
}

function isWorkspaceIndexOptions(value: unknown): value is WorkspaceIndexOptions {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return isOptionalStringArray(candidate.includeRoots)
    && isOptionalStringArray(candidate.forcedIncludeRoots)
    && isOptionalStringArray(candidate.forcedIncludeFiles)
    && isOptionalStringArray(candidate.defines)
    && isOptionalPositiveNumber(candidate.maxNumberOfProblems);
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function isOptionalPositiveNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0);
}
