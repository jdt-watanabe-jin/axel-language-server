# AXEL Language Server

Performance development: [architecture, benchmarks and profiling](docs/developer/performance.md).

Startup language support: [shared globals from _login.axl](docs/user/login-scope.md).

AXEL Language Server is a standalone Language Server Protocol server for AXEL source files.

The package entry point is:

```text
out/server.js
```

## Supported LSP Features

The server currently supports these Language Server Protocol features:

- Workspace symbols across open and unopened AXEL files, with live exclusions, background indexing and cancellation. See [workspace symbols](docs/user/workspace-symbols.md) for scope, settings and navigation behavior.
- Text document synchronization for AXEL source files.
- Diagnostics:
  - syntax diagnostics from `tree-sitter-axel`
  - type diagnostics for the verified AXEL 510 runtime profile; see the [type-checking guide](docs/user/type-checking.md) for registration and limits
  - semantic diagnostics for duplicate declarations, unresolved references, unresolved includes, unresolved AXEL execution files, and selected GUI misuse warnings
- Document symbols for functions, variables, typedefs, enums and enum members, class members, macros, includes, GUI parts, and resolved GUI event handlers. See [document symbols](docs/user/document-symbols.md) for external method grouping and navigation limits.
- Hover for declarations, visible references, members, macros, built-ins, include paths, AXEL execution file references, GUI classes, GUI parts, and GUI receiver paths.
- Completion for AXEL declaration keywords, visible symbols, enum members, macros, built-ins, include paths, AXEL execution files, inherited members, `this->` members, static members, GUI parts, and GUI events.
- Go to Definition for local declarations, declarations visible through resolved includes, include paths, AXEL execution files, static members, inherited members, `this->` members, GUI parts, and GUI event handlers.
- Go to Declaration, Type Definition and Implementation, plus syntax-based Selection Range. See [navigation and selection](docs/user/navigation.md) for typedef traversal, virtual overrides, project scope and limits.
- Document Link and lazy resolve for literal include paths and @ script calls. See [document links](docs/developer/document-links.md) for scope, lifecycle and tests.
- Find References for resolved symbol identities across the current document, resolved includes, dependent documents, and forced includes.
- Document highlights for the same resolved symbol within the requesting document, classified as Text, Read, or Write. See the [document highlight guide](docs/developer/document-highlights.md) for request behavior and testing.
- Call Hierarchy for resolved calls and unambiguous function references, with incoming and outgoing exploration across the current analysis index. See the [call hierarchy implementation guide](docs/developer/call-hierarchy.md) for ownership, virtual dispatch, caching, and limits.
- Type Hierarchy from type and variable names, with direct base types and derived types across unopened project files. See [type hierarchy](docs/user/type-hierarchy.md) for supported targets and [implementation](docs/developer/type-hierarchy.md) for resolution, indexing and cancellation.
- Prepare Rename and Rename for safe resolved symbols, including references in included files when the symbol identity is known.
- Code actions for deterministic missing-include quick fixes.
- Explicit index rebuilding, versioned Quick Fix application, source opening, recovery actions and delayed cancellable progress. See [server operations](docs/developer/r4-operations.md) for arguments, client capabilities and linked-development availability.
- Lazy completion, inlay-hint and workspace-symbol details, plus opt-in reference and implementation Code Lens. See [Code Lens](docs/user/code-lens.md) and [resolve contracts](docs/developer/deferred-details.md). These features require the linked development build; the extension's pinned `v0.1.0` dependency is not updated.
- Parameter-name inlay hints for resolved function and method arguments, disabled by default. See [inlay hints](docs/user/inlay-hints.md) for configuration, suppression, overloads and source mapping.
- Signature help for functions, methods, inherited member calls, `this->` member calls, forced-include functions, function-like macros, dialog-owner methods, and GUI part member calls.
- Semantic tokens for declarations and references, including functions, variables, parameters, types, enum members, macros, member access, method calls, GUI receiver paths, GUI event declarations, and AXEL execution file names.
- Document and range formatting for conservative leading indentation based on structural braces.
- Syntax-based folding ranges for AXEL bodies, block comments, preprocessor branches and macros, and regions. See the [folding ranges guide](docs/user/folding-ranges.md) for boundaries and exclusions.

