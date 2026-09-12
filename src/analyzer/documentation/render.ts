import { translate } from '../../i18n/messages';
import type {
  BoundDocumentation,
  DocParameter,
  DocSupplement,
  DocText,
  RenderedDocumentation,
} from './model';

type OutputKind = 'markdown' | 'plainText';

function trimBlankLines(value: string): string {
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[0].trim().length === 0) { lines.shift(); }
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) { lines.pop(); }
  return lines.join('\n');
}

function markdownOutsideCodeToPlain(value: string): string {
  let result = value;
  result = result.replace(/!?\[([^\]]*)\]\(([^)]+)\)/g, (_match, label: string, url: string) => `${label} (${url})`);
  result = result.replace(/(?<![\w\\])(\*\*|__|~~)(?=\S)(.+?\S)\1(?!\w)/g, '$2');
  result = result.replace(/(?<![\w\\])([*_])(?=\S)(.+?\S)\1(?!\w)/g, '$2');
  result = result.replace(/\\([\\`*_[\]{}()#+\-.!<>@])/g, '$1');
  return result;
}

function markdownInlineToPlain(value: string): string {
  let prefix = '\uE000';
  while (value.includes(prefix)) { prefix += '\uE000'; }
  const code: { token: string; content: string }[] = [];
  const protectedValue = value.replace(/(`+)([^\n]*?)\1/g, (_match, _marker: string, rawContent: string) => {
    let content = rawContent;
    if (/^\s[\s\S]*\s$/.test(content) && /\S/.test(content)) { content = content.slice(1, -1); }
    const token = `${prefix}${code.length};`;
    code.push({ token, content });
    return token;
  });
  let result = markdownOutsideCodeToPlain(protectedValue);
  for (const span of code) {
    result = result.replaceAll(span.token, span.content);
  }
  return result;
}

function markdownToPlain(value: string): string {
  const lines = trimBlankLines(value).split('\n');
  const output: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of lines) {
    if (fence === undefined && /^(?: {4}|\t)/.test(line)) {
      output.push(line);
      continue;
    }
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (match !== null) {
      const marker = match[1][0];
      if (fence === undefined) {
        fence = { marker, length: match[1].length };
        continue;
      }
      if (marker === fence.marker && match[1].length >= fence.length) {
        fence = undefined;
        continue;
      }
    }
    const plainLine = line.replace(/^(\s{0,3})#{1,6}\s+/, '$1').replace(/^(\s*)>\s?/, '$1');
    output.push(fence === undefined ? markdownInlineToPlain(plainLine) : line);
  }
  return output.join('\n');
}

function body(value: string, output: OutputKind): string {
  const normalized = trimBlankLines(value);
  return output === 'markdown' ? normalized : markdownToPlain(normalized);
}

function heading(locale: string | undefined, key: string, output: OutputKind): string {
  const label = translate(locale, key);
  return output === 'markdown' ? `**${label}**` : label;
}

function codeValue(value: string, output: OutputKind): string {
  const normalized = value.trim();
  if (output === 'plainText') { return markdownInlineToPlain(normalized); }
  const existing = normalized.match(/^(`+)([\s\S]*?)\1$/);
  if (existing !== null) { return normalized; }
  const longest = Math.max(0, ...([...normalized.matchAll(/`+/g)].map(match => match[0].length)));
  const marker = '`'.repeat(Math.max(1, longest + 1));
  const padding = normalized.startsWith('`') || normalized.endsWith('`') ? ' ' : '';
  return `${marker}${padding}${normalized}${padding}${marker}`;
}

function listItem(label: string, description: string, output: OutputKind): string | undefined {
  const renderedDescription = body(description, output);
  const first = label.length === 0 ? renderedDescription
    : renderedDescription.length === 0 ? label : `${label} — ${renderedDescription}`;
  if (first.length === 0) { return undefined; }
  const [firstLine, ...continuation] = first.split('\n');
  return `- ${firstLine}${continuation.map(line => `\n  ${line}`).join('')}`;
}

function parameterLabel(entry: DocParameter, name: string, output: OutputKind): string {
  const direction = entry.direction === undefined ? '' : `[${entry.direction}]`;
  const renderedName = name.length === 0 ? '' : codeValue(name, output);
  return [direction, renderedName].filter(part => part.length > 0).join(' ');
}

