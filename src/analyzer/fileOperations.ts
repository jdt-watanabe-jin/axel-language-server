import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { pathToFileURL } from 'url';
import { CancellationToken, LSPErrorCodes, ResponseError, type FileRename, type TextDocumentEdit, type TextEdit, type WorkspaceEdit } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createAxelParser } from './axelParser';
import { resolveInclude } from './includeResolver';
import { ProjectScope, normalizeProjectSettings, fileIdentity, filePath, insideRoot } from './projectScope';
import { cancellationCheckpoint, isCancellationError, throwIfCancelled } from '../util/cancellation';
import type { Settings } from '../lsp/configuration';

interface Include { written: string; range: TextEdit['range']; prefix: string; suffix: string; value: string }
interface RecordEntry { file: string; document: TextDocument; version: number | null; fingerprint: string; includes: Include[] }
interface Move { old: string; next: string; folder: boolean }
class Deadline extends Error {}

/** Physical include index; deliberately independent of symbol visibility/preprocessing. */
export class FileRenameIndex {
  private settings: Settings = {};
  private revision = 0;
  private cache = new Map<string, RecordEntry>();
  constructor(private readonly openDocuments: () => readonly TextDocument[], private readonly log: (message: string) => void, private readonly projectScope = new ProjectScope(log)) {}
  configure(roots: string[], settings: Settings): void {
    this.projectScope.setRoots(roots); this.projectScope.configure(normalizeProjectSettings(settings));
    this.settings = settings; this.revision++;
  }
  invalidate(uris: readonly string[] = []): void {
    this.revision++;
    for (const [key, record] of this.cache) {
      if (uris.some(uri => { const file = filePath(uri); return file && insideRoot(record.file, file); })) { this.cache.delete(key); }
    }
  }
  async warm(token: CancellationToken): Promise<void> {
    const revision = this.revision;
    try { await this.snapshot(token, () => {
      if (revision !== this.revision) { throw new ResponseError(LSPErrorCodes.ContentModified, 'Include index changed.'); }
    }); } catch (error) { if (!isCancellationError(error)) { this.log(`Include index: ${String(error)}`); } }
  }
  private async snapshot(token: CancellationToken, check: () => void): Promise<RecordEntry[]> {
    const opened = this.openDocuments();
    const files = await this.projectScope.collect(token, opened.map(document => document.uri), true);
    check();
    const candidates = new Map<string, { file: string; document?: TextDocument }>();
    for (const file of files.values()) { candidates.set(fileIdentity(file), { file }); }
    for (const document of opened) {
      if (!this.projectScope.contains(document.uri)) { continue; }
      const original = filePath(document.uri); if (!original) { continue; }
      const file = await canonicalPath(original);
      const candidate = candidates.get(fileIdentity(file));
      if (candidate) { candidate.document = document; }
    }
    const result: RecordEntry[] = [];
    for (const [key, candidate] of candidates) {
      await cancellationCheckpoint(token); check();
      const fingerprint = candidate.document ? `open:${candidate.document.version}:${candidate.document.getText()}` : await diskStamp(candidate.file);
      const cached = this.cache.get(key);
      if (cached?.fingerprint === fingerprint && cached.document.uri === (candidate.document?.uri ?? pathToFileURL(candidate.file).toString())) {
        result.push(cached); continue;
      }
      const document = candidate.document ?? TextDocument.create(pathToFileURL(candidate.file).toString(), 'axel', 0,
        await fs.promises.readFile(candidate.file, 'utf8'));
      if (!candidate.document && await diskStamp(candidate.file) !== fingerprint) { throw changed(); }
      const parser = createAxelParser();
      const tree = parser.parse(document.getText());
      const includes: Include[] = [];
      for (const node of tree.rootNode.descendantsOfType('preproc_include')) {
        const operand = node.childForFieldName('path');
        if (!operand || node.hasError) { continue; }
        let malformed = false;
        for (let parent = node.parent; parent; parent = parent.parent) { if (parent.type === 'ERROR') { malformed = true; break; } }
        if (malformed) { continue; }
        const written = operand.text;
        const prefix = written.startsWith('L"') ? 'L"' : written.startsWith('"') ? '"' : written.startsWith('<') ? '<' : '';
        const suffix = prefix === '<' ? '>' : '"';
        if (!prefix || !written.endsWith(suffix)) { continue; }
        includes.push({ written, prefix, suffix, value: written.slice(prefix.length, -1),
          range: { start: document.positionAt(operand.startIndex + prefix.length), end: document.positionAt(operand.endIndex - 1) } });
      }
      const record: RecordEntry = { file: candidate.file, document, version: candidate.document?.version ?? null, fingerprint, includes };
      this.cache.set(key, record); result.push(record);
    }
    for (const key of this.cache.keys()) { if (!candidates.has(key)) { this.cache.delete(key); } }
    return result;
  }
  async getEdits(files: readonly FileRename[], token: CancellationToken, budgetMs = 1_500): Promise<WorkspaceEdit | null> {
    throwIfCancelled(token);
    if ((this.settings.fileOperations as { updateIncludesOnRename?: boolean } | undefined)?.updateIncludesOnRename === false || !files.length) { return null; }
    const revision = this.revision; const scopeRevision = this.projectScope.revision;
    const deadline = performance.now() + budgetMs;
    const check = () => {
      throwIfCancelled(token);
      if (revision !== this.revision || scopeRevision !== this.projectScope.revision) { throw changed(); }
      if (performance.now() >= deadline) { throw new Deadline(); }
    };
    try {
      const moves: Move[] = [];
      for (const file of files) {
        check();
        const original = filePath(file.oldUri); const destination = filePath(file.newUri);
        if (!original || !destination) { continue; }
        const old = await canonicalPath(original); const next = await canonicalPath(destination);
        const stat = await fs.promises.lstat(old);
        if (stat.isSymbolicLink()) { throw new Error('Symbolic-link renames are not edited.'); }
        moves.push({ old, next, folder: stat.isDirectory() });
      }
      if (!moves.length) { return null; }
      const matches = (file: string, root: string, folder: boolean) => folder ? insideRoot(file, root) : fileIdentity(file) === fileIdentity(root);
      for (let i = 0; i < moves.length; i++) {
        const move = moves[i];
        for (const other of moves.slice(i + 1)) {
          if (insideRoot(move.old, other.old) || insideRoot(other.old, move.old)
            || insideRoot(move.next, other.next) || insideRoot(other.next, move.next)) { throw new Error('Overlapping rename batch.'); }
        }
        if (fs.existsSync(move.next) && fileIdentity(move.old) !== fileIdentity(move.next)
          && !moves.some(other => matches(move.next, other.old, other.folder))) {
          // A case-insensitive volume can resolve both spellings to the same file,
          // even on hosts where fileIdentity preserves case (for example macOS).
          const originalStat = await fs.promises.lstat(move.old);
          const destinationStat = await fs.promises.lstat(move.next);
          const sameFile = move.old.toLowerCase() === move.next.toLowerCase()
            && originalStat.dev === destinationStat.dev && originalStat.ino === destinationStat.ino;
          if (!sameFile) { throw new Error('Rename would overwrite an existing file.'); }
        }
      }
      const forward = (file: string) => {
        const move = moves.find(item => matches(file, item.old, item.folder));
        return move ? path.join(move.next, path.relative(move.old, file)) : file;
      };
      const consulted = new Map<string, string>();
      const exists = (file: string): boolean => {
        let stamp = 'missing';
        try { const stat = fs.statSync(file); stamp = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.isFile()}`; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') { throw error; } }
        const previous = consulted.get(file);
        if (previous !== undefined && previous !== stamp) { throw changed(); }
        consulted.set(file, stamp); return stamp.endsWith(':true');
      };
      const futureExists = (file: string): boolean => {
        const destination = moves.find(move => matches(file, move.next, move.folder));
        if (destination) { return exists(path.join(destination.old, path.relative(destination.next, file))); }
        if (moves.some(move => matches(file, move.old, move.folder))) { return false; }
        return exists(file);
      };
      const records = await this.snapshot(token, check);
      const includeRoots = (this.settings.includeRoots ?? []) as string[];
      const changes: TextDocumentEdit[] = [];
      let skipped = 0;
      for (const record of records) {
        await cancellationCheckpoint(token); check();
        const edits: TextEdit[] = [];
        const source = forward(record.file);
        if (!this.projectScope.contains(pathToFileURL(source).toString(), record.document.uri)) { continue; }
        for (const include of record.includes) {
          check();
          const before = resolveInclude({ includingFilePath: record.file, includeText: include.written, includeRoots, fileExists: exists });
          if (before.status !== 'resolved') { skipped++; continue; }
          const target = forward(before.filePath);
          const after = resolveInclude({ includingFilePath: source, includeText: include.written, includeRoots, fileExists: futureExists });
          const caseRename = target !== before.filePath && fileIdentity(target) === fileIdentity(before.filePath);
          if (after.status === 'resolved' && fileIdentity(after.filePath) === fileIdentity(target) && !caseRename) { continue; }
          const bases = include.prefix === '<' ? includeRoots : [path.dirname(source), path.dirname(path.dirname(source)), ...includeRoots];
          let replacement: string | undefined;
          for (const base of bases) {
            const relative = path.relative(base, target);
            if (!relative || path.isAbsolute(relative)) { continue; }
            const separator = include.value.includes('\\') ? '\\' : '/';
            const candidate = relative.split(path.sep).join(separator);
            const resolved = resolveInclude({ includingFilePath: source, includeText: include.prefix + candidate + include.suffix,
              includeRoots, fileExists: futureExists });
            if (resolved.status === 'resolved' && fileIdentity(resolved.filePath) === fileIdentity(target)) { replacement = candidate; break; }
          }
          if (replacement === undefined) { skipped++; }
          else if (replacement !== include.value) { edits.push({ range: include.range, newText: replacement }); }
        }
        if (edits.length) { changes.push({ textDocument: { uri: record.document.uri, version: record.version }, edits }); }
      }
      // Validate even files with no edits: a newly changed source may add a reference.
      const currentOpen = new Map(this.openDocuments().map(document => [document.uri, document]));
      for (const record of records) {
        check();
        const open = currentOpen.get(record.document.uri);
        if (record.version !== null) {
          if (!open || open.version !== record.version || open.getText() !== record.document.getText()) { throw changed(); }
        } else if (open || await diskStamp(record.file) !== record.fingerprint) { throw changed(); }
      }
      for (const file of consulted.keys()) { check(); exists(file); }
      check();
      if (skipped) { this.log(`Include rename: skipped ${skipped} unresolved or unrepresentable literal paths.`); }
      return changes.length ? { documentChanges: changes } : null;
    } catch (error) {
      if (isCancellationError(error)) { throw error; }
      this.log(error instanceof Deadline ? 'Include rename exceeded its time budget.' : `Include rename skipped: ${String(error)}`);
      return null;
    }
  }
}

function changed(): ResponseError<void> { return new ResponseError(LSPErrorCodes.ContentModified, 'Files changed during include rename.'); }
async function diskStamp(file: string): Promise<string> {
  const stat = await fs.promises.stat(file); return `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
}
async function canonicalPath(file: string): Promise<string> {
  const parent = path.dirname(file);
  if (parent === file) { return fs.promises.realpath(file); }
  try { return path.join(await fs.promises.realpath(parent), path.basename(file)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    return path.join(await canonicalPath(parent), path.basename(file));
  }
}