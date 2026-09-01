"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.workspaceIndexOptionsFromEnvironment = workspaceIndexOptionsFromEnvironment;
exports.mergeWorkspaceIndexOptions = mergeWorkspaceIndexOptions;
const path = require("path");
const ENVIRONMENT_PATH_SEPARATOR = ';';
function workspaceIndexOptionsFromEnvironment(environment) {
    return {
        includeRoots: splitPathList(environment.APP_AXELPATH),
        forcedIncludeFiles: splitPathList(environment.SXM_FORCED_INCLUDE_FILES)
    };
}
function mergeWorkspaceIndexOptions(base, overrides) {
    if (!isWorkspaceIndexOptions(overrides)) {
        return base;
    }
    const maxNumberOfProblems = overrides.maxNumberOfProblems ?? base.maxNumberOfProblems;
    return {
        includeRoots: normalizePaths(overrides.includeRoots ?? base.includeRoots ?? []),
        forcedIncludeRoots: normalizePaths(overrides.forcedIncludeRoots ?? base.forcedIncludeRoots ?? []),
        forcedIncludeFiles: normalizeUniquePaths([
            ...(base.forcedIncludeFiles ?? []),
            ...(overrides.forcedIncludeFiles ?? [])
        ]),
        ...(maxNumberOfProblems === undefined ? {} : { maxNumberOfProblems })
    };
}
function splitPathList(value) {
    if (value === undefined || value.trim() === '') {
        return [];
    }
    return normalizePaths(value.split(ENVIRONMENT_PATH_SEPARATOR).filter((entry) => entry.trim() !== ''));
}
function normalizePaths(paths) {
    return paths.map((filePath) => path.normalize(filePath));
}
function normalizeUniquePaths(paths) {
    return Array.from(new Set(normalizePaths(paths)));
}
function isWorkspaceIndexOptions(value) {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const candidate = value;
    return isOptionalStringArray(candidate.includeRoots)
        && isOptionalStringArray(candidate.forcedIncludeRoots)
        && isOptionalStringArray(candidate.forcedIncludeFiles)
        && isOptionalPositiveNumber(candidate.maxNumberOfProblems);
}
function isOptionalStringArray(value) {
    return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}
function isOptionalPositiveNumber(value) {
    return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0);
}
//# sourceMappingURL=workspaceConfig.js.map