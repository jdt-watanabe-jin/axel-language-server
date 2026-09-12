import type { ExtractedComment } from './comments';
import type {
  DocGroup,
  DocParameter,
  DocSource,
  DocTarget,
  ParsedDocumentation,
  SupplementKind
} from './model';

const returnCommands = new Set(['return', 'returns', 'result']);
const supplementCommands = new Set<SupplementKind>(['note', 'warning', 'deprecated', 'todo', 'version']);
const targetCommands = new Set<DocTarget['kind']>(['fn', 'class', 'var', 'def', 'typedef']);
const groupCommands = new Set<DocGroup['kind']>(['ingroup', 'defgroup', 'addtogroup', '{', '}']);
const parameterSelector = String.raw`(?:\.{3}|-|[0-9]+|[\p{L}_$][\p{L}\p{N}_$]*)`;
const parameterPattern = new RegExp(
  `^(${parameterSelector}(?:\\s*,\\s*${parameterSelector})*)(?:\\s+([\\s\\S]*))?$`,
  'u'
);

type PendingKind = 'brief' | 'details' | 'parameter' | 'return' | 'retval' | 'supplement' | 'unparsed';

interface PendingEntry {
  kind: PendingKind;
  textLines: string[];
  sourceLines: DocSource[];
  names?: string[];
  direction?: DocParameter['direction'];
  value?: string;
  supplementKind?: SupplementKind;
}

interface FoundCommand {
  index: number;
  name: string;
  rest: string;
  marker: '@' | '\\';
  endIndex: number;
  endsAtCommand: boolean;
}

interface Fence {
  character: '`' | '~';
  length: number;
}

export function parseDocumentation(comment: ExtractedComment): ParsedDocumentation {
  const document: ParsedDocumentation = {
    source: comment.source,
    brief: [],
    details: [],
    parameters: [],
    returns: [],
    returnValues: [],
    supplements: [],
    targets: [],
    groups: [],
    unparsed: []
  };
  let pending: PendingEntry | undefined;
  let fence: Fence | undefined;
  let inlineTicks: number | undefined;
  let indentedCode = false;
  let canStartIndentedCode = true;

  const finishPending = (): void => {
    if (pending === undefined) { return; }
    const text = pending.textLines.join('\n');
    const source = combineSources(pending.sourceLines, comment.source);
    switch (pending.kind) {
      case 'brief': document.brief.push({ text, source }); break;
      case 'details': document.details.push({ text, source }); break;
      case 'parameter': document.parameters.push({
        text,
        source,
        names: pending.names ?? [],
        ...(pending.direction === undefined ? {} : { direction: pending.direction })
      }); break;
      case 'return': document.returns.push({ text, source }); break;
      case 'retval': document.returnValues.push({ text, source, value: pending.value ?? '' }); break;
      case 'supplement': document.supplements.push({
        text,
        source,
        kind: pending.supplementKind!
      }); break;
      case 'unparsed': document.unparsed.push({ text, source }); break;
    }
    pending = undefined;
  };

  const appendBody = (text: string, source: DocSource): void => {
    if (pending === undefined) {
      pending = { kind: 'details', textLines: [], sourceLines: [] };
    }
    pending.textLines.push(text);
    pending.sourceLines.push(source);
  };

  for (const line of comment.lines) {
    if (indentedCode) {
      if (line.text.trim().length === 0 || isIndentedCodeLine(line.text)) {
        appendBody(line.text, line.source);
        continue;
      }
      indentedCode = false;
      finishPending();
    }

    const fenceRun = fenceAtStart(line.text);
    if (fence !== undefined) {
      appendBody(line.text, line.source);
      if (fenceRun !== undefined
        && fenceRun.character === fence.character
        && fenceRun.length >= fence.length
        && fenceRun.closing) {
        fence = undefined;
      }
      continue;
    }
    if (inlineTicks === undefined && fenceRun !== undefined) {
      appendBody(line.text, line.source);
      fence = { character: fenceRun.character, length: fenceRun.length };
      continue;
    }

    if (line.text.trim().length === 0) {
      if (inlineTicks !== undefined) {
        appendBody(line.text, line.source);
        continue;
      }
      finishPending();
      canStartIndentedCode = true;
      continue;
    }

    if (inlineTicks === undefined && canStartIndentedCode && isIndentedCodeLine(line.text)) {
      appendBody(line.text, line.source);
      indentedCode = true;
      canStartIndentedCode = false;
      continue;
    }
    canStartIndentedCode = false;
    const scanned = findCommands(line.text, inlineTicks);
    inlineTicks = scanned.inlineTicks;
    if (scanned.commands.length === 0) {
      appendBody(line.text, line.source);
      continue;
    }

    const prefix = line.text.slice(0, scanned.commands[0].index).trimEnd();
    if (prefix.trim().length > 0) {
      appendBody(prefix, line.source);
    }
    for (const scannedCommand of scanned.commands) {
      finishPending();
      const takesRemainder = commandTakesLineRemainder(scannedCommand.name);
      const command = takesRemainder
        ? {
          ...scannedCommand,
          rest: line.text.slice(scannedCommand.endIndex),
          endsAtCommand: false
        }
        : scannedCommand;
      handleCommand(document, command, line.source, entry => { pending = entry; });
      if (takesRemainder) { break; }
    }
  }
  finishPending();
  return document;
}

