import matter from 'gray-matter';
import { generateEntityId, isValidEntityId } from './entity-id.js';
import { GROUNDZERO_FORMULA_COMMENT } from './index-yml.js';
import { generateYamlKeyValue, generateFormulaFrontmatterBlock } from './yaml-frontmatter.js';

/**
 * Interface for formula marker YAML
 */
export interface FormulaMarkerYml {
  formula?: {
    name: string;
    id?: string;
    platformSpecific?: boolean;
  };
}

/**
 * Parse YAML frontmatter from markdown file content
 */
export function parseMarkdownFrontmatter(content: string): FormulaMarkerYml | null {
  try {
    const parsed = matter(content);
    
    // If no frontmatter was found, return null
    if (!parsed.data || Object.keys(parsed.data).length === 0) {
      return null;
    }
    
    const frontmatter = parsed.data as FormulaMarkerYml;
    
    // Validate formula name field - must be defined and non-empty
    if (frontmatter.formula?.name === undefined || frontmatter.formula.name === '') {
      return null;
    }
    
    return frontmatter;
  } catch (error) {
    // If parsing fails, return null (no valid frontmatter)
    return null;
  }
}

/**
 * Update markdown content with formula frontmatter, preserving existing non-formula frontmatter and comments
 */
export function updateMarkdownWithFormulaFrontmatter(
  content: string,
  formulaUpdate: { name?: string; platformSpecific?: boolean; id?: string; ensureId?: boolean; resetId?: boolean }
): string {
  const updateObject = formulaUpdate || {};

  // Determine effective id to write, honoring resetId > ensureId > explicit id
  let effectiveId: string | undefined = undefined;
  if (updateObject.resetId) {
    effectiveId = generateEntityId();
  } else if (updateObject.ensureId) {
    const existingParsed = parseMarkdownFrontmatter(content);
    const existingId = existingParsed?.formula?.id;
    effectiveId = existingId && isValidEntityId(existingId) ? existingId : generateEntityId();
  } else if (typeof updateObject.id === 'string' && updateObject.id.length > 0) {
    effectiveId = updateObject.id;
  }

  const shouldUpdateName = typeof updateObject.name === 'string' && updateObject.name.length > 0;
  const shouldUpdatePlatform = updateObject.platformSpecific === true;
  const shouldUpdateId = typeof effectiveId === 'string' && effectiveId.length > 0;

  if (!shouldUpdateName && !shouldUpdatePlatform && !shouldUpdateId) {
    return content;
  }

  const nl = detectNewline(content);

  const bounds = findFrontmatterBounds(content, nl);
  if (!bounds.has) {
    return buildNewFrontmatter(content, updateObject, nl);
  }

  const frontmatterContent = content.slice(bounds.start, bounds.end);
  const markdownContentStart = bounds.end + (nl + '---' + nl).length;
  const markdownContent = content.slice(markdownContentStart);

  const updatedFrontmatter = updateFormulaBlockInText(
    frontmatterContent,
    { name: updateObject.name, platformSpecific: updateObject.platformSpecific, id: effectiveId },
    nl
  );

  return content.slice(0, bounds.start - ('---'.length + nl.length)) + '---' + nl + updatedFrontmatter + nl + '---' + nl + markdownContent;
}

