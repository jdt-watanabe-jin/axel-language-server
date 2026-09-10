import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

export interface BuiltinCatalog {
  profile?: 'axel-510';
  declarationUris: ReadonlySet<string>;
  /** Keys combine the normalized declaration URI and exact declaration name. */
  rolesByDeclaration: ReadonlyMap<string, string>;
  analysisOnlyMacroUris: ReadonlySet<string>;
  issues?: readonly string[];
}

function filePath(value: string): string {
  return path.resolve(value.startsWith('file:') ? fileURLToPath(value) : value);
}
function fileUri(value: string): string {
  return pathToFileURL(filePath(value)).toString();
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function declarationFile(root: string, relative: unknown): string {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
      || path.win32.isAbsolute(relative) || relative.includes(':')) {
    throw new Error('Declaration paths must be relative files');
  }
  const resolved = path.resolve(root, relative);
  if (!contained(root, resolved) || !fs.statSync(resolved).isFile()
      || !contained(fs.realpathSync(root), fs.realpathSync(resolved))) {
    throw new Error('Declaration file is outside the manifest directory or is not a file');
  }
  return fileUri(resolved);
}

/** Only explicit entry companions grant builtin provenance; includes are not walked. */
export function loadBuiltinCatalog(entryUrisOrPaths: readonly string[]): BuiltinCatalog {
  const declarationUris = new Set<string>();
  const rolesByDeclaration = new Map<string, string>();
  const analysisOnlyMacroUris = new Set<string>();
  const issues: string[] = [];
  let profile: 'axel-510' | undefined;
  for (const entry of new Set(entryUrisOrPaths)) {
    try {
      const entryPath = filePath(entry);
      const extension = path.extname(entryPath);
      const manifestPath = `${extension ? entryPath.slice(0, -extension.length) : entryPath}.analysis.json`;
      if (!fs.existsSync(manifestPath)) { continue; }
      if (!fs.statSync(entryPath).isFile()) { throw new Error('Entry is not a file'); }
      const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
      if (!record(manifest) || manifest.schemaVersion !== 1 || manifest.profile !== 'axel-510'
          || !Array.isArray(manifest.declarationFiles) || !record(manifest.types)
          || !Array.isArray(manifest.analysisOnlyMacros)
          || manifest.analysisOnlyMacros.some(name => name !== 'NULL')) {
        throw new Error('Unsupported or invalid builtin manifest');
      }
      const root = path.dirname(manifestPath);
      const listed = new Set(manifest.declarationFiles.map(relative => declarationFile(root, relative)));
      const roles = new Map<string, string>();
      for (const [role, binding] of Object.entries(manifest.types)) {
        const relative = typeof binding === 'string' ? binding : record(binding) ? binding.file : undefined;
        const name = typeof binding === 'string' ? role : record(binding) ? binding.name : undefined;
        if (!role || typeof name !== 'string' || !/^[A-Za-z_]\w*$/.test(name)) {
          throw new Error('Invalid builtin type binding');
        }
        const uri = declarationFile(root, relative);
        if (!listed.has(uri)) { throw new Error('Builtin type binding is not in declarationFiles'); }
        const key = `${uri}#${name}`;
        if ((roles.has(key) && roles.get(key) !== role)
            || (rolesByDeclaration.has(key) && rolesByDeclaration.get(key) !== role)) {
          throw new Error('Conflicting builtin type bindings');
        }
        roles.set(key, role);
      }
      // Publish a manifest only after every path and binding has been validated.
      for (const uri of listed) { declarationUris.add(uri); }
      for (const [key, role] of roles) { rolesByDeclaration.set(key, role); }
      if (manifest.analysisOnlyMacros.includes('NULL')) {
        analysisOnlyMacroUris.add(fileUri(entryPath));
        for (const uri of listed) { analysisOnlyMacroUris.add(uri); }
      }
      profile = 'axel-510';
    } catch (error) {
      issues.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { profile, declarationUris, rolesByDeclaration, analysisOnlyMacroUris, issues };
}

export function builtinRole(catalog: BuiltinCatalog, uri: string, name: string): string | undefined {
  try { return catalog.rolesByDeclaration.get(`${fileUri(uri)}#${name}`); } catch { return undefined; }
}
export function isBuiltinDeclarationSource(catalog: BuiltinCatalog, uri: string): boolean {
  try { return catalog.declarationUris.has(fileUri(uri)); } catch { return false; }
}