function handleCommand(
  document: ParsedDocumentation,
  command: FoundCommand,
  source: DocSource,
  setPending: (entry: PendingEntry) => void
): void {
  const leadingTrimmed = command.rest.trimStart();
  const rest = command.endsAtCommand ? leadingTrimmed.trimEnd() : leadingTrimmed;
  if (command.name === 'brief' || command.name === 'details') {
    setPending({ kind: command.name, textLines: [rest], sourceLines: [source] });
    return;
  }
  if (command.name === 'param') {
    const parameter = parseParameter(rest);
    if (parameter === undefined) {
      setPending({ kind: 'unparsed', textLines: [commandText(command)], sourceLines: [source] });
      return;
    }
    setPending({
      kind: 'parameter',
      textLines: [parameter.text],
      sourceLines: [source],
      names: parameter.names,
      ...(parameter.direction === undefined ? {} : { direction: parameter.direction })
    });
    return;
  }
  if (returnCommands.has(command.name)) {
    setPending({ kind: 'return', textLines: [rest], sourceLines: [source] });
    return;
  }
  if (command.name === 'retval') {
    const [value, text] = takeWord(rest);
    setPending({ kind: 'retval', textLines: [text], sourceLines: [source], value });
    return;
  }
  if (supplementCommands.has(command.name as SupplementKind)) {
    setPending({
      kind: 'supplement',
      textLines: [rest],
      sourceLines: [source],
      supplementKind: command.name as SupplementKind
    });
    return;
  }
  if (targetCommands.has(command.name as DocTarget['kind'])) {
    document.targets.push({ kind: command.name as DocTarget['kind'], text: rest, source });
    return;
  }
  if (groupCommands.has(command.name as DocGroup['kind'])) {
    document.groups.push({ kind: command.name as DocGroup['kind'], text: rest, source });
    return;
  }
  setPending({ kind: 'unparsed', textLines: [commandText(command)], sourceLines: [source] });
}

function parseParameter(rest: string): {
  names: string[];
  direction?: DocParameter['direction'];
  text: string;
} | undefined {
  let remaining = rest;
  let direction: DocParameter['direction'];
  if (remaining.startsWith('[')) {
    const close = remaining.indexOf(']');
    if (close === -1) { return undefined; }
    direction = normalizeDirection(remaining.slice(1, close));
    if (direction === undefined) { return undefined; }
    remaining = remaining.slice(close + 1).trimStart();
  }
  const match = parameterPattern.exec(remaining);
  if (match === null) { return undefined; }
  return {
    names: match[1].split(',').map(name => name.trim()),
    ...(direction === undefined ? {} : { direction }),
    text: match[2] ?? ''
  };
}

