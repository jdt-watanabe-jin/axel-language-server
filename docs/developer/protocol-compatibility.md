# LSP capability negotiation

For completion, inlay-hint and workspace-symbol resolve capabilities and Code Lens refresh, see [deferred details](deferred-details.md).

`workspace.configuration` is required. Initialization fails with an explicit error if the client does not advertise it. Configuration changes trigger another configuration request; legacy notification payloads do not become server settings.

Semantic-token and diagnostic refresh requests are sent only when the client advertises `workspace.semanticTokens.refreshSupport` or `workspace.diagnostics.refreshSupport`, respectively. This applies to settings changes, watched files, document lifecycle changes and background indexing. Refresh rejection is logged and does not become an unhandled promise rejection. Inlay-hint refresh already has its own capability check. Clients without refresh support can still request the corresponding document results; the server does not silently enable Push Diagnostics.

The server dynamically registers configuration notifications only for clients advertising dynamic registration. Registration failure is logged; initial configuration acquisition and language requests remain usable. File-operation capabilities are advertised individually according to client support.

The contract is tested with real stdio in `src/test/e2e/protocolCapabilities.test.ts` and `configurationPull.test.ts`. Use `rawRequest('initialize', ...)` for negotiation tests: the ordinary test client's `request` method adds configuration support as a convenience for other feature tests. Handler unit tests inject explicit refresh-support capabilities through their configured context.

Run:

```text
npm run test:e2e -- --grep "LSP capability negotiation|LSP configuration contract|LSP target platform"
npm run test:ci
```

The extension's R0 baseline separately tests VS Code 1.82.0 and its reference Host version, checks real-client Open/Change/Save/Close transmission, and provides a repeatable stdio performance harness with process memory and build fingerprints. Those results apply to the linked development server. They do not update the extension's pinned published dependency.

## Operations and long-running work

The command allowlist is `axel.rebuildIndex`, `axel.applyQuickFix`, and `axel.showSource`. Versioned edit application requires `workspace.applyEdit` and `workspace.workspaceEdit.documentChanges`; source display checks `window.showDocument.support`. Clients without these optional capabilities still receive ordinary language features and explicit command fallback results.

`window.workDoneProgress` enables delayed server-created progress; supplied `workDoneToken` values are retained. Cancellation uses `window/workDoneProgress/cancel` or ordinary request cancellation. Explicit rebuild queries `workspace/workspaceFolders` only when supported and discards a stale response after a folder-change notification. Recovery uses `window/showMessageRequest`; editor-specific settings navigation is delegated through `axel/openSettings`.

See [server operations and progress](r4-operations.md) for complete contracts, supported scopes, and dependency availability.

## Document outline analysis policy

The `axel` configuration snapshot accepts `workspaceSymbols: "Just My Code" | "All"`, defaulting to `"Just My Code"`. Despite the historical setting name, it controls `textDocument/documentSymbol`, not `workspace/symbol` collection. The removed object-form `workspaceSymbols.exclude` remains a configuration error.

Just My Code uses an isolated syntax-only outline cache keyed by URI, version, source and preprocessing context. It never requires dependency indexing or diagnostic completion; pending content notifications are not flushed through foreground semantic analysis for this request. Local declarations, GUI structure and locally evaluable conditions are included. Macro-generated declarations and externally determined GUI kinds may require All. Other language features retain their dependency analysis.

All uses the existing shared analysis, including forced headers, resolved includes, login declarations and diagnostics. Both modes return symbols of the requested document only. A configuration update affects the next request without reopening the document; there is no standard document-symbol refresh request.

Regression coverage: `documentOutline.test.ts` in integration/features and E2E, and `documentOutlineScheduling.test.ts` in unit. Name resolution must pass only required GUI context fields, without spreading an analysis object whose lazy getters compute unrelated semantic data.