function detectNewline(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function findFrontmatterBounds(content: string, nl: string): { has: boolean; start: number; end: number } {
  const startDelim = '---' + nl;
  if (!content.startsWith(startDelim)) {
    return { has: false, start: -1, end: -1 };
  }
  const endToken = nl + '---' + nl;
  const endIndex = content.indexOf(endToken, startDelim.length);
  if (endIndex === -1) {
    return { has: false, start: -1, end: -1 };
  }
  const start = startDelim.length; // index right after opening delimiter
  const end = endIndex; // index at the char before endToken
  return { has: true, start, end };
}

function buildNewFrontmatter(
  content: string,
  updateObject: { name?: string; platformSpecific?: boolean; id?: string },
  nl: string
): string {
  const formulaBlock = generateFormulaFrontmatterBlock(updateObject);
  const formulaYaml = formulaBlock ? `formula:${nl}${formulaBlock}` : 'formula:';
  return `---${nl}${GROUNDZERO_FORMULA_COMMENT}${nl}${formulaYaml}${nl}---${nl}${nl}${content}`;
}

function updateFormulaBlockInText(
  frontmatterContent: string,
  updateObject: { name?: string; platformSpecific?: boolean; id?: string },
  nl: string
): string {
  const lines = frontmatterContent.split(nl);
  const shouldUpdateName = typeof updateObject.name === 'string' && updateObject.name.length > 0;
  const shouldUpdatePlatform = updateObject.platformSpecific === true;
  const shouldUpdateId = typeof updateObject.id === 'string' && updateObject.id.length > 0;

  // Find formula line
  let formulaIndex = -1;
  let formulaIndent = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === 'formula:') {
      formulaIndex = i;
      formulaIndent = line.slice(0, line.indexOf('f'));
      break;
    }
  }

  // Ensure GroundZero formula comment exists above formula:
  if (formulaIndex !== -1) {
    const hasCommentAbove = formulaIndex > 0 && lines[formulaIndex - 1].trim() === GROUNDZERO_FORMULA_COMMENT;
    if (!hasCommentAbove) {
      lines.splice(formulaIndex, 0, GROUNDZERO_FORMULA_COMMENT);
      formulaIndex++; // Adjust index since we inserted a line
    }
  }

  const childIndent = formulaIndent + '  ';

  if (formulaIndex === -1) {
    // Append new formula block at the end of frontmatter
    const insert: string[] = [GROUNDZERO_FORMULA_COMMENT, 'formula:'];
    if (shouldUpdateName) insert.push(generateYamlKeyValue('name', updateObject.name, childIndent));
    if (shouldUpdatePlatform) insert.push(`${childIndent}platformSpecific: true`);
    // Ensure we keep original frontmatter content as-is and append
    const base = lines.join(nl).trimEnd();
    return (base.length ? base + nl : '') + insert.join(nl);
  }

  // Identify bounds of the formula block: contiguous lines starting with childIndent
  let blockStart = formulaIndex + 1;
  let blockEnd = blockStart;
  while (blockEnd < lines.length && lines[blockEnd].startsWith(childIndent)) {
    blockEnd++;
  }

  // Scan existing child lines for name/platform
  let nameFoundAt = -1;
  let platformFoundAt = -1;
  let idFoundAt = -1;
  for (let i = blockStart; i < blockEnd; i++) {
    const childLine = lines[i];
    const trimmed = childLine.trim();
    if (trimmed.startsWith('name:')) {
      nameFoundAt = i;
    } else if (trimmed.startsWith('platformSpecific:')) {
      platformFoundAt = i;
    } else if (trimmed.startsWith('id:')) {
      idFoundAt = i;
    }
  }

  // Apply updates in-place
  if (shouldUpdateName) {
    const nameLine = generateYamlKeyValue('name', updateObject.name, childIndent);
    if (nameFoundAt !== -1) {
      lines[nameFoundAt] = nameLine;
    } else {
      lines.splice(blockEnd, 0, nameLine);
      blockEnd++;
    }
  }

  if (shouldUpdatePlatform) {
    if (platformFoundAt !== -1) {
      lines[platformFoundAt] = `${childIndent}platformSpecific: true`;
    } else {
      lines.splice(blockEnd, 0, `${childIndent}platformSpecific: true`);
      blockEnd++;
    }
  }

  if (shouldUpdateId) {
    const idLine = generateYamlKeyValue('id', updateObject.id, childIndent);
    if (idFoundAt !== -1) {
      lines[idFoundAt] = idLine;
    } else {
      lines.splice(blockEnd, 0, idLine);
      blockEnd++;
    }
  }

  return lines.join(nl);
}

