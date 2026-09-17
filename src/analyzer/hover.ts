import { resolveImplicitGuiReference, findGuiDeclarationMember as findDeclarationMember, type ResolvedImplicitGuiReference } from './guiReferenceResolution';
import { renderedDocumentationFor } from './documentation/access';
import type { RenderedDocumentation } from './documentation/model';
import type { DocumentationBindings } from './documentation/model';
import { withDeclarationOrigin } from './declarationOrigin';
import { describeSystemMacro, resolveSystemMacro, systemMacroAt } from './systemMacros';
import { translate } from '../i18n/messages';
import { createMacroLookup } from './diagnostics';
import type {
  AnalysisDeclaration,
  AnalyzedDocument,
  AnalysisGuiClass,
  AnalysisGuiMethod,
  AnalysisMacroDefinition,
  AnalysisMacroInvocation,
  AnalysisGuiPart,
  AnalysisHover,
  AnalysisMemberAccess,
  AnalysisPosition,
  AnalysisReference,
  AnalysisResolvedInclude,
  AnalysisResolvedScriptExecution,
  AnalysisRange
} from '../types/analysis';
import { expandMacroInvocationText, type MacroLookup } from './macroExpansion';
import {
  findVisibleDeclaration,
  receiverTypeName,
  thisReceiverType,
  visibleDeclarationsByName
} from './resolution';
import {
  allGuiMethods,
  findVisibleGuiClass,
  findVisibleGuiClassEntry,
  resolveGuiPartPath,
  type GuiMethodContext,
  type ResolvedGuiPart
} from './guiResolution';

export interface HoverInput {
  locale?: string;
  analysis: AnalyzedDocument;
  position: AnalysisPosition;
  workspaceIndex: WorkspaceDeclarationIndex;
}

export interface WorkspaceDeclarationIndex {
  documentationBindings?(sourceUri: string): DocumentationBindings;
  listVisibleDocuments?(sourceUri: string): AnalyzedDocument[];
  findVisibleDeclarations?(sourceUri: string, name: string): AnalysisDeclaration[];
  findGuiClass?(sourceUri: string, name: string): AnalysisGuiClass | undefined;
  findBestVisibleMacroDefinition?(
    sourceUri: string,
    name: string,
    position?: AnalysisPosition
  ): AnalysisMacroDefinition | undefined;
  resolveIncludeAtPosition?(sourceUri: string, position: AnalysisPosition): AnalysisResolvedInclude | undefined;
  resolveScriptExecutionAtPosition?(sourceUri: string, position: AnalysisPosition): AnalysisResolvedScriptExecution | undefined;
}

export function getHover(input: HoverInput): AnalysisHover | null {
  const writtenMacro = input.analysis.expandedMacroReferences?.find(ref => contains(ref.range, input.position));
  if (writtenMacro) {
    const hover = hoverForMacroReference(input, writtenMacro);
    if (hover) { return hover; }
  }
  const systemReference = systemMacroAt(input.analysis, input.position);
  if (systemReference !== undefined) {
    const macro = resolveSystemMacro(systemReference.name, input.analysis.uri, systemReference.range.start, input.analysis.tool, input.analysis.targetPlatform, input.analysis.internalFeatures);
    if (macro !== undefined) { return hoverFromText(describeSystemMacro(macro, input.locale), 'text'); }
  }
  const includeHover = findIncludeHover(input);
  if (includeHover !== undefined) {
    return includeHover;
  }

  const scriptExecutionHover = findScriptExecutionHover(input);
  if (scriptExecutionHover !== undefined) {
    return scriptExecutionHover;
  }

  const guiHover = findGuiHover(input);
  if (guiHover !== undefined) {
    return guiHover;
  }

  const declaration = findDeclarationAtPosition(input.analysis, input.position);

  if (declaration !== undefined) {
    return hoverForDeclaration(input, declaration);
  }

  const reference = findReferenceAtPosition(input.analysis, input.position);
  if (reference === undefined) {
    return null;
  }

  const implicitGui = resolveImplicitGuiReference(input, reference);
  const preferredImplicitGuiHover = implicitGui?.preferred ? hoverForImplicitGuiReference(input, implicitGui) : undefined;
  if (preferredImplicitGuiHover !== undefined) {
    return preferredImplicitGuiHover;
  }

  const referenceDeclaration = findDeclarationForReference(input);
  if (referenceDeclaration !== undefined) {
    if (referenceDeclaration.kind === 'macro') {
      return hoverForMacroReference(input, reference) ?? null;
    }

    return withDeclarationOrigin(
      hoverForReferenceDeclaration(input, referenceDeclaration, reference), input.analysis.uri, referenceDeclaration.uri, input.locale
    );
  }

  const implicitGuiHover = implicitGui === undefined ? undefined : hoverForImplicitGuiReference(input, implicitGui);
  if (implicitGuiHover !== undefined) {
    return implicitGuiHover;
  }

  return null;
}

