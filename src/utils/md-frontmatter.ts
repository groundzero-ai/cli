import matter from 'gray-matter';

/**
 * Interface for markdown frontmatter
 */
export interface MarkdownFrontmatter {
  formula?: {
    name: string;
    platformSpecific?: boolean;
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
    
    return parsed.data as MarkdownFrontmatter;
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
  formulaUpdate: { name?: string; platformSpecific?: boolean }
): string {
  const updateObject = formulaUpdate || {};
  const shouldUpdateName = typeof updateObject.name === 'string' && updateObject.name.length > 0;
  const shouldUpdatePlatform = updateObject.platformSpecific === true;

  if (!shouldUpdateName && !shouldUpdatePlatform) {
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

  const updatedFrontmatter = updateFormulaBlockInText(frontmatterContent, updateObject, nl);

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
  updateObject: { name?: string; platformSpecific?: boolean },
  nl: string
): string {
  const lines: string[] = [];
  if (typeof updateObject.name === 'string' && updateObject.name.length > 0) {
    lines.push(`  name: ${updateObject.name}`);
  }
  if (updateObject.platformSpecific === true) {
    lines.push(`  platformSpecific: true`);
  }
  const formulaBlock = lines.length > 0 ? `formula:${nl}${lines.join(nl)}` : 'formula:';
  return `---${nl}# GroundZero formula${nl}${formulaBlock}${nl}---${nl}${nl}${content}`;
}

function updateFormulaBlockInText(
  frontmatterContent: string,
  updateObject: { name?: string; platformSpecific?: boolean },
  nl: string
): string {
  const lines = frontmatterContent.split(nl);
  const shouldUpdateName = typeof updateObject.name === 'string' && updateObject.name.length > 0;
  const shouldUpdatePlatform = updateObject.platformSpecific === true;

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

  const childIndent = formulaIndent + '  ';

  if (formulaIndex === -1) {
    // Append new formula block at the end of frontmatter
    const insert: string[] = ['formula:'];
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
  for (let i = blockStart; i < blockEnd; i++) {
    const childLine = lines[i];
    const trimmed = childLine.trim();
    if (trimmed.startsWith('name:')) {
      nameFoundAt = i;
    } else if (trimmed.startsWith('platformSpecific:')) {
      platformFoundAt = i;
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

  return lines.join(nl);
}
