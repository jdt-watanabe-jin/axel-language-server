"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = startServer;
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const workspaceConfig_1 = require("./analyzer/workspaceConfig");
const workspaceIndex_1 = require("./analyzer/workspaceIndex");
const registerHandlers_1 = require("./lsp/registerHandlers");
function startServer() {
    const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
    const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
    const analyzer = new workspaceIndex_1.WorkspaceIndex((0, workspaceConfig_1.workspaceIndexOptionsFromEnvironment)(process.env));
    (0, registerHandlers_1.registerHandlers)({
        connection,
        documents,
        analyzer,
        logger: connection.console
    });
    documents.listen(connection);
    connection.listen();
}
startServer();
//# sourceMappingURL=server.js.map