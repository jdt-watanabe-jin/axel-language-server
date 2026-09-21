# Code Lens

The linked development server provides reference and implementation Code Lens. The extension's published Git dependency remains `v0.1.0`; use a compatible local server and extension build.

Code Lens is disabled by default. Return `{"codeLens":{"enabled":true}}` in the `axel` configuration response. In VS Code, set `axel-extension.languageServer.codeLens.enabled` and enable `editor.codeLens`. The extension setting applies per window, with workspace settings overriding user settings. Both lens kinds share this switch. Disabling clears lenses without a restart or source edit; while disabled, lens requests do not initiate their own analysis or searches.

Functions and methods receive reference lenses. Virtual methods and their overrides also receive implementation lenses. Inactive, uncertain and excluded recovery regions do not produce candidates. Counts are resolved only when requested:

- `references (indexed scope)` uses the existing Find References result with declarations excluded. It counts the current analysis index, not every unopened file in the workspace.
- `implementations (project scope)` uses the existing Go to Implementation result within the shared project include/exclude settings, including eligible unopened files.

Clicking either count opens the standard references view with the corresponding locations. No AXEL script is executed. Unresolved or invalidated results have no command rather than displaying a guessed zero. A completed search with no matches may show zero.

Changes to documents, watched files, settings, workspace folders and background indexing invalidate cached results. The server debounces `workspace/codeLens/refresh` only for clients advertising its refresh capability. Clients without refresh support can explicitly request fresh lenses. See [resolve contracts](../developer/deferred-details.md) for request identities and client integration.
