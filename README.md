# AXEL Language Server

AXEL Language Server is a standalone Language Server Protocol server for AXEL source files.

The package entry point is:

```text
out/server.js
```

## Supported LSP Features

The server currently supports these Language Server Protocol features:

- Text document synchronization for AXEL source files.
- Diagnostics:
  - syntax diagnostics from `tree-sitter-axel`
  - semantic diagnostics for duplicate declarations, unresolved references, unresolved includes, unresolved AXEL execution files, and selected GUI misuse warnings
- Document symbols for functions, variables, typedefs, enums and enum members, class members, macros, includes, GUI parts, and resolved GUI event handlers.
- Hover for declarations, visible references, members, macros, built-ins, include paths, AXEL execution file references, GUI classes, GUI parts, and GUI receiver paths.
- Completion for AXEL declaration keywords, visible symbols, enum members, macros, built-ins, include paths, AXEL execution files, inherited members, `this->` members, static members, GUI parts, and GUI events.
- Go to Definition for local declarations, declarations visible through resolved includes, include paths, AXEL execution files, static members, inherited members, `this->` members, GUI parts, and GUI event handlers.
- Find References for resolved symbol identities across the current document, resolved includes, dependent documents, and forced includes.
- Prepare Rename and Rename for safe resolved symbols, including references in included files when the symbol identity is known.
- Code actions for deterministic missing-include quick fixes.
- Signature help for functions, methods, inherited member calls, `this->` member calls, forced-include functions, function-like macros, dialog-owner methods, and GUI part member calls.
- Semantic tokens for declarations and references, including functions, variables, parameters, types, enum members, macros, member access, method calls, GUI receiver paths, GUI event declarations, and AXEL execution file names.
- Document and range formatting for conservative leading indentation based on structural braces.

Formatting intentionally changes indentation only. It does not rewrite expression spacing, comments, or documents with syntax errors or unbalanced braces.

## Localization

The server uses the client's `initialize.locale`: `ja` and `ja-*` (case insensitive) select Japanese; omitted or other locales use English. Missing translations fall back to their English templates. Locale belongs to the connection and is retained across configuration changes. Reconnect after changing the client's display language.

Localized text includes syntax/semantic/include/execution-file diagnostics, built-in hover and completion documentation, definition origins, macro expansion annotations, path/GUI completion descriptions, and include quick-fix titles. Identifiers, signatures, source comments, paths, edits, and external output remain unchanged. Signature help currently contains only source signatures and parameters. Developer logs remain English.

Translations live in `src/i18n/ja.ts`. `message()` adds structured descriptors to diagnostics while retaining canonical English analysis messages; the LSP adapter formats them for the session locale. `translate()` formats server-owned hover/completion text at presentation time. Keep argument placeholders consistent; do not translate by matching completed diagnostic strings. Compiled dictionaries ship under `out/i18n/`.

See [testing strategy](docs/testing/strategy.md) for localization verification and [change log](CHANGELOG.md) for unreleased changes.

## Development

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