function findIncludeHover(input: HoverInput): AnalysisHover | undefined {
  const include = input.workspaceIndex.resolveIncludeAtPosition?.(input.analysis.uri, input.position);
  return include === undefined ? undefined : hoverFromText(translate(input.locale, 'include: {0}', include.filePath), 'text');
}

function findScriptExecutionHover(input: HoverInput): AnalysisHover | undefined {
  const execution = input.workspaceIndex.resolveScriptExecutionAtPosition?.(input.analysis.uri, input.position);
  return execution === undefined ? undefined : hoverFromText(translate(input.locale, 'axel: {0}', execution.filePath), 'text');
}

function findMacroInvocationAtPosition(input: HoverInput): AnalysisMacroInvocation | undefined {
  return input.analysis.macroInvocations
    .filter((candidate) => (
      contains(candidate.selectionRange, input.position)
      || contains(candidate.range, input.position)
    ))
    .sort((left, right) => (
      comparePositions(right.range.start, left.range.start)
      || comparePositions(left.range.end, right.range.end)
    ))[0];
}

function hoverForMacroReference(input: HoverInput, reference: Pick<AnalysisReference, 'name' | 'range'>): AnalysisHover | undefined {
  const invocation = findMacroInvocationAtPosition(input);
  return hoverForMacroInvocation(input, invocation?.name === reference.name
    && contains(invocation.selectionRange, input.position) ? invocation
      : { name: reference.name, range: reference.range, rawText: reference.name });
}

function hoverForMacroInvocation(
  input: HoverInput,
  invocation: Pick<AnalysisMacroInvocation, 'name' | 'range' | 'rawText'>
): AnalysisHover | undefined {
  const localLookup = createMacroLookup(input.analysis.macroDefinitions, input.analysis.uri, invocation.range.start);
  const cache = new Map<string, AnalysisMacroDefinition | undefined>();
  const lookup: MacroLookup = {
    findMacro: (name) => {
      if (!cache.has(name)) {
        cache.set(name, input.workspaceIndex.findBestVisibleMacroDefinition?.(input.analysis.uri, name, invocation.range.start)
          ?? localLookup.findMacro(name));
      }
      return cache.get(name);
    }
  };
  const macro = lookup.findMacro(invocation.name);
  if (macro === undefined) {
    return undefined;
  }

  const macroDeclaration = [...input.analysis.declarations,
    ...(input.workspaceIndex.findVisibleDeclarations?.(input.analysis.uri, macro.name) ?? [])]
    .find(d => d.kind === 'macro' && d.uri === macro.uri && comparePositions(d.selectionRange.start, macro.selectionRange.start) === 0);
  const macroDocumentation = macroDeclaration
    ? renderedDocumentationFor(input.analysis, input.workspaceIndex, macroDeclaration, input.locale) : undefined;
  if (macro.parameters !== undefined && invocation.rawText === invocation.name) {
    return withDeclarationOrigin(hoverForDeclarationText(macro.detail, macroDocumentation ?? macro.documentation),
      input.analysis.uri, macro.uri, input.locale);
  }

  const expansion = expandMacroInvocationText(invocation.rawText, lookup, {
    systemContext: { uri: input.analysis.uri, position: invocation.range.start, tool: input.analysis.tool, targetPlatform: input.analysis.targetPlatform, internalFeatures: input.analysis.internalFeatures }
  });
  if (expansion.diagnostics.length > 0) {
    return undefined;
  }

  const expandedText = formatMacroExpansionForHover(expansion.expandedText);
  const expansionNote = (expansion.truncated ? '\n' + translate(input.locale, 'Expansion truncated at depth 8.') : '')
    + ((expansion.runtimeMacros?.length ?? 0) > 0 ? '\n' + translate(input.locale, 'Runtime values remain symbolic: {0}.', expansion.runtimeMacros!.join(', ')) : '');
  const plainText = [
    macro.detail,
    ...((macroDocumentation?.plainText ?? macro.documentation) === undefined ? [] : [macroDocumentation?.plainText ?? macro.documentation]),
    translate(input.locale, 'Expansion:'),
    expandedText + expansionNote
  ].join('\n');

  return withDeclarationOrigin({
    markdown: markdownForMacroExpansion(macro.detail, macroDocumentation?.markdown ?? macro.documentation, expandedText, expansionNote, input.locale),
    plainText
  }, input.analysis.uri, macro.uri, input.locale);
}

