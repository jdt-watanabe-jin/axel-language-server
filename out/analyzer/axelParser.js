"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAxelParser = createAxelParser;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Parser = require("tree-sitter");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Axel = require('tree-sitter-axel');
function createAxelParser() {
    const parser = new Parser();
    parser.setLanguage(Axel);
    return parser;
}
//# sourceMappingURL=axelParser.js.map