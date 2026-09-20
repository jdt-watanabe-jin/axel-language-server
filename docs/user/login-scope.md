# Startup globals from _login.axl

The server supplies classes, global variables and global functions other than `main` from the selected startup file, including declarations introduced by its transitive includes. No explicit include is required in a subsequent AXEL document.

| Tool | Startup file relative to SXM_HOME |
| --- | --- |
| axel, ismo | `bin/_login.axl` |
| asca | `bin/_asca/_login.axl` |
| spicechart | `bin/_spicechart/_login.axl` |

The client supplies `sxmHome` and `tool` in the `axel` item of the `workspace/configuration` response. An empty `sxmHome` disables startup globals. An omitted home clears the configured home. Each response replaces the complete settings snapshot. The server does not search include roots for a substitute startup file or combine the common and tool-specific startup files.

Completion, hover, definition, references, signature help, semantic tokens and type checking use startup declarations. Class members retain their owning class. Function-local declarations and startup `main` are not exported. Macros and typedef names are not automatically exported; their information can still determine the types of exported declarations. Conditional includes use the startup macro environment independently of subsequent files. Ordinary declarations take precedence over startup declarations. Document symbols continue to describe the document itself.

The real tool executes startup `main`; the language server only analyzes its source. It does not reproduce initialized values or the state of an already-running tool. This feature does not change the language's rules for a missing `main`.

Open, unsaved startup files and headers take precedence over disk content. Closing them restores disk content. Home/tool changes and changes to startup dependencies invalidate consumer results, even when consumer text has not changed. Missing startup files are logged with their paths and do not stop ordinary analysis. Parser recovery preserves declarations that can be analyzed.

The server sends `axel/loginDependencies` notifications containing `{generation, uris}`. The initial list may contain only the startup entry while background indexing runs; the complete list follows after indexing and includes missing include candidates. Each list replaces the previous list, even when its generation is unchanged. Clients must deliver `workspace/didChangeWatchedFiles` for those files, including files outside the workspace. Without this integration, restart the server after external changes. The companion VS Code extension implements these watchers. Startup indexing is cached; initial indexing of a large installation can take several seconds.
