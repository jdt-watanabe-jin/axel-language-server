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
      inlayHintProvider: true,
      completionProvider: {
        triggerCharacters: COMPLETION_TRIGGER_CHARACTERS
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
      workspaceSymbolProvider: true,
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
