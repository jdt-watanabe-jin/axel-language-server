# Doxygen comments

The Language Server reads Doxygen-style source comments and presents their content in hover, completion details, and signature help. It parses the source itself and does not run Doxygen or read a Doxyfile at runtime.

## Comment forms

The supported leading documentation forms are:

```cpp
/*! block documentation */
/** Javadoc-style block documentation */

/// line documentation
//! line documentation
```

Consecutive documentation line comments form one block. A line containing only the documentation prefix is a blank line within that block; a source blank line ends it. Decorative leading `*` characters in block comments are optional. Body blank lines, meaningful indentation, and Markdown markers are retained.

Ordinary `/* ... */` and `// ...` comments keep their existing literal-description behavior; Doxygen commands inside them are not interpreted. `/*** ... */` is not unconditionally treated as Javadoc documentation. Trailing forms such as `/*!<`, `/**<`, `//!<`, and `///<` are outside the initial support and are not attached to the following declaration.

## Commands

The following 18 named commands are structured. The table uses `@`, and each command also accepts the equivalent backslash spelling.

| Command | Behavior |
| --- | --- |
| `@brief` | Adds a summary. Repeated summaries remain in source order. |
| `@details` | Adds detailed text. Repeated sections remain in source order. Ordinary paragraphs after a blank line also become details. |
| `@param` | Describes one or more parameters, optionally with an input/output direction. |
| `@return`, `@returns`, `@result` | Equivalent spellings for a general return description. |
| `@retval` | Describes one return value. Repeated values and values without descriptions are retained. |
| `@fn` | Selects a real function by its written declaration. |
| `@class` | Selects a real class. |
| `@var` | Selects a real variable, field, or enum member. |
| `@def` | Selects a real macro. |
| `@typedef` | Selects a real typedef. |
| `@note` | Adds a note section. |
| `@warning` | Adds a warning section; it does not create an LSP diagnostic. |
| `@deprecated` | Adds a deprecated section; it does not mark completion items or usages as deprecated. |
| `@todo` | Adds a TODO section; it does not create a task list. |
| `@version` | Adds version information without inferring runtime compatibility or `@since` semantics. |
| `@ingroup` | Records group membership without displaying it as symbol documentation. |
| `@defgroup` | Identifies a group-definition block and prevents it from becoming the next symbol's documentation. |
| `@addtogroup` | Identifies a group-extension block and prevents it from becoming the next symbol's documentation. |

The two range commands `@{` and `@}` are also recognized as group structure, with `\{` and `\}` accepted as equivalent spellings. Group definitions, titles, and range markers are excluded from individual symbol documentation. The server does not build group pages, links, membership graphs, or a group index.

Unknown and malformed commands remain visible as source text instead of being reclassified as a supported field. Commands inside inline code, fenced code blocks, or escaped markers remain body text.

## Parameters and return values

`@param` accepts no direction, `[in]`, `[out]`, and `[in,out]`. Whitespace between the command and direction is allowed. Accepted bidirectional spellings include reversed order, comma or whitespace separators, and the joined `inout` and `outin` forms; display normalizes them to `[in,out]`.

A comma-separated selector such as `@param first,second` applies one description to both parameters. For unnamed parameters, a one-based position or `-` selects the corresponding declaration parameter. `...` selects the variadic parameter and is not assigned to a fixed parameter. Repeated descriptions are preserved in source order. Unknown names, invalid directions, and selectors that cannot be resolved remain unmatched instead of being guessed onto another parameter.

General returns and individual values can coexist. `@retval 1` displays the value without inventing a description. Backticked and Japanese value labels are retained as written.

## Binding to declarations

Without `@fn`, `@class`, `@var`, `@def`, or `@typedef`, a leading block binds to the immediately following declaration in the same syntax scope. Blank lines are allowed, but another declaration, statement, preprocessor directive, or ordinary comment stops the search. Group-only blocks are never used as the next declaration's description.

`@fn` is a structural target rather than a replacement signature. It searches the current file and files visible through the current analysis context; unrelated workspace files are not searched. Matching uses the function name, owner scope, return and parameter types, and variadic shape. Parameter names and formatting differences do not affect matching. Qualified class members and overloads remain distinct, and a return type alone does not select an overload.

A target must resolve unambiguously. A malformed, mismatched, or ambiguous explicit target does not fall back to a neighboring declaration, and a comment never creates a synthetic symbol. `@class`, `@var`, `@def`, and `@typedef` follow the same scope and ambiguity rules for their symbol kinds.

Documentation attached directly to a selected declaration or definition has priority. If that location has no usable description, the server may borrow documentation from one uniquely equivalent declaration or definition. It does not merge independent descriptions from multiple locations or choose arbitrarily among multiple candidates. The displayed signature always comes from the real AXEL declaration, never from the `@fn` text.

## Presentation

Hover shows the real declaration followed by the structured documentation. Completion uses the same documentation and preserves existing definition-origin information. Signature help includes the function documentation and adds the matching description to each parameter, including the active variadic parameter.

Markdown-capable clients receive supported paragraphs, lists, links, emphasis, inline code, and fenced code. Clients that do not advertise Markdown receive a readable plain-text rendering, including link labels and URLs. Comment body text is never translated. Generated headings such as Parameters, Return values, Note, Warning, and Deprecated follow the connection locale; Japanese locales use Japanese headings and other or missing locales use English.

Example:

```cpp
/*!
 * @fn int Find(string dir, string pattern, string ...)
 * @brief Finds matching files.
 * @param[in] dir Directory to search.
 * @param pattern Pattern such as `*.axl`.
 * @param ... Additional patterns.
 * @retval `1` A match was found.
 * @retval `0` No match was found.
 * @note Matching is case-sensitive.
 */
int Find(string dir, string pattern, string ...);
```

## Limits

The initial support does not provide:

- Doxygen execution, Doxyfile processing, or HTML/PDF generation;
- custom aliases or structural interpretation for commands not listed above;
- trailing documentation forms;
- group pages, links, indexes, or graphs;
- comment diagnostics, tag completion, or documentation templates;
- LSP deprecation tags, semantic modifiers, or usage diagnostics derived from `@deprecated`;
- synthetic symbols derived only from comments; or
- automatic merging of separate declaration and definition descriptions.

Unrecognized source is retained where possible, but the server does not promise full Doxygen rendering compatibility. Markdown fences and code literals must use standard Markdown; the server does not apply header-specific corrections.