/**
 * Remove only formula-related frontmatter from markdown content,
 * preserving other frontmatter fields and the markdown body
 */
export function removeFormulaFrontmatter(content: string): string {
  const nl = detectNewline(content);
  const bounds = findFrontmatterBounds(content, nl);
  
  if (!bounds.has) {
    // No frontmatter to remove
    return content;
  }
  
  const frontmatterContent = content.slice(bounds.start, bounds.end);
  const markdownContentStart = bounds.end + (nl + '---' + nl).length;
  const markdownContent = content.slice(markdownContentStart);
  
  const lines = frontmatterContent.split(nl);
  
  // Find formula block
  let formulaIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === 'formula:') {
      formulaIndex = i;
      break;
    }
  }
  
  if (formulaIndex === -1) {
    // No formula block found
    return content;
  }
  
  // Find formula block bounds
  const formulaIndent = lines[formulaIndex].slice(0, lines[formulaIndex].indexOf('f'));
  const childIndent = formulaIndent + '  ';
  let blockStart = formulaIndex;
  let blockEnd = formulaIndex + 1;
  
  while (blockEnd < lines.length && lines[blockEnd].startsWith(childIndent)) {
    blockEnd++;
  }
  
  // Remove formula block
  lines.splice(blockStart, blockEnd - blockStart);
  
  // Remove any trailing empty lines or comments that were only for the formula block
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  
  // If no frontmatter remains, return just the markdown content
  if (lines.length === 0 || lines.every(line => line.trim() === '' || line.trim().startsWith('#'))) {
    return markdownContent;
  }
  
  // Reconstruct with remaining frontmatter
  const updatedFrontmatter = lines.join(nl);
  return '---' + nl + updatedFrontmatter + nl + '---' + nl + markdownContent;
}

/**
 * Extract non-formula frontmatter as a YAML string (preserving comments and ordering).
 * Returns an empty string if no non-formula frontmatter exists.
 */
export function extractNonFormulaFrontmatter(content: string): string {
  const nl = detectNewline(content);
  const bounds = findFrontmatterBounds(content, nl);
  if (!bounds.has) return '';

  const frontmatterContent = content.slice(bounds.start, bounds.end);
  const lines = frontmatterContent.split(nl);

  // Locate formula block
  let formulaIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === 'formula:') {
      formulaIndex = i;
      break;
    }
  }

  if (formulaIndex === -1) {
    // No formula block: entire frontmatter is non-formula
    return frontmatterContent.trimEnd();
  }

  const formulaIndent = lines[formulaIndex].slice(0, lines[formulaIndex].indexOf('f'));
  const childIndent = formulaIndent + '  ';

  // Identify formula block end (including child lines)
  let blockStart = formulaIndex;
  let blockEnd = formulaIndex + 1;
  while (blockEnd < lines.length && lines[blockEnd].startsWith(childIndent)) {
    blockEnd++;
  }

  // Remove the formula comment line directly above if present
  let removeCommentAt = -1;
  if (blockStart > 0 && lines[blockStart - 1].trim() === '# GroundZero formula') {
    removeCommentAt = blockStart - 1;
  }

  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === removeCommentAt) continue;
    if (i >= blockStart && i < blockEnd) continue; // skip formula block
    kept.push(lines[i]);
  }

  // Trim trailing blank lines
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();

  return kept.join(nl).trimEnd();
}

/**
 * Remove all non-formula frontmatter keys, keeping only the GroundZero comment and formula block.
 * If no frontmatter exists, returns the content unchanged.
 */