function declaredParameterName(bound: BoundDocumentation, index: number, entry: DocParameter): string {
  const parameter = bound.declaration.signature?.parameters[index] as ({ name?: string; variadic?: boolean } | undefined);
  if (parameter?.variadic === true) { return '...'; }
  if (parameter?.name !== undefined && parameter.name.length > 0) { return parameter.name; }
  return entry.names.join(', ');
}

function unparsedBlock(value: string, output: OutputKind): string {
  const normalized = trimBlankLines(value);
  if (output === 'plainText') { return normalized; }
  const longest = Math.max(0, ...([...normalized.matchAll(/`+/g)].map(match => match[0].length)));
  const marker = '`'.repeat(Math.max(3, longest + 1));
  return `${marker}text\n${normalized}\n${marker}`;
}

const supplementHeadings: Readonly<Record<DocSupplement['kind'], string>> = {
  note: 'Note',
  warning: 'Warning',
  deprecated: 'Deprecated',
  todo: 'TODO',
  version: 'Version',
};

function render(bound: BoundDocumentation, locale: string | undefined, output: OutputKind): string {
  const blocks: string[] = [];
  const appendBodies = (entries: readonly DocText[]) => {
    for (const entry of entries) {
      const rendered = body(entry.text, output);
      if (rendered.length > 0) { blocks.push(rendered); }
    }
  };
  const appendSection = (key: string, entries: readonly DocText[]) => {
    const rendered = entries.map(entry => body(entry.text, output)).filter(value => value.length > 0);
    if (rendered.length > 0) { blocks.push(heading(locale, key, output), ...rendered); }
  };

  appendBodies(bound.documents.flatMap(document => document.brief));
  appendSection('Details', bound.documents.flatMap(document => document.details));

  const parameters: string[] = [];
  for (const [index, entries] of [...bound.parameterEntries.entries()].sort(([left], [right]) => left - right)) {
    for (const entry of entries) {
      const item = listItem(parameterLabel(entry, declaredParameterName(bound, index, entry), output), entry.text, output);
      if (item !== undefined) { parameters.push(item); }
    }
  }
  if (parameters.length > 0) { blocks.push(heading(locale, 'Parameters', output), parameters.join('\n')); }

  const unmatched = bound.unmatchedParameters
    .map(entry => listItem(parameterLabel(entry, entry.names.join(', '), output), entry.text, output))
    .filter((value): value is string => value !== undefined);
  if (unmatched.length > 0) { blocks.push(heading(locale, 'Unmatched parameters', output), unmatched.join('\n')); }

  appendSection('Returns', bound.documents.flatMap(document => document.returns));

  const returnValues = bound.documents.flatMap(document => document.returnValues)
    .map(entry => listItem(entry.value.length === 0 ? '' : codeValue(entry.value, output), entry.text, output))
    .filter((value): value is string => value !== undefined);
  if (returnValues.length > 0) { blocks.push(heading(locale, 'Return values', output), returnValues.join('\n')); }

  for (const supplement of bound.documents.flatMap(document => document.supplements)) {
    const rendered = body(supplement.text, output);
    if (rendered.length > 0) { blocks.push(heading(locale, supplementHeadings[supplement.kind], output), rendered); }
  }

  for (const entry of bound.documents.flatMap(document => document.unparsed)) {
    const rendered = unparsedBlock(entry.text, output);
    if (rendered.length > 0) { blocks.push(rendered); }
  }
  return blocks.join('\n\n');
}

export function renderDocumentation(bound: BoundDocumentation, locale?: string): RenderedDocumentation {
  return {
    markdown: render(bound, locale, 'markdown'),
    plainText: render(bound, locale, 'plainText'),
  };
}

export function renderParameterDocumentation(
  bound: BoundDocumentation,
  parameterIndex: number,
  _locale?: string,
): RenderedDocumentation | undefined {
  const entries = bound.parameterEntries.get(parameterIndex);
  if (entries === undefined) { return undefined; }
  const markdown = entries.map(entry => {
    const direction = entry.direction === undefined ? '' : `[${entry.direction}]`;
    const description = body(entry.text, 'markdown');
    return [direction, description].filter(part => part.length > 0).join(' ');
  }).filter(value => value.length > 0);
  if (markdown.length === 0) { return undefined; }
  const plainText = entries.map(entry => {
    const direction = entry.direction === undefined ? '' : `[${entry.direction}]`;
    const description = body(entry.text, 'plainText');
    return [direction, description].filter(part => part.length > 0).join(' ');
  }).filter(value => value.length > 0);
  return { markdown: markdown.join('\n\n'), plainText: plainText.join('\n\n') };
}