function formatMacroExpansionForHover(expandedText: string): string {
  return expandedText.replace(/;[ \t]+(?=[^}\s])/g, ';\n');
}

function findDeclarationAtPosition(
  analysis: AnalyzedDocument,
  position: AnalysisPosition
): AnalysisDeclaration | undefined {
  return analysis.declarations.find((declaration) => contains(declaration.selectionRange, position));
}

function findDeclarationForReference(input: HoverInput): AnalysisDeclaration | undefined {
  const reference = findReferenceAtPosition(input.analysis, input.position);
  if (reference === undefined) {
    return undefined;
  }

  if (reference.memberAccess !== undefined) {
    return findMemberDeclaration(input, reference.memberAccess, input.position, reference);
  }

  if (reference.typeReference === true) {
    const typeDeclaration = visibleDeclarationsByName(input, reference.name).find(isTypeDeclaration);
    if (typeDeclaration !== undefined) {
      return typeDeclaration;
    }
  }

  return findDeclarationByName(input, reference.name, input.position, reference);
}

function findGuiHover(input: HoverInput): AnalysisHover | null | undefined {
  const declaration = findDeclarationAtPosition(input.analysis, input.position);
  if (declaration !== undefined) {
    return findGuiDeclarationHover(input, declaration);
  }

  return findGuiReceiverPathHover(input)
    ?? findGuiReferenceHover(input)
    ?? findGuiBaseClassReferenceHover(input)
    ?? findGuiTypeReferenceHover(input);
}

function findGuiDeclarationHover(
  input: HoverInput,
  declaration: AnalysisDeclaration
): AnalysisHover | null | undefined {
  const guiClass = findVisibleGuiClass(input, declaration.name);
  if (declaration.kind === 'class' && guiClass !== undefined) {
    return hoverForDeclarationText(guiClassText(guiClass), hoverDocumentation(input, declaration));
  }

  const part = findGuiPartForDeclaration(input.analysis.guiClasses, declaration);
  if (part !== undefined) {
    return hoverForDeclarationText(guiPartText(part.ownerName, part.part), hoverDocumentation(input, declaration));
  }

  const method = findGuiMethodForDeclaration(input.analysis, declaration);
  if (method === undefined) {
    return undefined;
  }

  return isResolvableGuiMethod(input, method)
    ? hoverForDeclarationText(declaration.detail, hoverDocumentation(input, declaration))
    : null;
}

function findGuiReferenceHover(input: HoverInput): AnalysisHover | null | undefined {
  const reference = findReferenceAtPosition(input.analysis, input.position);
  if (reference === undefined) {
    return undefined;
  }

  if (reference.memberAccess === undefined) {
    return undefined;
  }

  const part = resolveGuiMemberAccess(input, reference.memberAccess, input.position);
  return part === undefined ? undefined : withDeclarationOrigin(
    hoverFromText(guiPartText(part.ownerName, part.part)), input.analysis.uri, part.ownerUri, input.locale
  );
}

function hoverForImplicitGuiReference(input: HoverInput, resolved: ResolvedImplicitGuiReference): AnalysisHover | undefined {
  const { context, part, declaration } = resolved;
  if (part) {
    return withDeclarationOrigin(hoverFromText(implicitGuiPartText(context.rootClassName, part.part)),
      input.analysis.uri, part.ownerUri, input.locale);
  }
  return declaration === undefined ? undefined : withDeclarationOrigin(hoverForDeclarationText(
    resolved.useReceiverType ? hoverTextForGuiContextMemberDeclaration(declaration, context) : hoverTextForMemberDeclaration(declaration),
    hoverDocumentation(input, declaration)), input.analysis.uri, declaration.uri, input.locale);
}

function findGuiTypeReferenceHover(input: HoverInput): AnalysisHover | undefined {
  const reference = findReferenceAtPosition(input.analysis, input.position);
  if (reference === undefined || reference.memberAccess !== undefined) {
    return undefined;
  }

  const entry = findVisibleGuiClassEntry(input, reference.name);
  return entry === undefined ? undefined : withDeclarationOrigin(
    hoverFromText(guiClassText(entry.guiClass)), input.analysis.uri, entry.uri, input.locale
  );
}

