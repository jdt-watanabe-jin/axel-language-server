import type { HandlerRegistrationContext } from './registerHandlers';

const lastSent = new WeakMap<object, string>();

export function sendLoginDependencies(context: HandlerRegistrationContext): boolean {
  const payload = context.analyzer.getLoginDependencies?.();
  if (!payload) { return false; }
  const key = JSON.stringify(payload);
  if (lastSent.get(context) === key) { return false; }
  lastSent.set(context, key);
  void context.connection.sendNotification('axel/loginDependencies', payload);
  return true;
}
