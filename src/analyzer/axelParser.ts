// eslint-disable-next-line @typescript-eslint/no-require-imports
import Parser = require('tree-sitter');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Axel = require('tree-sitter-axel') as Parser.Language;

export function createAxelParser(): Parser {
  const parser = new Parser();
  parser.setLanguage(Axel);
  return parser;
}