function findGuiBaseClassReferenceHover(
  input: HoverInput
): AnalysisHover | undefined {
  const reference = findReferenceAtPosition(input.analysis, input.position);
  if (reference === undefined) {
    return undefined;
  }

  if (reference.memberAccess !== undefined) {
    return undefined;
  }

  const declaringType = input.analysis.declarations.find((declaration) => (
    isTypeDeclaration(declaration)
    && declaration.baseName === reference.name
    && contains(declaration.range, reference.range.start)
    && isBeforeDeclarationBody(input.analysis, declaration, reference.range.start)
  ));
  if (declaringType === undefined) {
    return undefined;
  }

  const entry = findVisibleGuiClassEntry(input, reference.name);
  return entry?.guiClass.baseName === undefined
    ? undefined
    : withDeclarationOrigin(hoverFromText(`class ${entry.guiClass.baseName}`), input.analysis.uri, entry.uri, input.locale);
}

function isTypeDeclaration(declaration: AnalysisDeclaration): boolean {
  return declaration.kind === 'class'
    || declaration.kind === 'struct'
    || declaration.kind === 'union'
    || declaration.kind === 'enum'
    || declaration.kind === 'typedef';
}

function isBeforeDeclarationBody(
  analysis: Pick<AnalyzedDocument, 'scopes'>,
  declaration: AnalysisDeclaration,
  position: AnalysisPosition
): boolean {
  const bodyScope = analysis.scopes
    .filter((scope) => contains(declaration.range, scope.range.start))
    .filter((scope) => positionBefore(declaration.selectionRange.start, scope.range.start))
    .sort((left, right) => comparePositions(left.range.start, right.range.start))[0];
  return bodyScope === undefined || positionBefore(position, bodyScope.range.start);
}

function findGuiReceiverPathHover(input: HoverInput): AnalysisHover | undefined {
  for (const method of allGuiMethods(input.analysis)) {
    const segmentIndex = segmentIndexAtPosition(method, input.position);
    if (segmentIndex === undefined) {
      continue;
    }

    const rootClass = findVisibleGuiClassEntry(input, method.receiverPath[0]);
    if (segmentIndex === 0 && rootClass !== undefined) {
      return withDeclarationOrigin(hoverFromText(guiClassText(rootClass.guiClass)), input.analysis.uri, rootClass.uri, input.locale);
    }

    const part = resolveGuiPartPath(input, method.receiverPath[0], method.receiverPath.slice(1, segmentIndex + 1));
    if (part !== undefined) {
      return withDeclarationOrigin(
        hoverFromText(guiPartText(part.ownerName, part.part)), input.analysis.uri, part.ownerUri, input.locale
      );
    }
  }

  return undefined;
}

function findDeclarationByName(
  input: HoverInput,
  name: string,
  position: AnalysisPosition,
  reference?: Pick<AnalysisReference, 'call' | 'argumentCount'>
): AnalysisDeclaration | undefined {
  return findVisibleDeclaration({ ...input, position }, name, reference);
}

function findReferenceAtPosition(
  analysis: AnalyzedDocument,
  position: AnalysisPosition
): AnalysisReference | undefined {
  return (analysis.navigationReferences ?? analysis.references).find((item) => contains(item.range, position));
}

function findMemberDeclaration(
  input: HoverInput,
  memberAccess: AnalysisMemberAccess,
  position: AnalysisPosition,
  reference?: Pick<AnalysisReference, 'call' | 'argumentCount'>
): AnalysisDeclaration | undefined {
  let typeName = memberAccess.receiverName === 'this'
    ? thisReceiverType({ ...input, position })
    : receiverTypeName({ ...input, position }, memberAccess.receiverName)
      ?? typeDeclarationName({ ...input, position }, memberAccess.receiverName);
  let memberDeclaration: AnalysisDeclaration | undefined;

  for (const [index, memberName] of memberAccess.memberNames.entries()) {
    if (typeName === undefined) {
      return undefined;
    }

    const isLastMember = index === memberAccess.memberNames.length - 1;
    memberDeclaration = findDeclarationMember(input, typeName, memberName, isLastMember ? reference : undefined);
    typeName = memberDeclaration?.typeName;
  }

  return memberDeclaration;
}

