import matter from 'gray-matter';
import { generateEntityId, isValidEntityId } from './entity-id.js';

/**
 * Interface for markdown frontmatter
 */
export interface MarkdownFrontmatter {
  formula?: {
    name: string;
    platformSpecific?: boolean;
    id?: string;
  };
}

/**
 * Parse YAML frontmatter from markdown file content
 */
export function parseMarkdownFrontmatter(content: string): MarkdownFrontmatter | null {
  try {
    const parsed = matter(content);
    
    // If no frontmatter was found, return null
    if (!parsed.data || Object.keys(parsed.data).length === 0) {
      return null;
    }
    
    const frontmatter = parsed.data as MarkdownFrontmatter;
    
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
  const lines: string[] = [];
  if (typeof updateObject.name === 'string' && updateObject.name.length > 0) {
    lines.push(`  name: ${updateObject.name}`);
  }
  if (typeof updateObject.id === 'string' && updateObject.id.length > 0) {
    lines.push(`  id: ${updateObject.id}`);
  }
  if (updateObject.platformSpecific === true) {
    lines.push(`  platformSpecific: true`);
  }
  const formulaBlock = lines.length > 0 ? `formula:${nl}${lines.join(nl)}` : 'formula:';
  return `---${nl}# GroundZero formula${nl}${formulaBlock}${nl}---${nl}${nl}${content}`;
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

  // Ensure # GroundZero formula comment exists above formula:
  if (formulaIndex !== -1) {
    const hasCommentAbove = formulaIndex > 0 && lines[formulaIndex - 1].trim() === '# GroundZero formula';
    if (!hasCommentAbove) {
      lines.splice(formulaIndex, 0, '# GroundZero formula');
      formulaIndex++; // Adjust index since we inserted a line
    }
  }

  const childIndent = formulaIndent + '  ';

  if (formulaIndex === -1) {
    // Append new formula block at the end of frontmatter
    const insert: string[] = ['# GroundZero formula', 'formula:'];
    if (shouldUpdateName) insert.push(`${childIndent}name: ${updateObject.name}`);
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
    if (nameFoundAt !== -1) {
      lines[nameFoundAt] = `${childIndent}name: ${updateObject.name}`;
    } else {
      lines.splice(blockEnd, 0, `${childIndent}name: ${updateObject.name}`);
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
    if (idFoundAt !== -1) {
      lines[idFoundAt] = `${childIndent}id: ${updateObject.id}`;
    } else {
      lines.splice(blockEnd, 0, `${childIndent}id: ${updateObject.id}`);
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

