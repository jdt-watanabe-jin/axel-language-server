# Document links

The server advertises `documentLinkProvider: { resolveProvider: true }`. It links literal quoted/angle include paths and the first, unquoted script identifier in an AXEL `@` statement. Script links exclude the `@` and arguments. Syntax from inactive branches is included; comments, strings, macro include operands, dynamic command names and quoted command names are excluded. Existing definitions and these links share the path resolvers in `includeResolver.ts`, including script `.axl` fallback and include-root order.

## Request lifecycle

`DocumentAnalyzer.getDocumentLinksSteps` traverses original syntax cooperatively and caches plain candidates by URI, version and source text. Native syntax views are released. `WorkspaceIndex.resolveDocumentLink` probes the selected path without loading the target, forced includes or login. The LSP adapter has a separate syntax request queue and never flushes pending semantic indexing.

Clients advertising `textDocument.documentLink` receive range/data candidates and resolve targets on demand. LSP has no separate client resolve-support flag for this feature. Clients omitting that capability receive resolved links eagerly; unresolved targets are omitted in that mode. The VS Code language client provides the standard editor links integration.

Resolve data identifies the server session, source URI/version/open generation, configuration generation, candidate index and kind. The server reloads candidates from its own source snapshot and ignores client-supplied targets and ranges. Editing or reopening the source, or changing configuration, rejects stale candidates with ContentModified. Changes to other documents do not invalidate retained links. The global workspace revision still guards in-flight requests against concurrent changes. Targets are checked again on resolution, so deleting a target does not return a cached URI; unresolved results have no target.

No script is executed. There is no new setting: existing include roots control lookup, and VS Code's `editor.links` controls the editor UI. Logs report `lsp.documentLink` and `lsp.documentLinkResolve` durations.

## Verification

- `src/test/integration/features/documentLinks.test.ts`: resolution order, definition parity, absolute scripts, UTF-16 ranges, cancellation and no semantic indexing.
- `src/test/e2e/documentLinks.test.ts`: real stdio capabilities, lazy/eager targets, edits, close/reopen, settings, missing/deleted files, unrelated document changes and invalid resolve data.
- Extension `src/test/host/documentLinks.test.ts`: VS Code's standard link provider resolves include and script targets.

This describes the local source implementation. Published Git dependency pins and VSIX packaging are tracked separately.
