import { generateEntityId, isValidEntityId } from '../utils/entity-id.js';

/**
 * Utility for extracting and handling formula-specific content markers
 * for root files (AGENTS.md, CLAUDE.md, etc.).
 *
 * Marker format:
 *   <!-- formula: <formula-name> [id: <id>] --> ... <!-- -->
 */

/**
 * Escape a string for safe insertion into a RegExp pattern.
 */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the literal open marker string for a formula */
export function buildOpenMarker(formulaName: string, id?: string): string {
  return id ? `<!-- formula: ${formulaName} id: ${id} -->` : `<!-- formula: ${formulaName} -->`;
}

/** Constant close marker string */
export const CLOSE_MARKER = '<!-- -->';

/** Build a case-insensitive regex to match the open marker for a formula */
export function buildOpenMarkerRegex(formulaName: string): RegExp {
  const namePattern = escapeRegExp(formulaName);
  return new RegExp(`<!--\\s*formula:\\s*${namePattern}(?:\\s+id:\\s*([\\w\\-]{9}))?\\s*-->`, 'i');
}

/** Case-insensitive regex to match any formula open marker */
export const OPEN_MARKER_ANY_REGEX = /<!--\s*formula:\s*[^\s>]+(?:\s+id:\s*[\w\-]{9})?\s*-->/i;

/** Case-insensitive regex to match the close marker */
export const CLOSE_MARKER_REGEX = /<!--\s*-->/i;

/**
 * Global, non-greedy match between open/close markers, capturing formula name and body
 * Example: <!-- formula: name id: xxxxxxxxx --> ... <!-- -->
 */
export const FORMULA_SECTION_GLOBAL_REGEX = /<!--\s*formula:\s*([^\s]+)(?:\s+id:\s*[\w\-]{9})?\s*-->([\s\S]*?)<!--\s*-->/gi;

/**
 * Detect whether content includes a marker-wrapped section.
 * If formulaName is provided, ensures the open marker matches it.
 */
export function isMarkerWrappedContent(content: string, formulaName?: string): boolean {
  if (!content) return false;
  const hasClose = CLOSE_MARKER_REGEX.test(content);
  if (!hasClose) return false;
  if (formulaName) {
    return buildOpenMarkerRegex(formulaName).test(content);
  }
  return OPEN_MARKER_ANY_REGEX.test(content);
}

/**
 * Extract content for a specific formula from AGENTS.md content.
 *
 * - Opening marker: <!-- formula: <formulaName> [id: <id>] -->
 * - Closing marker: <!-- --> (optionally allowing internal whitespace)
 *
 * Returns null if no matching section is found.
 */
export function extractFormulaContentFromRootFile(content: string, formulaName: string): string | null {
  if (!content || !formulaName) return null;

  const openRe = buildOpenMarkerRegex(formulaName);
  const closeRe = CLOSE_MARKER_REGEX;

  const openMatch = openRe.exec(content);
  if (!openMatch) return null;

  const startIndex = openMatch.index + openMatch[0].length;
  const rest = content.slice(startIndex);
  const closeMatch = closeRe.exec(rest);
  if (!closeMatch) return null;

  const endIndexInRest = closeMatch.index; // relative to rest
  const extracted = rest.slice(0, endIndexInRest);
  return extracted.trim();
}

/**
 * Ensure the root marker for a specific formula has a valid id and extract its section body.
 * Supports markers in the format:
 *   <!-- formula: <name> -->
 *   <!-- formula: <name> id: <id> -->
 * Returns null if no section is found.
 */
export function ensureRootMarkerIdAndExtract(
  content: string,
  formulaName: string
): { id: string; updatedContent: string; sectionBody: string } | null {
  if (!content || !formulaName) return null;

  const openRe = buildOpenMarkerRegex(formulaName);
  const closeRe = CLOSE_MARKER_REGEX;

  const openMatch = openRe.exec(content);
  if (!openMatch) return null;

  const existingId = openMatch[1];
  const effectiveId = existingId && isValidEntityId(existingId) ? existingId : generateEntityId();

  // If we need to update the open marker to include id, do an in-place replacement
  let updatedContent = content;
  const desiredOpenMarker = buildOpenMarker(formulaName, effectiveId);
  const openMarkerText = openMatch[0];
  if (openMarkerText !== desiredOpenMarker) {
    const idx = openMatch.index;
    updatedContent = content.slice(0, idx) + desiredOpenMarker + content.slice(idx + openMarkerText.length);
  }

  // Recompute close match positions after potential update
  const startIndex = (openMatch.index + desiredOpenMarker.length);
  const rest = updatedContent.slice(startIndex);
  const closeMatch = closeRe.exec(rest);
  if (!closeMatch) return null;

  const sectionBody = rest.slice(0, closeMatch.index).trim();

  return { id: effectiveId, updatedContent, sectionBody };
}

/**
 * Extract all formula sections from a root file content.
 * Returns a map of formulaName → content.
 */
export function extractAllFormulaSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  
  if (!content) {
    return sections;
  }
  
  // Clone the global regex to avoid cross-call lastIndex interference
  const formulaPattern = new RegExp(FORMULA_SECTION_GLOBAL_REGEX);
  
  let match: RegExpExecArray | null;
  while ((match = formulaPattern.exec(content)) !== null) {
    const formulaName = match[1].trim();
    const sectionContent = match[2].trim();
    sections.set(formulaName, sectionContent);
  }
  
  return sections;
}
