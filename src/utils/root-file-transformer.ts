/**
 * Root File Transformer Utility
 * Handles transformation of root file content for formula operations
 */

import { extractFormulaSection, buildOpenMarker, CLOSE_MARKER } from './root-file-extractor.js';

/**
 * Transform root file content for formula renaming
 * Updates formula name in markers
 *
 * @param content - The root file content
 * @param oldFormulaName - The original formula name in the marker
 * @param newFormulaName - The new formula name to use in the marker
 * @returns Updated content with new formula name
 */
export function transformRootFileContent(
  content: string,
  oldFormulaName: string,
  newFormulaName: string
): string {
  // Extract the current formula section
  const extracted = extractFormulaSection(content, oldFormulaName);
  if (!extracted) {
    // No valid marker found for the old formula name, return unchanged
    return content;
  }

  // Build new marker with updated name
  const newMarker = buildOpenMarker(newFormulaName);

  // Reconstruct the content with updated marker
  return newMarker + '\n' + extracted.sectionBody + '\n' + CLOSE_MARKER;
}
