export const TARGET_PLATFORMS = {
  'windows-x86': { os: 'WINDOWS', cpu: 'x86', bits: 32 },
  'windows-x64': { os: 'WINDOWS', cpu: 'x86_64', bits: 64 },
  'linux-x86': { os: 'LINUX', cpu: 'x86', bits: 32 },
  'linux-x64': { os: 'LINUX', cpu: 'x86_64', bits: 64 },
  'solaris-x86': { os: 'SOLARIS', cpu: 'x86', bits: 32 },
  'solaris-x64': { os: 'SOLARIS', cpu: 'x86_64', bits: 64 },
  'solaris-sparc32': { os: 'SOLARIS', cpu: 'SPARC', bits: 32 },
  'solaris-sparc64': { os: 'SOLARIS', cpu: 'SPARC', bits: 64 },
  'hpux-hppa32': { os: 'HPUX', cpu: 'HPPA', bits: 32 },
  'hpux-hppa64': { os: 'HPUX', cpu: 'HPPA', bits: 64 }
} as const;

export type TargetPlatform = keyof typeof TARGET_PLATFORMS;

export function normalizeTargetPlatform(value: unknown): TargetPlatform {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TARGET_PLATFORMS, value)
    ? value as TargetPlatform : 'windows-x64';
}

export const PLATFORM_MACRO_NAMES = ['__OS_UNIX__', '__OS_WINDOWS__', '__OS_LINUX__', '__OS_SOLARIS__', '__OS_HPUX__', '__CPU_x86__', '__CPU_x86_64__', '__CPU_HPPA__', '__CPU_SPARC__', '__OS_32bit__', '__OS_64bit__'] as const;

export function platformMacroValue(name: string, targetPlatform?: string): number | undefined {
  if (!(PLATFORM_MACRO_NAMES as readonly string[]).includes(name)) { return undefined; }
  const platform = TARGET_PLATFORMS[normalizeTargetPlatform(targetPlatform)];
  if (name === '__OS_UNIX__') { return platform.os === 'WINDOWS' ? 0 : 1; }
  return name === `__OS_${platform.os}__` || name === `__CPU_${platform.cpu}__` || name === `__OS_${platform.bits}bit__` ? 1 : 0;
}