Functions and methods can be resolved before their declaration or definition within their owning scope. Hover, definition navigation, references, completion, and signature help use this lookup; variables retain their declaration-order visibility and normal scope shadowing.

Formatting intentionally changes indentation only. It does not rewrite expression spacing, comments, or documents with syntax errors or unbalanced braces.

Leading Doxygen comments can provide structured documentation for hover, completion, and signature help. See the [Doxygen comments guide](docs/user/doxygen-comments.md) for supported forms, commands, binding rules, and limits.

See [configuration acquisition](docs/user/configuration.md), [capability negotiation](docs/developer/protocol-compatibility.md), and [file operations and include renaming](docs/user/file-operations.md) for the client contract.

## System-defined macros

Return `tool` in the `axel` item of the `workspace/configuration` response (see [configuration](docs/user/configuration.md)):

```json
{ "tool": "ismo" }
```

Accepted values are `axel`, `ismo`, `asca`, and `spicechart`. Omitted values select `axel`; invalid values reject the configuration snapshot. Changing the configuration invalidates analysis and refreshes diagnostics, inactive ranges, and semantic tokens without restarting the server.

`__AXEL__` is always defined as the integer `1`, regardless of Tool. `__AXELVERSION__` is always defined as the integer `510`, preserving the former IntelliSense header value; no header include is required.

`__FILE__` is the absolute source path and `__LINE__` is the one-based source line. In a function-like macro body, the expansion uses the invocation location; tokens written in arguments keep their original locations. Strings and comments are not substituted.

`__DATE__`, `__TIME__`, and `__TIMESTAMP__` are defined string macros whose runtime formats are `yy/mm/dd`, `hh:mm:ss`, and `yy/mm/dd hh:mm:ss`. Hover explains that their values are unavailable while editing; expansion leaves these names symbolic. The server never substitutes its current time or a file modification time.

`__AXELCONSOLE__` is always defined as an integer: `1` for Tool `axel`, and `0` for every other supported Tool. Its value follows Tool configuration changes without a document edit or server restart.

`__AXEL_INTERNAL__` is always defined as an integer. Pass `internalFeatures` in the `axel` configuration response: `enabled` selects `1`, and `disabled` selects `0`. Omitted values select `enabled`; invalid values reject the configuration snapshot. Changes refresh analysis without editing the document or restarting the server. Use `#if __AXEL_INTERNAL__` to select a branch by value; `#ifdef __AXEL_INTERNAL__` is true for both settings.

Tool `ismo` defines only `__APP_LEDIT__=1`, `asca` defines only `__APP_SEDIT__=1`, and `spicechart` defines only `__APP_SCHART__=1`. Tool `axel` defines none of these application macros. A non-selected macro is undefined, not defined as zero.

The twenty-three names are reserved by analysis: explicit `defines`, source definitions, and `#undef` cannot change them. Source mutations produce warnings; configuration attempts are logged. These source-position and reservation rules are the current analysis policy; compatibility with every proprietary runtime version has not been verified.

Hover, completion, diagnostics, and conditional evaluation share these definitions. System macros have no source definition or rename target, and no references list or function signature. Unknown runtime conditions retain possible branches instead of marking one inactive. Uncertain declarations are not treated as definitely visible; diagnostics depending only on their uncertainty are suppressed. Correlations between separate unknown branches are not evaluated.

### Target platform

Pass `targetPlatform` alongside `tool` in the `axel` configuration response. It selects the analysis target independently of the server host and Tool; it does not change the execution environment. Omitted values select `windows-x64`; invalid values reject the configuration snapshot. Changes invalidate document and include analysis and refresh diagnostics, inactive ranges, and semantic tokens without a restart.

| Value | OS | CPU | Pointer bytes |
| --- | --- | --- | --- |
| `windows-x86` | Windows | x86 | 4 |
| `windows-x64` | Windows | x86_64 | 8 |
| `linux-x86` | Linux | x86 | 4 |
| `linux-x64` | Linux | x86_64 | 8 |
| `solaris-x86` | Solaris | x86 | 4 |
| `solaris-x64` | Solaris | x86_64 | 8 |
| `solaris-sparc32` | Solaris | SPARC | 4 |
| `solaris-sparc64` | Solaris | SPARC | 8 |
| `hpux-hppa32` | HP-UX | HPPA | 4 |
| `hpux-hppa64` | HP-UX | HPPA | 8 |

