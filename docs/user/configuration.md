# Configuration acquisition

Clients must advertise `workspace.configuration: true`. After `initialized`, the server sends `workspace/configuration` with `{"items":[{"section":"axel"}]}` and no `scopeUri`. Return an array containing exactly one settings object. Settings are shared by the connection.

Each response replaces the complete snapshot. Omitted known properties select their defaults; arrays replace previous arrays. Unknown properties are ignored. Invalid known values, null responses, transport errors and a 5-second timeout make configuration unavailable. Language requests return `RequestFailed` until a later successful acquisition; background analysis pauses while configuration is unavailable. Open-document synchronization continues, including unsaved edits. Cancellation of a waiting language request returns `RequestCancelled` without cancelling shared configuration acquisition.

Send `workspace/didChangeConfiguration` with `{"settings":null}` to trigger acquisition again. Its payload is never applied. The server registers this notification dynamically when supported; otherwise the client sends it through its existing integration. Overlapping notifications discard obsolete responses and acquire the latest snapshot. Unchanged effective settings do not rebuild document analysis. Project scope and file-operation settings invalidate their candidate indexes without discarding analysis needed by open documents and dependencies.

There is no compatibility path through initialization options, notification settings, environment variables or a last-known-good snapshot. A client without configuration support is rejected at initialization. The VS Code extension must be updated together with the server.

`codeLens: { "enabled": true }` enables both reference and implementation lenses. The default is `false`; non-boolean `enabled` values reject the snapshot. Changes apply without restarting. See [Code Lens](code-lens.md) for scope and client refresh requirements.

The object supports `includeRoots`, `forcedIncludeRoots`, `forcedIncludeFiles`, `defines` (string arrays, default empty), `sxmHome` (default empty), `tool` (default `axel`), `targetPlatform` (default `windows-x64`), `internalFeatures` (default `enabled`), and optional positive `maxNumberOfProblems` (default unlimited). Presentation settings are `hover` and `autocomplete` (default `default`), `errorSquiggles` (default `enabledIfIncludesResolve`), [inlayHints](inlay-hints.md), [fileOperations](file-operations.md). Project collection is configured by `project.include` (default `["**/*"]`) and `project.exclude` (default `[]`); see [workspace symbols](workspace-symbols.md).

`workspaceSymbols.exclude` and `fileOperations.exclude` have been removed. Their presence, even as an empty array or alongside `project`, rejects the entire snapshot. Remove both old keys and choose one shared project scope. Settings apply after successful acquisition without restarting.

## Recovering from configuration failures

A failed acquisition offers **Retry** and **Open Settings** through a server message request. Retry requests a new snapshot; Open Settings asks the extension to show AXEL settings through `axel/openSettings`. Dismissing the prompt leaves configuration unavailable. Correcting settings and sending the ordinary change notification also recovers without restarting. Repeated failures in the same generation are deduplicated, and actions from obsolete prompts are ignored.

These recovery actions require the linked development server. See [operations and progress](../developer/r4-operations.md) for the protocol contract and dependency status.