function resolveGuiMemberAccess(
  input: HoverInput,
  memberAccess: AnalysisMemberAccess,
  position: AnalysisPosition
): ResolvedGuiPart | undefined {
  const typeName = memberAccess.receiverName === 'this'
    ? thisReceiverType({ ...input, position })
    : receiverTypeName({ ...input, position }, memberAccess.receiverName);
  if (typeName === undefined) {
    return undefined;
  }

  return resolveGuiPartPath(input, typeName, memberAccess.memberNames);
}

function typeDeclarationName(input: HoverInput, name: string): string | undefined {
  return visibleDeclarations(input, name)
    .find((declaration) => declaration.kind === 'class' || declaration.kind === 'struct' || declaration.kind === 'union')
    ?.name;
}

function visibleDeclarations(input: HoverInput, name: string): AnalysisDeclaration[] {
  return visibleDeclarationsByName(input, name);
}

function hoverForDeclaration(input: HoverInput, declaration: AnalysisDeclaration): AnalysisHover {
  if (declaration.kind === 'function' && declaration.containerName !== undefined) {
    return hoverForDeclarationText(hoverTextForMemberDeclaration(declaration), hoverDocumentation(input, declaration));
  }

  const plainText = declaration.detail === declaration.kind
    ? `${declaration.detail} ${declaration.name}`
    : declaration.detail;
  return hoverForDeclarationText(plainText, hoverDocumentation(input, declaration));
}

function hoverForReferenceDeclaration(
  input: HoverInput,
  declaration: AnalysisDeclaration,
  reference: { memberAccess?: AnalysisMemberAccess }
): AnalysisHover {
  const plainText = reference.memberAccess === undefined
    ? hoverTextForDeclaration(declaration)
    : hoverTextForMemberDeclaration(declaration);
  return hoverForDeclarationText(plainText, hoverDocumentation(input, declaration));
}

function hoverTextForDeclaration(declaration: AnalysisDeclaration): string {
  return declaration.detail === declaration.kind
    ? `${declaration.detail} ${declaration.name}`
    : declaration.detail;
}

function hoverTextForMemberDeclaration(declaration: AnalysisDeclaration): string {
  if (declaration.containerName === undefined || declaration.detail.includes('::')) {
    return hoverTextForDeclaration(declaration);
  }

  const memberSignatureText = `${declaration.name}(`;
  if (declaration.detail.includes(memberSignatureText)) {
    return declaration.detail.replace(memberSignatureText, `${declaration.containerName}::${memberSignatureText}`);
  }

  const spacedMemberSignature = new RegExp(`${escapeRegExp(declaration.name)}(\\s*\\()`);
  if (spacedMemberSignature.test(declaration.detail)) {
    return declaration.detail.replace(spacedMemberSignature, `${declaration.containerName}::${declaration.name}$1`);
  }

  const memberNameText = declaration.name;
  return declaration.detail.endsWith(memberNameText)
    ? `${declaration.detail.slice(0, -memberNameText.length)}${declaration.containerName}::${memberNameText}`
    : hoverTextForDeclaration(declaration);
}

