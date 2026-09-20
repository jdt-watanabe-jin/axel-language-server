import { CancellationToken } from 'vscode-languageserver/node';
import { registerHandlers as register, type HandlerRegistrationContext } from '../../lsp/registerHandlers';
import { throwIfCancelled } from '../../util/cancellation';

/** Handler unit tests inject an already-acquired configuration; transport tests use the real manager. */
export function registerHandlers(context: HandlerRegistrationContext): void {
  register({ clientCapabilities: { workspace: { semanticTokens: { refreshSupport: true }, diagnostics: { refreshSupport: true } } }, ...context, configuration: context.configuration ?? {
    settings: {}, isReady: true,
    start() {}, refresh() {}, dispose() {},
    async ready(token: CancellationToken) { throwIfCancelled(token); }
  } });
}
