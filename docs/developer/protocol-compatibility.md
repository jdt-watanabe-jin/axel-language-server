# LSP capability negotiation

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
