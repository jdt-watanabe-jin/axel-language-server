# File operations

The server advertises the supported client capabilities for `workspace/willCreateFiles`, `didCreateFiles`, `willRenameFiles`, `didRenameFiles`, `willDeleteFiles`, and `didDeleteFiles`, with `file:` / `**/*` filters. Folder events are included. `willCreateFiles` and `willDeleteFiles` return null and do not create templates or remove references.

The three did notifications invalidate document and dependency analysis, startup declarations, workspace symbols and the include index. Deleted directory descendants are found from cached paths. Missing and higher-priority include candidates and new forced headers are considered. Watcher notifications remain supported. Open unsaved text continues to belong to document synchronization; a did notification does not manufacture document opens, closes or URI moves.

`willRenameFiles` can return `WorkspaceEdit.documentChanges` when the client supports it. Apply text edits to the old document URIs before moving files. Open documents carry their current version; closed documents carry null. The server does not perform filesystem moves.

The include index scans `.axl`, `.h`, and `.hh` source files under workspace folders, or open files when there are no folders. Unsaved contents take precedence. It extracts literal quoted, wide-quoted and angle includes from the original syntax tree, including inactive branches. Macro-generated paths, damaged includes and unresolved targets are skipped. Source and target moves are mapped simultaneously, and proposed paths must still resolve to the intended target under the existing include search order. Ambiguous moves, conflicting destinations, source changes, unreadable scan inputs and incomplete scans do not produce partial edits. The cooperative budget is 1,500 ms; expiration returns null, while explicit cancellation returns `RequestCancelled`.

The `axel` configuration object accepts:

```json
{"fileOperations":{"updateIncludesOnRename":true,"exclude":[]}}
```

`updateIncludesOnRename` defaults to true. `exclude` defaults to an empty array and only excludes source files from automatic edits. It is independent of workspace-symbol exclusions. Patterns are root-relative, use `/`, and support `*`, `?`, and `**`; absolute paths, `..`, negative patterns and empty patterns are invalid. `.git` and symlinks below roots are not scanned. External include roots are lookup locations, not extra editing roots. Changes take effect after configuration acquisition without restarting.