The platform macros are always defined integers, including those whose value is zero:

- `__OS_WINDOWS__`, `__OS_LINUX__`, `__OS_SOLARIS__`, `__OS_HPUX__`: selected OS is 1, others are 0.
- `__OS_UNIX__`: 0 on Windows, 1 otherwise.
- `__CPU_x86__`, `__CPU_x86_64__`, `__CPU_HPPA__`, `__CPU_SPARC__`: selected CPU is 1, others are 0.
- `__OS_32bit__`, `__OS_64bit__`: selected pointer size is 1, the other is 0.

No helper header is required. These are reserved system macros; use `#if` to test their value, since `#ifdef` is always true. The mapping is maintained in `src/analyzer/targetPlatform.ts`; keep extension setting choices consistent when adding platforms.
## Localization

The server uses the client's `initialize.locale`: `ja` and `ja-*` (case insensitive) select Japanese; omitted or other locales use English. Missing translations fall back to their English templates. Locale belongs to the connection and is retained across configuration changes. Reconnect after changing the client's display language.

Localized text includes syntax/semantic/include/execution-file diagnostics, built-in hover and completion documentation, generated Doxygen section headings, definition origins, macro expansion annotations, path/GUI completion descriptions, and include quick-fix titles. Identifiers, signatures, source comments, paths, edits, and external output remain unchanged. Doxygen parameter descriptions are also available in signature help. Developer logs remain English.

Translations live in `src/i18n/ja.ts`. `message()` adds structured descriptors to diagnostics while retaining canonical English analysis messages; the LSP adapter formats them for the session locale. `translate()` formats server-owned hover/completion text at presentation time. Keep argument placeholders consistent; do not translate by matching completed diagnostic strings. Compiled dictionaries ship under `out/i18n/`.

See [testing strategy](docs/testing/strategy.md) for localization verification.

## Development

See [initial analysis performance](docs/developer/startup-performance.md) for reproducible real-workspace measurements.

See [request cancellation and cooperative analysis](docs/developer/cancellation.md) for cancellation errors, asynchronous execution, cache consistency, and limitations.

See [type-checking architecture and verification](docs/developer/type-checking.md) for the type model, builtin registration, corpus, and optional runtime tests.

Install dependencies:

```sh
npm install
```

Build:

```sh
npm run build
```

Run tests:

```sh
npm test
```

Run lint:

```sh
npm run lint
```

### Hover and completion settings

Pass `hover` and `autocomplete` at the top level of the `axel` configuration response. Each accepts `"default"` (enabled, the default) or `"disabled"`. A disabled hover returns `null`; disabled completion returns an empty list, including manually requested completion. Other language features remain enabled. Changes apply to subsequent requests without restarting, and omitted values select `"default"`; invalid values reject the configuration snapshot. These settings do not control snippets or word suggestions supplied by the editor.

### Diagnostic display settings

Pass `errorSquiggles` alongside `hover` and `autocomplete` in the `axel` configuration response. It accepts `enabled`, `disabled`, and `enabledIfIncludesResolve` (the default for omitted values). `disabled` returns an empty full diagnostic report, clearing errors and warnings in both editor squiggles and the Problems panel. It does not disable parsing or other language features. `enabled` returns normal diagnostics regardless of missing includes.

`enabledIfIncludesResolve` checks each document independently, including transitive and forced includes, using parsed syntax and the existing include resolver. Inactive includes are excluded. If an include cannot resolve, only include-resolution errors are returned; errors in a nested include are anchored at the requesting document遯ｶ蜀ｱ include, and forced-include errors at its start. Unsupported include expressions also count as unresolved. LSP diagnostic requests wait for the required dependency analysis; the synchronous diagnostic API can still return provisional results while background indexing is pending. Missing-header candidates are tracked so file creation/deletion and include-path changes trigger re-evaluation without a source edit. Configuration changes request a diagnostic refresh without restarting the server.
