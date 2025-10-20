import { generateEntityId, isValidEntityId } from './entity-id.js';

export const GROUNDZERO_FORMULA_COMMENT = '# GroundZero formula' as const;

function detectNewline(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Update index.yml content to ensure GroundZero comment and a valid formula.id.
 * Preserves all other lines and ordering.
 */
export function updateIndexYml(
  content: string,
  opts: { ensureId?: boolean; resetId?: boolean } = {}
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
      const newLine = `${childIndent}id: ${effectiveId}`;
      if (lines[idFoundAt] !== newLine) {
        lines[idFoundAt] = newLine;
        updated = true;
      }
    } else {
      lines.splice(blockEnd, 0, `${childIndent}id: ${effectiveId}`);
      updated = true;
    }
  }

  if (!updated) return { updated: false, content };
  return { updated: true, content: lines.join(nl) };
}


