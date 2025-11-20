/**
 * Root File Transformer Utility
 * Handles transformation of root file content for formula operations
 */

import { extractPackageSection, buildOpenMarker, CLOSE_MARKER } from './root-file-extractor.js';

/**
 * Transform root file content for formula renaming
 * Updates formula name in markers
 *
 * @param content - The root file content
 * @param oldPackageName - The original formula name in the marker
 * @param newPackageName - The new formula name to use in the marker
 * @returns Updated content with new formula name
 */
export function transformRootFileContent(
  content: string,
  oldPackageName: string,
  newPackageName: string
): string {
  // Extract the current formula section
  const extracted = extractPackageSection(content, oldPackageName);
  if (!extracted) {
    // No valid marker found for the old formula name, return unchanged
    return content;
  }

  // Build new marker with updated name
  const newMarker = buildOpenMarker(newPackageName);

  // Reconstruct the content with updated marker
  return newMarker + '\n' + extracted.sectionBody + '\n' + CLOSE_MARKER;
}