export function removeNonFormulaFrontmatter(content: string): string {
  const nl = detectNewline(content);
  const bounds = findFrontmatterBounds(content, nl);
  if (!bounds.has) return content;

  const frontmatterContent = content.slice(bounds.start, bounds.end);
  const markdownContentStart = bounds.end + (nl + '---' + nl).length;
  const markdownContent = content.slice(markdownContentStart);

  const lines = frontmatterContent.split(nl);

  // Find formula block
  let formulaIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'formula:') {
      formulaIndex = i;
      break;
    }
  }

  if (formulaIndex === -1) {
    // No formula block -> drop entire frontmatter
    return markdownContent;
  }

  const formulaIndent = lines[formulaIndex].slice(0, lines[formulaIndex].indexOf('f'));
  const childIndent = formulaIndent + '  ';

  // Identify formula block bounds
  let blockEnd = formulaIndex + 1;
  while (blockEnd < lines.length && lines[blockEnd].startsWith(childIndent)) {
    blockEnd++;
  }

  const kept: string[] = [];
  // Ensure comment is present above
  kept.push('# GroundZero formula');
  // Push formula block
  kept.push(lines[formulaIndex]);
  for (let i = formulaIndex + 1; i < blockEnd; i++) kept.push(lines[i]);

  const updatedFrontmatter = kept.join(nl);
  return '---' + nl + updatedFrontmatter + nl + '---' + nl + markdownContent;
}

/**
 * Merge platform non-formula YAML frontmatter with content containing only formula frontmatter.
 * The merged result places non-formula YAML first (preserving provided comments), then the
 * GroundZero formula comment and formula block.
 */
export function mergeFrontmatter(formulaOnlyContent: string, nonFormulaYaml: string): string {
  const nl = detectNewline(formulaOnlyContent);
  const bounds = findFrontmatterBounds(formulaOnlyContent, nl);

  // If no formula frontmatter, just prepend non-formula YAML as frontmatter
  if (!bounds.has) {
    const trimmed = (nonFormulaYaml || '').trim();
    if (!trimmed) return formulaOnlyContent;
    return '---' + nl + trimmed + nl + '---' + nl + formulaOnlyContent;
  }

  const frontmatterContent = formulaOnlyContent.slice(bounds.start, bounds.end);
  const markdownContentStart = bounds.end + (nl + '---' + nl).length;
  const markdownContent = formulaOnlyContent.slice(markdownContentStart);

  const fmLines = frontmatterContent.split(nl);
  // Extract the formula block and its optional comment
  let formulaIndex = -1;
  for (let i = 0; i < fmLines.length; i++) {
    if (fmLines[i].trim() === 'formula:') {
      formulaIndex = i;
      break;
    }
  }

  if (formulaIndex === -1) {
    // Unexpected (formula-only should contain formula), fallback to prepend non-formula
    const trimmed = (nonFormulaYaml || '').trim();
    if (!trimmed) return formulaOnlyContent;
    return '---' + nl + trimmed + nl + '---' + nl + formulaOnlyContent;
  }

  const formulaIndent = fmLines[formulaIndex].slice(0, fmLines[formulaIndex].indexOf('f'));
  const childIndent = formulaIndent + '  ';
  let blockEnd = formulaIndex + 1;
  while (blockEnd < fmLines.length && fmLines[blockEnd].startsWith(childIndent)) blockEnd++;

  // Determine if a comment exists above
  const hasComment = formulaIndex > 0 && fmLines[formulaIndex - 1].trim() === '# GroundZero formula';
  const formulaBlock: string[] = [];
  if (hasComment) formulaBlock.push('# GroundZero formula');
  formulaBlock.push(fmLines[formulaIndex]);
  for (let i = formulaIndex + 1; i < blockEnd; i++) formulaBlock.push(fmLines[i]);

  const nonFormula = (nonFormulaYaml || '').trim();
  const mergedFrontmatter = nonFormula
    ? nonFormula + nl + formulaBlock.join(nl)
    : formulaBlock.join(nl);

  return formulaOnlyContent.slice(0, bounds.start - ('---'.length + nl.length)) +
    '---' + nl + mergedFrontmatter + nl + '---' + nl + markdownContent;
}

