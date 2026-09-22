# Deferred details and Code Lens

These contracts describe the local development build. They do not update the VS Code extension's pinned Git dependency `v0.1.0`.

## Capability negotiation

| Feature | Client property | Deferred response |
| --- | --- | --- |
| Completion | `textDocument.completion.completionItem.resolveSupport.properties` includes `documentation` and/or `detail` | Only the listed supported properties are omitted initially and restored by `completionItem/resolve`. Other properties remain eager. |
| Inlay hints | `textDocument.inlayHint.resolveSupport.properties` includes `tooltip`, `label.tooltip` and/or `label.location` | Only negotiated fields are filled by `inlayHint/resolve`. Label parts are present initially when their details are deferred. |
| Workspace symbols | `workspace.symbol.resolveSupport.properties` includes `location.range` | Unique candidates initially contain a URI and identity; `workspaceSymbol/resolve` supplies the current range. |
| Code Lens | `workspace.codeLens.refreshSupport` | Allows debounced server requests to refresh displayed lenses. Listing and resolving remain available without refresh support. |

Completion, inlay-hint and workspace-symbol `resolveProvider` capabilities are advertised only when supported properties are negotiated. Code Lens advertises its resolver independently of the default-off setting. Clients without detail negotiation retain eager completion and complete workspace-symbol locations, and the existing name-only inlay hints.

Inlay parameter descriptions are emitted once: `label.tooltip` takes precedence over the hint-level `tooltip`. When `label.location` is negotiated, the tooltip adds the parameter description without repeating the declaration label supplied by the editor's location hover. Without navigation support, it includes the parameter label as well.

## Identity and invalidation

`src/lsp/deferredItems.ts` binds completion and inlay items to bounded server-held snapshots. Client-supplied names or targets do not choose a declaration. Invalid identity data is rejected; source versions, workspace revisions, settings changes and background index invalidation prevent reuse of stale details. Clients receiving `ContentModified` request a new list. Completion resolution does not change labels, filtering, sorting, insertion text or edits. Internal declaration metadata never appears in the protocol payload.

Workspace-symbol identity uses URI, qualified name and kind, excluding coordinates so line insertions can move a declaration. Resolve reconciles open buffers, disk state, project scope and configuration through the existing symbol index. Ambiguous identities, including overloads and duplicate declarations, use eager locations. Deleted, excluded or newly ambiguous selections reject resolution. Unchanged file extraction is reused; resolve does not add a second semantic index.

## Code Lens ownership

`src/analyzer/codeLens.ts` enumerates function/method candidates and virtual relationships. `src/lsp/codeLens.ts` stores candidates and resolved counts, uses existing reference and implementation navigation, and handles refresh/invalidation. The server validates `codeLens.enabled` as a boolean and defaults it to false. Disabled requests skip lens analysis and searches; the setting does not disable other language features.

Resolved lenses use `editor.action.showReferences` with protocol arguments `[uri, position, locations]`. Generic command argument conversion is not supplied by `vscode-languageclient`; the extension's resolve middleware converts this known command to VS Code `Uri`, `Position` and `Location` objects. The extension does not implement a parallel Code Lens provider or language analysis.

Regression coverage lives in `r3DeferredItems.test.ts`, `r3WorkspaceResolve.test.ts` and `r3CodeLens.test.ts`; the extension Host test `r3CodeLens.test.ts` checks live toggling and executes the resulting command. Manual checks belong to the extension's integration checklist.

## Code Action edits

Code Action Resolve requires both `textDocument.codeAction.dataSupport` and `resolveSupport.properties` containing `edit`. Only then is `resolveProvider` advertised and the edit deferred. Other clients keep the eager Quick Fix response. Candidate identification still uses current semantic diagnostics and analyzed declarations; deferring the edit does not defer that analysis or expand the include search scope.

`src/lsp/codeActionResolve.ts` retains up to eight server-held candidate batches. Opaque signed data identifies a candidate. Resolve verifies the document version, workspace revision, cached analysis identity and bound action metadata; background indexing and rebuild clear snapshots. Invalid identities produce `InvalidParams`; changed or evicted candidates produce `ContentModified`, requiring a fresh list. Only the edit is added. Clients supporting `workspace.workspaceEdit.documentChanges` receive a versioned edit so an intervening document change prevents application; other clients receive the existing `changes` shape. No save-time include addition or Will Save handler is registered.

Coverage: `codeActionResolve.test.ts` and the real stdio `r5Editing.test.ts`; the extension's `r5Editing.test.ts` exercises the VS Code provider, explicit edit application, Undo and saving without automatic include additions.
