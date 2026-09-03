import type {
  AnalysisGuiClass,
  AnalysisGuiMethod,
  AnalysisGuiPart,
  AnalysisPosition,
  AnalyzedDocument
} from '../types/analysis';
import { contains } from './resolution';

export interface GuiResolutionInput {
  analysis: Pick<AnalyzedDocument, 'uri' | 'guiClasses' | 'guiMethods'>;
  position: AnalysisPosition;
  workspaceIndex?: {
    findGuiClass?(sourceUri: string, name: string): AnalysisGuiClass | undefined;
    listVisibleDocuments?(sourceUri: string): AnalyzedDocument[];
  };
}

export interface GuiMethodContext {
  rootClassName: string;
  receiverTypeName: string;
  method: AnalysisGuiMethod;
  part?: AnalysisGuiPart;
}

export interface ResolvedGuiPart {
  ownerUri?: string;
  ownerName: string;
  part: AnalysisGuiPart;
}

export interface ResolvedGuiPartPrefix {
  length: number;
  part: ResolvedGuiPart;
}

interface GuiClassEntry {
  uri?: string;
  guiClass: AnalysisGuiClass;
}

export function findVisibleGuiClass(input: GuiResolutionInput, name: string): AnalysisGuiClass | undefined {
  return findVisibleGuiClassEntry(input, name)?.guiClass;
}

export function findEnclosingGuiMethodContext(input: GuiResolutionInput): GuiMethodContext | undefined {
  for (const guiClass of input.analysis.guiClasses) {
    const context = findEnclosingGuiMethodContextInClass(input, guiClass);
    if (context !== undefined) {
      return context;
    }
  }

  for (const method of input.analysis.guiMethods) {
    const context = guiMethodContextFromReceiverPath(input, method);
    if (context !== undefined && contains(method.range, input.position)) {
      return context;
    }
  }

  return undefined;
}

export function resolveGuiPartPath(
  input: GuiResolutionInput,
  rootClassName: string,
  path: string[]
): ResolvedGuiPart | undefined {
  let owner = findVisibleGuiClassEntry(input, rootClassName);
  let ownerPath: string[] = [];
  let resolved: ResolvedGuiPart | undefined;
  const rootOwner = owner;
  if (rootOwner !== undefined) {
    const directPart = findPartByPath(rootOwner.guiClass.parts, path);
    if (directPart !== undefined) {
      return { ownerUri: rootOwner.uri, ownerName: rootOwner.guiClass.name, part: directPart };
    }
  }

  for (const segment of path) {
    if (owner === undefined) {
      return undefined;
    }

    const nextPath = [...ownerPath, segment];
    const part = findPartByPath(owner.guiClass.parts, nextPath) ?? findPartByPath(owner.guiClass.parts, [segment]);
    if (part === undefined) {
      return undefined;
    }

    resolved = { ownerUri: owner.uri, ownerName: owner.guiClass.name, part };
    const partClass = findVisibleGuiClassEntry(input, part.typeName);
    owner = partClass ?? owner;
    ownerPath = partClass === undefined ? nextPath : [];
  }

  return resolved;
}

export function resolveLongestGuiPartPath(
  input: GuiResolutionInput,
  rootClassName: string,
  path: string[]
): ResolvedGuiPartPrefix | undefined {
  for (let length = path.length; length > 0; length -= 1) {
    const part = resolveGuiPartPath(input, rootClassName, path.slice(0, length));
    if (part !== undefined) {
      return { length, part };
    }
  }

  return undefined;
}

export function allGuiMethods(
  analysis: Pick<AnalyzedDocument, 'guiClasses' | 'guiMethods'>
): AnalysisGuiMethod[] {
  return [
    ...analysis.guiMethods,
    ...analysis.guiClasses.flatMap((guiClass) => [
      ...guiClass.methods,
      ...guiClass.parts.flatMap(methodsFromGuiPart)
    ])
  ];
}

function findEnclosingGuiMethodContextInClass(
  input: GuiResolutionInput,
  guiClass: AnalysisGuiClass
): GuiMethodContext | undefined {
  const classMethod = guiClass.methods.find((method) => contains(method.range, input.position));
  if (classMethod !== undefined) {
    return guiMethodContextFromReceiverPath(input, classMethod)
      ?? { rootClassName: guiClass.name, receiverTypeName: guiClass.name, method: classMethod };
  }

  const partMethod = findEnclosingGuiPartMethod(guiClass.parts, input.position);
  if (partMethod !== undefined) {
    return {
      rootClassName: guiClass.name,
      receiverTypeName: partMethod.part.typeName,
      method: partMethod.method,
      part: partMethod.part
    };
  }

  return undefined;
}

function findEnclosingGuiPartMethod(
  parts: AnalysisGuiPart[],
  position: AnalysisPosition
): { part: AnalysisGuiPart; method: AnalysisGuiMethod } | undefined {
  for (const part of parts) {
    const method = part.methods.find((candidate) => contains(candidate.range, position));
    if (method !== undefined) {
      return { part, method };
    }

    const childMethod = findEnclosingGuiPartMethod(part.parts, position);
    if (childMethod !== undefined) {
      return childMethod;
    }
  }

  return undefined;
}

function guiMethodContextFromReceiverPath(
  input: GuiResolutionInput,
  method: AnalysisGuiMethod
): GuiMethodContext | undefined {
  const rootClassName = method.receiverPath[0];
  if (rootClassName === undefined) {
    return undefined;
  }

  const partPath = method.receiverPath.slice(1, -1);
  if (partPath.length === 0) {
    return { rootClassName, receiverTypeName: rootClassName, method };
  }

  const part = resolveGuiPartPath(input, rootClassName, partPath);
  return part === undefined
    ? undefined
    : { rootClassName, receiverTypeName: part.part.typeName, method, part: part.part };
}

function findVisibleGuiClassEntry(input: GuiResolutionInput, name: string): GuiClassEntry | undefined {
  for (const analysis of visibleDocuments(input)) {
    const guiClass = analysis.guiClasses.find((candidate) => candidate.name === name);
    if (guiClass !== undefined) {
      return { uri: analysis.uri, guiClass };
    }
  }

  const guiClass = input.workspaceIndex?.findGuiClass?.(input.analysis.uri, name);
  return guiClass === undefined ? undefined : { guiClass };
}

function visibleDocuments(input: GuiResolutionInput): AnalyzedDocument[] {
  return [
    input.analysis as AnalyzedDocument,
    ...(input.workspaceIndex?.listVisibleDocuments?.(input.analysis.uri) ?? [])
  ];
}

function findPartByPath(parts: AnalysisGuiPart[], path: string[]): AnalysisGuiPart | undefined {
  for (const part of parts) {
    if (sameStringArray(part.path, path)) {
      return part;
    }

    const child = findPartByPath(part.parts, path);
    if (child !== undefined) {
      return child;
    }
  }

  return undefined;
}

function methodsFromGuiPart(part: AnalysisGuiPart): AnalysisGuiMethod[] {
  return [
    ...part.methods,
    ...part.parts.flatMap(methodsFromGuiPart)
  ];
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
