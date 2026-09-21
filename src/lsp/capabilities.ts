import { AXEL_COMMANDS } from './operations';
import {
  CodeActionKind,
  type InitializeResult,
  type ClientCapabilities,
  TextDocumentSyncKind
} from 'vscode-languageserver/node';
import { SEMANTIC_TOKEN_LEGEND } from './semanticTokens';

const COMPLETION_TRIGGER_CHARACTERS = [
  '.',
  ':',
  '"',
  '<',
  '#',
  '@',
  '/',
  '\\',
  '>',
  '_',
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
];

export function createInitializeResult(client?: ClientCapabilities): InitializeResult {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      executeCommandProvider: { commands: AXEL_COMMANDS },
      inlayHintProvider: client?.textDocument?.inlayHint?.resolveSupport?.properties?.some(property => ['tooltip', 'label.tooltip', 'label.location'].includes(property))
        ? { resolveProvider: true } : true,
      completionProvider: {
        triggerCharacters: COMPLETION_TRIGGER_CHARACTERS,
        ...(client?.textDocument?.completion?.completionItem?.resolveSupport?.properties?.some(property => ['detail', 'documentation'].includes(property))
          ? { resolveProvider: true } : {})
      },
      signatureHelpProvider: {
        triggerCharacters: ['(', ',']
      },
      definitionProvider: true,
      declarationProvider: true,
      typeDefinitionProvider: true,
      implementationProvider: true,
      selectionRangeProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      renameProvider: {
        prepareProvider: true
      },
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix]
      },
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      documentSymbolProvider: true,
      documentLinkProvider: { resolveProvider: true },
      codeLensProvider: { resolveProvider: true },
      workspaceSymbolProvider: client?.workspace?.symbol?.resolveSupport?.properties?.includes('location.range') ? { resolveProvider: true } : true,
      workspace: { workspaceFolders: { supported: true, changeNotifications: true },
        fileOperations: Object.fromEntries(['willCreate', 'didCreate', 'willRename', 'didRename', 'willDelete', 'didDelete']
          .filter(key => client?.workspace?.fileOperations?.[key as keyof NonNullable<NonNullable<ClientCapabilities['workspace']>['fileOperations']>] === true)
          .map(key => [key, { filters: [{ scheme: 'file', pattern: { glob: '**/*' } }] }])) },
      callHierarchyProvider: true,
      typeHierarchyProvider: true,
      foldingRangeProvider: true,
      semanticTokensProvider: {
        legend: SEMANTIC_TOKEN_LEGEND,
        full: true
      },
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false
      }
    }
  };
}
