import { japaneseMessages } from './ja';

/** English templates are keys; arguments remain structured until presentation. */
export interface MessageDescriptor {
  key: string;
  args?: readonly (string | number | MessageDescriptor)[];
}

export function formatMessage(descriptor: MessageDescriptor, locale?: string): string {
  const japanese = typeof locale === 'string' && /^ja(?:-|$)/i.test(locale);
  const template = japanese && Object.hasOwn(japaneseMessages, descriptor.key)
    ? japaneseMessages[descriptor.key] : descriptor.key;
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const argument = descriptor.args?.[Number(index)];
    return argument === undefined ? placeholder
      : typeof argument === 'object' ? formatMessage(argument, locale) : String(argument);
  });
}

export function translate(locale: string | undefined, key: string, ...args: (string | number | MessageDescriptor)[]): string {
  return formatMessage({ key, args }, locale);
}

/** Preserve English analysis messages for non-LSP consumers and existing tools. */
export function message(key: string, ...args: (string | number | MessageDescriptor)[]): {
  message: string;
  messageDescriptor: MessageDescriptor;
} {
  const messageDescriptor = { key, args };
  return { message: formatMessage(messageDescriptor), messageDescriptor };
}
