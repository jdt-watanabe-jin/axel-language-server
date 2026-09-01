"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectForcedIncludeFiles = collectForcedIncludeFiles;
exports.isAxelSourceFile = isAxelSourceFile;
const fs = require("fs");
const path = require("path");
const AXEL_SOURCE_EXTENSIONS = new Set(['.axl', '.h', '.hh']);
function collectForcedIncludeFiles(options) {
    const files = new Set();
    for (const filePath of options.forcedIncludeFiles ?? []) {
        const normalized = path.normalize(filePath);
        if (isAxelSourceFile(normalized) && fs.existsSync(normalized)) {
            files.add(normalized);
        }
    }
    for (const root of options.forcedIncludeRoots ?? []) {
        for (const filePath of collectAxelSourceFiles(root)) {
            files.add(filePath);
        }
    }
    return Array.from(files).sort();
}
function isAxelSourceFile(filePath) {
    return AXEL_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
function collectAxelSourceFiles(root) {
    const normalizedRoot = path.normalize(root);
    if (!fs.existsSync(normalizedRoot)) {
        return [];
    }
    const stat = fs.statSync(normalizedRoot);
    if (stat.isFile()) {
        return isAxelSourceFile(normalizedRoot) ? [normalizedRoot] : [];
    }
    if (!stat.isDirectory()) {
        return [];
    }
    const files = [];
    for (const entry of fs.readdirSync(normalizedRoot, { withFileTypes: true })) {
        const entryPath = path.join(normalizedRoot, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectAxelSourceFiles(entryPath));
        }
        else if (entry.isFile() && isAxelSourceFile(entryPath)) {
            files.push(path.normalize(entryPath));
        }
    }
    return files;
}
//# sourceMappingURL=forcedIncludes.js.map