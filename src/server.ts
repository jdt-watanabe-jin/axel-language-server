import {
  createConnection,
  ProposedFeatures,
  TextDocuments
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceIndex } from './analyzer/workspaceIndex';
import { registerHandlers } from './lsp/registerHandlers';

export function startServer(): void {
  const connection = createConnection(ProposedFeatures.all);
  const documents = new TextDocuments(TextDocument);
  const analyzer = new WorkspaceIndex({ logger: {
    info: message => connection.console.info(message),
    error: message => connection.console.error(message),
    timing: () => undefined
  } });

  registerHandlers({
    connection,
    documents,
    analyzer,
    logger: connection.console
  });

  documents.listen(connection);
  connection.listen();
}

startServer();
