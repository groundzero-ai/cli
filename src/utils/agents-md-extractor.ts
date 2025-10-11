/**
 * Utility for extracting formula-specific content from a root AGENTS.md file.
 * The expected markers are:
 *   <!-- formula: <formula-name> --><content><!-- -->
 * Only the content between the opening and closing markers is returned.
 */

/**
 * Escape a string for safe insertion into a RegExp pattern.
 */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract content for a specific formula from AGENTS.md content.
 *
 * - Opening marker: <!-- formula: <formulaName> -->
 * - Closing marker: <!-- --> (optionally allowing internal whitespace)
 *
 * Returns null if no matching section is found.
 */
export function extractFormulaContentFromAgentsMd(content: string, formulaName: string): string | null {
  if (!content || !formulaName) return null;

  const namePattern = escapeRegExp(formulaName);
  const openRe = new RegExp(`<!--\\s*formula:\\s*${namePattern}\\s*-->`, 'i');
  const closeRe = /<!--\s*-->/i;

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


