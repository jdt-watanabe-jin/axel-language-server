# Server operations and progress

These capabilities are available in the linked development server. They do not change the VS Code extension's pinned `v0.1.0` server dependency or the parser dependency.

## Execute Command

`executeCommandProvider.commands` advertises the following allowlist. Unknown commands and malformed arguments return `InvalidParams`. Commands support request cancellation.

| Command | `arguments` | Result and scope |
| --- | --- | --- |
| `axel.rebuildIndex` | Omitted or `[]` | Recollects workspace folders when supported, rebuilds workspace symbols, and rebuilds open-document/dependency analysis. Returns `{ "rebuilt": true, "documents": <open-document count> }`. Unsaved buffers remain authoritative. |
| `axel.applyQuickFix` | `[{ "uri": "file:///…/main.axl", "position": { "line": 0, "character": 0 } }]` | Applies one unambiguous existing missing-include fix at the position in an open AXEL document. Returns the client's `{ "applied": boolean, "failureReason"?: string }` result, or `applied: false` with a reason when no safe fix is available. |
| `axel.showSource` | `[{ "uri": "file:///…/main.axl", "position": { "line": 0, "character": 0 } }]` | Opens the supplied source destination. `range` can replace `position`; both are optional. Returns `{ "success": boolean, "uri": string, "range"?: Range }`. This is a source-opening utility, not definition resolution or macro expansion. |

Positions use zero-based UTF-16 coordinates. Source commands require local `file:` URIs without a remote authority, query, or fragment. Show Source accepts an open document or an existing local file, requests `external: false`, and validates selections against open buffers.

Quick Fix reuses the ordinary Code Action algorithm. Its candidates come from the existing semantic index: open documents and already indexed dependencies. A type in an unopened header appearing in workspace-symbol search alone is not a candidate. Rebuild does not semantically analyze every unrelated unopened workspace file. Multiple candidates or fixes are not chosen automatically.

## Applying edits and opening documents

Quick Fix requires both `workspace.applyEdit` and `workspace.workspaceEdit.documentChanges`. It sends one versioned `TextDocumentEdit` through `workspace/applyEdit`. URI, version, source text and workspace generation are checked before dispatch. Document changes during preparation return `ContentModified`; the client must retry against current content.

Edit preparation runs in the analysis request queue. The client request is dispatched after leaving the queue, with a final freshness check immediately before sending. A `didChange` caused by the accepted edit must not invalidate the successful result. The server does not predictively mutate source text or analysis caches; normal document synchronization supplies the new content. A rejected edit retains the client's failure result.

Show Source uses `window/showDocument` only when `window.showDocument.support` is advertised. Unsupported clients receive the destination with `success: false` and can open it through their own UI. A client failure is likewise returned without claiming that navigation succeeded.

## Recovery actions

Configuration acquisition failures and explicit rebuild failures can send `window/showMessageRequest` with **Retry** and **Open Settings**. Retry reacquires configuration or repeats the rebuild. Open Settings sends the custom notification `axel/openSettings` with `{ "section": "axel" }`; the extension implements the editor UI action.

Prompts are deduplicated by error category and workspace generation. Responses are ignored after recovery, a generation change, or shutdown. Dismissal does not repeatedly reopen the same error prompt. Configuration remains unavailable until successful reacquisition; no previous settings snapshot is silently restored.

## Work progress and cancellation

Progress is delayed by one second and requires `window.workDoneProgress`. Fast operations finish without displaying progress. Long operations cover document/dependency analysis, workspace indexing and search, type hierarchy, and server commands. The server creates a token using `window/workDoneProgress/create` only when the request did not supply `workDoneToken`. Existing tokens are preserved by registering the underlying protocol request before the language-server library consumes them.

Overlapping ordinary document/dependency analysis uses one shared display; workspace-symbol work has its own group. Requests carrying an explicit token retain that token. Cancelling an individual request cancels that waiter without cancelling other members. `window/workDoneProgress/cancel` cancels all members represented by that display, including corresponding background indexing. Work checks cancellation cooperatively, closes visible progress on completion/failure/cancellation, and cancels outstanding groups on shutdown. Unsupported progress does not prevent language operations.

Workspace-folder recollection occurs at explicit rebuild when the client advertises `workspace.workspaceFolders`. A folder-change notification arriving during recollection takes precedence over the stale response. Unsupported clients retain their initialized roots. Configuration and shared project exclusions continue to govern collection.

## Verification entry points

The focused tests include `src/test/unit/r4Operations.test.ts`, `r4WorkProgress.test.ts`, and `r4TypeHierarchyProgress.test.ts`. Existing hierarchy integration tests exercise unchanged semantic results. These are test entry points, not a claim that every suite or client version has been run.
