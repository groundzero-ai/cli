import { generateEntityId, isValidEntityId } from './entity-id.js';
import { generateYamlKeyValue } from './yaml-frontmatter.js';
import type { FormulaMarkerYml } from './md-frontmatter.js';

export const GROUNDZERO_FORMULA_COMMENT = '# GroundZero formula' as const;

function detectNewline(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Update index.yml content to ensure GroundZero comment, formula name, and a valid formula.id.
 * Preserves all other lines and ordering.
 */
export function updateIndexYml(
  content: string,
  opts: { name?: string; ensureId?: boolean; resetId?: boolean } = {}
): { updated: boolean; content: string } {
  const nl = detectNewline(content);
  const lines = content.split(nl);

  // Find the first line that exactly contains 'formula:' (ignoring surrounding whitespace)
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

  if (formulaIndex === -1) {
    // No formula block; nothing to enforce for id without creating new structure
    return { updated: false, content };
  }

  const childIndent = formulaIndent + '  ';

  // Ensure comment directly above formula
  let updated = false;
  if (!(formulaIndex > 0 && lines[formulaIndex - 1].trim() === GROUNDZERO_FORMULA_COMMENT)) {
    lines.splice(formulaIndex, 0, GROUNDZERO_FORMULA_COMMENT);
    formulaIndex++;
    updated = true;
  }

  // Identify block bounds: contiguous childIndent lines after 'formula:'
  let blockStart = formulaIndex + 1;
  let blockEnd = blockStart;
  while (blockEnd < lines.length && lines[blockEnd].startsWith(childIndent)) {
    blockEnd++;
  }

  // Handle name update if provided
  if (opts.name !== undefined) {
    // Search for name line within the block
    let nameFoundAt = -1;
    for (let i = blockStart; i < blockEnd; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('name:')) {
        nameFoundAt = i;
        break;
      }
    }

    if (nameFoundAt !== -1) {
      const newLine = generateYamlKeyValue('name', opts.name, childIndent);
      if (lines[nameFoundAt] !== newLine) {
        lines[nameFoundAt] = newLine;
        updated = true;
      }
    } else {
      // Insert name line at the beginning of the block
      lines.splice(blockStart, 0, generateYamlKeyValue('name', opts.name, childIndent));
      blockEnd++; // Adjust block end since we added a line
      updated = true;
    }
  }

  // Search for id line within the block
  let idFoundAt = -1;
  let existingId: string | null = null;
  for (let i = blockStart; i < blockEnd; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('id:')) {
      idFoundAt = i;
      const after = trimmed.slice('id:'.length).trim();
      existingId = after.length ? after : null;
      break;
    }
  }

  const needReset = opts.resetId === true;
  const needEnsure = opts.ensureId === true;

  if (needReset || needEnsure) {
    let effectiveId: string | null = null;
    if (needReset) {
      effectiveId = generateEntityId();
    } else {
      effectiveId = existingId && isValidEntityId(existingId) ? existingId : generateEntityId();
    }

    if (idFoundAt !== -1) {
      const newLine = generateYamlKeyValue('id', effectiveId, childIndent);
      if (lines[idFoundAt] !== newLine) {
        lines[idFoundAt] = newLine;
        updated = true;
      }
    } else {
      lines.splice(blockEnd, 0, generateYamlKeyValue('id', effectiveId, childIndent));
      updated = true;
    }
  }

  if (!updated) return { updated: false, content };
  return { updated: true, content: lines.join(nl) };
}

/**
 * Generate complete index.yml content with GroundZero comment and formula block
 */
export function buildIndexYmlContent(marker: FormulaMarkerYml): string {
  const lines: string[] = [GROUNDZERO_FORMULA_COMMENT];

  if (marker.formula?.name) {
    lines.push('formula:');
    lines.push(generateYamlKeyValue('name', marker.formula.name, '  '));
    if (marker.formula.id) {
      lines.push(generateYamlKeyValue('id', marker.formula.id, '  '));
    }
    if (marker.formula.platformSpecific) {
      lines.push('  platformSpecific: true');
    }
  }

  return lines.join('\n');
}