function hoverTextForGuiContextMemberDeclaration(
  declaration: AnalysisDeclaration,
  context: GuiMethodContext
): string {
  const memberSignatureText = `${declaration.name}(`;
  const ownerSignature = declaration.containerName === undefined
    ? undefined
    : `${declaration.containerName}::${memberSignatureText}`;
  if (ownerSignature !== undefined && declaration.detail.includes(ownerSignature)) {
    return declaration.detail.replace(ownerSignature, `${context.receiverTypeName}::${memberSignatureText}`);
  }

  if (declaration.detail.includes(memberSignatureText)) {
    return declaration.detail.replace(memberSignatureText, `${context.receiverTypeName}::${memberSignatureText}`);
  }

  if (declaration.containerName !== undefined) {
    const ownerSpacedMemberSignature = new RegExp(
      `${escapeRegExp(declaration.containerName)}::${escapeRegExp(declaration.name)}(\\s*\\()`
    );
    if (ownerSpacedMemberSignature.test(declaration.detail)) {
      return declaration.detail.replace(
        ownerSpacedMemberSignature,
        `${context.receiverTypeName}::${declaration.name}$1`
      );
    }
  }

  return hoverTextForMemberDeclaration({ ...declaration, containerName: context.receiverTypeName });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hoverFromText(plainText: string, language = 'axel'): AnalysisHover {
  return {
    markdown: `\`\`\`${language}\n${plainText}\n\`\`\``,
    plainText
  };
}

function hoverForDeclarationText(plainText: string, documentation: string | RenderedDocumentation | undefined): AnalysisHover {
  if (documentation === undefined) {
    return hoverFromText(plainText);
  }

  return {
    markdown: `\`\`\`axel\n${plainText}\n\`\`\`\n\n${typeof documentation === 'string' ? documentation : documentation.markdown}`,
    plainText: `${plainText}\n${typeof documentation === 'string' ? documentation : documentation.plainText}`
  };
}

function markdownForMacroExpansion(
  detail: string,
  documentation: string | undefined,
  expandedText: string,
  note: string,
  locale?: string
): string {
  return [
    '```axel',
    detail,
    '```',
    ...(documentation === undefined ? [] : ['', documentation]),
    '',
    translate(locale, 'Expansion:'),
    '',
    '```axel',
    expandedText,
    '```',
    ...(note === '' ? [] : ['', note.trim()])
  ].join('\n');
}

function findGuiPartForDeclaration(
  guiClasses: AnalysisGuiClass[],
  declaration: AnalysisDeclaration
): ResolvedGuiPart | undefined {
  for (const guiClass of guiClasses) {
    const part = findPartInClass(guiClass, (candidate) => (
      candidate.name === declaration.name && sameRange(candidate.range, declaration.range)
    ));
    if (part !== undefined) {
      return { ownerName: guiClass.name, part };
    }
  }

  return undefined;
}

function findGuiMethodForDeclaration(
  analysis: Pick<AnalyzedDocument, 'guiClasses' | 'guiMethods'>,
  declaration: AnalysisDeclaration
): AnalysisGuiMethod | undefined {
  return allGuiMethods(analysis)
    .find((method) => method.name === declaration.name && sameRange(method.range, declaration.range));
}

function isResolvableGuiMethod(input: HoverInput, method: AnalysisGuiMethod): boolean {
  if (!method.event || method.receiverPath.length <= 2) {
    return true;
  }

  const rootName = method.receiverPath[0];
  const partPath = method.receiverPath.slice(1, -1);
  return resolveGuiPartPath(input, rootName, partPath) !== undefined;
}

function findPartInClass(
  guiClass: AnalysisGuiClass,
  predicate: (part: AnalysisGuiPart) => boolean
): AnalysisGuiPart | undefined {
  return findPart(guiClass.parts, predicate);
}

function findPart(
  parts: AnalysisGuiPart[],
  predicate: (part: AnalysisGuiPart) => boolean
): AnalysisGuiPart | undefined {
  for (const part of parts) {
    if (predicate(part)) {
      return part;
    }

    const child = findPart(part.parts, predicate);
    if (child !== undefined) {
      return child;
    }
  }

  return undefined;
}

function guiPartText(ownerName: string, part: AnalysisGuiPart): string {
  return `${part.typeName} ${ownerName}::${part.path.join('.')}`;
}

function implicitGuiPartText(rootClassName: string, part: AnalysisGuiPart): string {
  return guiPartText(rootClassName, part);
}

function guiClassText(guiClass: AnalysisGuiClass): string {
  return `class ${guiClass.name} : public ${guiClass.baseName}`;
}

function sameRange(left: AnalysisRange, right: AnalysisRange): boolean {
  return samePosition(left.start, right.start) && samePosition(left.end, right.end);
}

function samePosition(left: AnalysisPosition, right: AnalysisPosition): boolean {
  return left.line === right.line && left.character === right.character;
}

function segmentIndexAtPosition(
  method: AnalysisGuiMethod,
  position: AnalysisPosition
): number | undefined {
  const segmentIndex = method.receiverPathSegmentRanges
    ?.findIndex((range) => contains(range, position));
  return segmentIndex === undefined || segmentIndex < 0 ? undefined : segmentIndex;
}

function contains(range: AnalysisRange, position: AnalysisPosition): boolean {
  return positionBeforeOrEqual(range.start, position) && positionBefore(position, range.end);
}

function positionBeforeOrEqual(left: AnalysisPosition, right: AnalysisPosition): boolean {
  return left.line < right.line || (left.line === right.line && left.character <= right.character);
}

function positionBefore(left: AnalysisPosition, right: AnalysisPosition): boolean {
  return left.line < right.line || (left.line === right.line && left.character < right.character);
}

function comparePositions(left: AnalysisPosition, right: AnalysisPosition): number {
  return left.line - right.line || left.character - right.character;
}

function hoverDocumentation(input: HoverInput, declaration: AnalysisDeclaration): string | RenderedDocumentation | undefined {
  return renderedDocumentationFor(input.analysis, input.workspaceIndex, declaration, input.locale) ?? declaration.documentation;
}