function normalizeDirection(raw: string): DocParameter['direction'] | undefined {
  const compact = raw.toLowerCase().replace(/[\s,]+/g, '');
  if (compact === 'in') { return 'in'; }
  if (compact === 'out') { return 'out'; }
  if (compact === 'inout' || compact === 'outin') { return 'in,out'; }
  return undefined;
}

function takeWord(text: string): [string, string] {
  if (text.length === 0) { return ['', '']; }
  if (text[0] === '`') {
    const length = countRun(text, 0, '`');
    const closing = text.indexOf('`'.repeat(length), length);
    if (closing !== -1) {
      const end = closing + length;
      return [text.slice(0, end), text.slice(end).trimStart()];
    }
  }
  const match = /^\S+/.exec(text);
  if (match === null) { return ['', '']; }
  return [match[0], text.slice(match[0].length).trimStart()];
}

function commandText(command: FoundCommand): string {
  return `${command.marker}${command.name}${command.rest}`;
}

function findCommands(text: string, initialTicks: number | undefined): {
  commands: FoundCommand[];
  inlineTicks?: number;
} {
  let ticks = initialTicks;
  const found: Omit<FoundCommand, 'rest' | 'endsAtCommand'>[] = [];
  for (let index = 0; index < text.length;) {
    if (text[index] === '`' && !isEscaped(text, index)) {
      const length = countRun(text, index, '`');
      if (ticks === undefined) {
        ticks = length;
      } else if (ticks === length) {
        ticks = undefined;
      }
      index += length;
      continue;
    }
    if (ticks === undefined && (text[index] === '@' || text[index] === '\\')) {
      const previous = index === 0 ? undefined : text[index - 1];
      if ((previous === undefined || /\s/.test(previous)) && !isEscaped(text, index)) {
        const name = commandNameAt(text, index + 1);
        if (name !== undefined) {
          found.push({ index, name, marker: text[index] as FoundCommand['marker'], endIndex: index + 1 + name.length });
        }
      }
    }
    index += 1;
  }
  return {
    commands: found.map((command, index) => ({
      ...command,
      rest: text.slice(command.endIndex, found[index + 1]?.index ?? text.length),
      endsAtCommand: index + 1 < found.length
    })),
    inlineTicks: ticks
  };
}

function commandTakesLineRemainder(name: string): boolean {
  return targetCommands.has(name as DocTarget['kind'])
    || name === 'ingroup'
    || name === 'defgroup'
    || name === 'addtogroup';
}

function commandNameAt(text: string, index: number): string | undefined {
  if (text[index] === '{' || text[index] === '}') { return text[index]; }
  const match = /^[A-Za-z]+/.exec(text.slice(index));
  return match?.[0];
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function countRun(text: string, start: number, character: string): number {
  let end = start;
  while (text[end] === character) { end += 1; }
  return end - start;
}

function fenceAtStart(text: string): (Fence & { closing: boolean }) | undefined {
  const match = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(text);
  if (match === null) { return undefined; }
  const run = match[1];
  return {
    character: run[0] as Fence['character'],
    length: run.length,
    closing: match[2].trim().length === 0
  };
}

function isIndentedCodeLine(text: string): boolean {
  return /^(?: {4}|\t)/.test(text);
}

function combineSources(sources: readonly DocSource[], commentSource: DocSource): DocSource {
  const first = sources[0];
  const last = sources.at(-1)!;
  return {
    uri: first.uri,
    range: { start: first.range.start, end: last.range.end },
    raw: sources.map((source, index) => index === sources.length - 1
      ? source.raw
      : source.raw + lineEndingAfter(commentSource, source.range.end.line)).join('')
  };
}

function lineEndingAfter(source: DocSource, line: number): string {
  const relativeLine = line - source.range.start.line;
  if (relativeLine < 0) { return '\n'; }
  let currentLine = 0;
  for (const match of source.raw.matchAll(/\r\n|\n|\r/g)) {
    if (currentLine === relativeLine) { return match[0]; }
    currentLine += 1;
  }
  return '\n';
}
