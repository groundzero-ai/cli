
/**
 * Utility for extracting and handling package-specific content markers
 * for root files (AGENTS.md, CLAUDE.md, etc.).
 *
 * Marker format:
 *   <!-- formula: <package-name> --> ... <!-- -->
 */

/**
 * Escape a string for safe insertion into a RegExp pattern.
 */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the literal open marker string for a formula */
export function buildOpenMarker(formulaName: string): string {
  return `<!-- formula: ${formulaName} -->`;
}

/** Constant close marker string */
export const CLOSE_MARKER = '<!-- -->';

/** Build a case-insensitive regex to match the open marker for a formula */
export function buildOpenMarkerRegex(formulaName: string): RegExp {
  const namePattern = escapeRegExp(formulaName);
  return new RegExp(`<!--\\s*formula:\\s*${namePattern}\\s*-->`, 'i');
}

/** Case-insensitive regex to match any formula open marker */
export const OPEN_MARKER_ANY_REGEX = /<!--\s*formula:\s*[^\s>]+?\s*-->/i;

/** Case-insensitive regex to match the close marker */
export const CLOSE_MARKER_REGEX = /<!--\s*-->/i;

/**
 * Global, non-greedy match between open/close markers, capturing formula name and body
 * Example: <!-- formula: name --> ... <!-- -->
 */
export const FORMULA_SECTION_GLOBAL_REGEX = /<!--\s*formula:\s*([^\s]+)\s*-->([\s\S]*?)<!--\s*-->/gi;

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
 * - Opening marker: <!-- formula: <formulaName> -->
 * - Closing marker: <!-- --> (optionally allowing internal whitespace)
 *
 * Returns null if no matching section is found.
 */
export function extractPackageContentFromRootFile(content: string, formulaName: string): string | null {
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
 * Extract the section body for a specific formula from marker-wrapped content.
 * Supports markers in the format:
 *   <!-- formula: <name> --> ... <!-- -->
 * Returns null if no section is found.
 */
export function extractPackageSection(
  content: string,
  formulaName: string
): { sectionBody: string } | null {
  if (!content || !formulaName) return null;

  const openRe = buildOpenMarkerRegex(formulaName);
  const closeRe = CLOSE_MARKER_REGEX;

  const openMatch = openRe.exec(content);
  if (!openMatch) return null;

  const startIndex = openMatch.index + openMatch[0].length;
  const rest = content.slice(startIndex);
  const closeMatch = closeRe.exec(rest);
  if (!closeMatch) return null;

  const sectionBody = rest.slice(0, closeMatch.index).trim();

  return { sectionBody };
}

/**
 * Extract all formula sections from a root file content.
 * Returns a map of formulaName → content.
 */
export function extractAllPackageSections(content: string): Map<string, string> {
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
