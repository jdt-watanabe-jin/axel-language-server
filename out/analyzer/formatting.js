"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFormattingEdits = getFormattingEdits;
const axelParser_1 = require("./axelParser");
function getFormattingEdits(input) {
    if (input.text.length === 0 || hasSyntaxErrors(input.text)) {
        return [];
    }
    const lines = input.text.split(/\r\n|\n|\r/);
    const target = targetLineRange(input.range, lines.length);
    const indentUnit = input.options.insertSpaces ? ' '.repeat(input.options.tabSize) : '\t';
    const edits = [];
    let indentLevel = 0;
    let inBlockComment = false;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? '';
        const trimmed = line.trimStart();
        const lineIndent = Math.max(0, indentLevel - (trimmed.startsWith('}') ? 1 : 0));
        if (lineIndex >= target.startLine && lineIndex <= target.endLine && trimmed.length > 0) {
            const existingIndentLength = line.length - trimmed.length;
            const expectedIndent = indentUnit.repeat(lineIndent);
            const existingIndent = line.slice(0, existingIndentLength);
            if (existingIndent !== expectedIndent) {
                edits.push({
                    range: {
                        start: { line: lineIndex, character: 0 },
                        end: { line: lineIndex, character: existingIndentLength }
                    },
                    newText: expectedIndent
                });
            }
        }
        const braceState = countStructuralBraces(line, inBlockComment);
        inBlockComment = braceState.inBlockComment;
        indentLevel = Math.max(0, indentLevel + braceState.opens - braceState.closes);
    }
    if (inBlockComment || indentLevel !== 0) {
        return [];
    }
    return edits;
}
function hasSyntaxErrors(text) {
    return (0, axelParser_1.createAxelParser)().parse(text).rootNode.hasError;
}
function targetLineRange(range, lineCount) {
    if (range === undefined) {
        return { startLine: 0, endLine: lineCount - 1 };
    }
    const endLine = range.end.character === 0 ? range.end.line - 1 : range.end.line;
    return {
        startLine: Math.max(0, range.start.line),
        endLine: Math.min(lineCount - 1, Math.max(range.start.line, endLine))
    };
}
function countStructuralBraces(line, inBlockComment) {
    let opens = 0;
    let closes = 0;
    let inString = false;
    let inCharacter = false;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        const next = line[index + 1];
        if (inBlockComment) {
            if (character === '*' && next === '/') {
                inBlockComment = false;
                index += 1;
            }
            continue;
        }
        if (inString || inCharacter) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (character === '\\') {
                escaped = true;
                continue;
            }
            if ((inString && character === '"') || (inCharacter && character === "'")) {
                inString = false;
                inCharacter = false;
            }
            continue;
        }
        if (character === '/' && next === '/') {
            break;
        }
        if (character === '/' && next === '*') {
            inBlockComment = true;
            index += 1;
            continue;
        }
        if (character === '"') {
            inString = true;
            continue;
        }
        if (character === "'") {
            inCharacter = true;
            continue;
        }
        if (character === '{') {
            opens += 1;
        }
        else if (character === '}') {
            closes += 1;
        }
    }
    return { opens, closes, inBlockComment };
}
//# sourceMappingURL=formatting.js.map