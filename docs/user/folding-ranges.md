# Folding ranges

The server advertises `foldingRangeProvider: true` and returns line-based ranges for the original AXEL source. It does not require semantic analysis, include resolution, macro expansion, or GUI type resolution. Inactive and uncertain preprocessor branches remain eligible because folding uses the original syntax tree rather than the conditionally re-parsed analysis tree.

## Supported ranges

The provider folds these constructs when they span enough lines to hide content:

- function, method, constructor, and operator bodies
- `struct`, `class`, `union`, and `enum` bodies
- `if`, `else if`, `else`, `switch`, `for`, `while`, `do ... while`, `try`, and `catch` bodies
- GUI definitions, nested GUI definitions, and attribute or event bodies
- standalone blocks and initializer lists
- block comments, including documentation comments
- conditional preprocessor blocks and their later branches
- multiline object-like and function-like `#define` directives
- matched `#region` / `#endregion` markers

A braced range starts on the opening brace line and ends on the line before the closing brace. This keeps the closing brace and any same-line `else`, `catch`, trailing `while`, semicolon, or following code visible. If the opening brace is on its own line, folding starts there. Unbraced control bodies also fold when their end can be established from the syntax tree.

Block comments start on the `/*` line. Their `*/` line is included unless non-whitespace content follows the delimiter on that line. Regions start on the `#region` line and end before the matched `#endregion` line. Comment ranges use LSP kind `comment`, and region ranges use kind `region` when the client supports those kinds.

For conditional preprocessing, the outer range starts at `#if`, `#ifdef`, or `#ifndef` and ends before its `#endif`. Each later `#elif`, `#elifdef`, `#elifndef`, or `#else` branch also has its own range. The first branch is not returned separately because it would compete with the outer range at the same start line. For example, an `#if` with `#elif` and `#else` returns the outer range and the two later branch ranges.

## Exclusions and malformed source

The provider does not create ranges for:

- `case` or `default` labels themselves; an explicit block below a label still folds
- consecutive `//` comments or backslash-continued line comments
- grouped `#include` or `#using` directives
- argument or parameter lists, parenthesized expressions, or multiline strings
- single-line constructs or ranges with no line to hide

A syntax error does not disable folding for the whole document. A construct is returned when its real opening and closing delimiters can still be confirmed. The server does not extend an unterminated block, comment, conditional directive, or region to the end of the document, and it does not create a range from Tree-sitter `MISSING` delimiters. Valid inner or neighboring ranges remain available.

The compatible parser represents an unclosed `/*` as one named extra node, `unterminated_comment`, spanning from the opener through end of file. It has no closing delimiter and consumes apparent code inside the comment, so fake functions or regions are not recovered from that text. Folding ignores this recovery node. Because Tree-sitter may accept it without setting `root.hasError`, the Language Server recognizes the node explicitly and still reports the `Missing */` diagnostic. Closed comments retain their existing `comment` node shape.

Strings, comments, and macro replacement text are not scanned as if they were separate AXEL source. Apparent braces or region markers inside them do not create extra ranges.

## Ordering and client capabilities

Ranges are sorted by start line and then by outermost end line. For candidates with the same start line, only the outermost range remains. If identical ranges have different kinds, `region` takes precedence over `comment`, followed by an omitted kind. A later range that crosses an earlier range without being contained by it is removed; properly nested ranges remain.

If the client provides `rangeLimit`, the server returns the first ranges from that normalized order. A limit of zero returns no ranges. If the client provides `foldingRangeKind.valueSet`, unsupported `comment` or `region` kinds are omitted from the result without removing the ranges. `startCharacter`, `endCharacter`, `collapsedText`, partial results, and folding refresh notifications are not used.

Requests use the current managed document snapshot, including unsaved edits. Unknown or closed document URIs return an empty list. Existing request cancellation and document-version checks prevent an older result from replacing a newer edit.

## Editor integration

No server-specific command or setting is required. A client such as VS Code uses this provider through its normal folding UI. With VS Code, use the default `editor.foldingStrategy: auto` to receive Language Server ranges. Selecting `indentation` uses VS Code's indentation strategy instead.

The AXEL VS Code extension retains its language-configuration markers for `#region` and `#endregion` as an editor fallback. Fallback ranges are not guaranteed to match the Language Server ranges exactly.

## Architecture

Folding is a syntax-only analysis path. The document analyzer reuses the cached Tree-sitter tree for the original source, and the workspace index exposes those candidates without running semantic analysis or traversing dependencies. The LSP adapter applies client range limits and supported kinds after syntax candidates have been normalized.

## Version compatibility

Complete recovery for unterminated block comments requires both this Language Server implementation and a `tree-sitter-axel` build that provides `unterminated_comment`. Link and build both updated worktrees for local integration.

The Language Server `package.json` still references `tree-sitter-axel#v0.1.0`, and the AXEL VS Code extension `package.json` still references `axel-language-server#v0.1.0`. Those published dependency paths do not include this complete folding implementation until their tags and dependent lockfiles are updated.
