/**
 * Root File Transformer Utility
 * Handles transformation of root file content for formula operations
 */

import { ensureRootMarkerIdAndExtract, buildOpenMarker, CLOSE_MARKER } from './root-file-extractor.js';
import { generateEntityId } from './entity-id.js';

/**
 * Transform root file content for formula duplication or renaming
 * Updates formula name and generates new ID in markers
 *
 * @param content - The root file content
 * @param oldFormulaName - The original formula name in the marker
 * @param newFormulaName - The new formula name to use in the marker
 * @returns Updated content with new formula name and generated ID
 */
export function transformRootFileContent(
  content: string,
  oldFormulaName: string,
  newFormulaName: string
): string {
  // Extract the current formula section with existing ID handling
  const ensured = ensureRootMarkerIdAndExtract(content, oldFormulaName);
  if (!ensured) {
    // No valid marker found for the old formula name, return unchanged
    return content;
  }

  // Generate new ID for the duplicated/renamed formula
  const newId = generateEntityId();

  // Build new marker with updated name and new ID
  const newMarker = buildOpenMarker(newFormulaName, newId);

  // Reconstruct the content with updated marker
  return newMarker + '\n' + ensured.sectionBody + '\n' + CLOSE_MARKER;
}
